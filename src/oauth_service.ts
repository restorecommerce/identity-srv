import { Logger } from 'winston';
import { OAuth2 } from 'oauth';
import { UserService } from './service.js';
import * as _ from 'lodash-es';
import * as uuid from 'uuid';
import * as jose from 'jose';
import {
  DeepPartial,
  ExchangeCodeRequest,
  ExchangeCodeResponse,
  GenerateLinksResponse,
  OAuthServiceImplementation,
  ServicesResponse,
  GetTokenResponse,
  GetTokenRequest,
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/oauth.js';
import { Empty } from '@restorecommerce/rc-grpc-clients/dist/generated/google/protobuf/empty.js';
import { WithRequestID } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc/middlewares.js';
import { FindByTokenRequest } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import {
  Filter_Operation,
  ReadRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import fetch from 'node-fetch';

export const accountResolvers: { [key: string]: (access_token: string) => Promise<string> } = {
  google: async access_token => {
    const response: any = await fetch(
      'https://www.googleapis.com/oauth2/v1/userinfo',
      {
        headers: {
          Authorization: 'Bearer ' + access_token
        }
      }
    ).then(
      response => response.json()
    );
    return response.email;
  }
};

export class OAuthService implements OAuthServiceImplementation<WithRequestID> {

  logger: Logger;
  cfg: any;
  clients: { [key: string]: OAuth2 };
  userService: UserService;

  constructor(cfg: any, logger: any, userService: UserService) {
    this.logger = logger;
    this.cfg = cfg;
    this.clients = {};
    this.userService = userService;

    const services = cfg.get('oauth:services');
    if (services) {
      Object.keys(services).forEach(key => {
        if (!(key in accountResolvers)) {
          throw new Error('Unknown oauth service: ' + key);
        }

        const service = services[key];
        this.clients[key] = new OAuth2(
          service.client_id,
          service.client_secret,
          service.base_site,
          service.authorize_path,
          service.access_token_path
        );
      });
    }
  }

  async availableServices(request: Empty, context: any): Promise<DeepPartial<ServicesResponse>> {
    return {
      services: Object.keys(this.clients)
    };
  }

  async generateLinks(request: Empty, context: any): Promise<DeepPartial<GenerateLinksResponse>> {
    const nonce = 'nonce'; // TODO Generate, store and compare unique nonce
    return {
      links: Object.assign({},
        ...Object.entries(this.clients).map(([key, value]) => ({
          key: value.getAuthorizeUrl({
            redirect_uri: this.cfg.get('oauth:redirect_uri_base') + key,
            scope: this.cfg.get('oauth:services:' + key + ':scope'),
            response_type: 'code',
            state: nonce,
            prompt: 'consent',
            access_type: 'offline'
          })
        })
      ))
    };
  }

  async exchangeCode(request: ExchangeCodeRequest, context: any): Promise<DeepPartial<ExchangeCodeResponse>> {
    try {
      const oauthService = request.service;
      if (!(oauthService in this.clients)) {
        throw new Error('Unknown service: ' + oauthService);
      }

      const data: any = await new Promise(
        (resolve, reject) => this.clients[oauthService].getOAuthAccessToken(
          request.code,
          {
            grant_type: 'authorization_code',
            redirect_uri: this.cfg.get('oauth:redirect_uri_base') + oauthService,
          },
          (err, access_token, refresh_token, result) => {
            if (err) {
              this.logger.error('Oauth failed:', { err });
              reject(err);
              return;
            }

            resolve({
              access_token,
              refresh_token,
              result
            });
          }
        )
      );

      const email = await accountResolvers[oauthService](data.access_token);
      const user = await this.userService.superRead(ReadRequest.fromPartial({
        filters: [
          {
            filters: [
              {
                field: 'email',
                operation: Filter_Operation.eq,
                value: email
              }
            ]
          }
        ],
        limit: 1
      }), context).then(
        response => response?.items?.[0]?.payload
      );

      if (!user) {
        throw {
          code: 404,
          message: `No user found for ${email}`,
        };
      }

      const resultTokens = (user.tokens || []).filter(
        t => t.name === oauthService + '-access_token'
          || t.name === oauthService + '-refresh_token'
      );

      delete user.tokens;
      delete user.password_hash;
      delete user.data;

      const token = new jose.UnsecuredJWT({
        user
      }).setIssuedAt()
        .setExpirationTime((Date.now() / 1000) + (60 * 60 * 24 * 30 * 6))
        .encode();

      const authToken: any = {
        name: uuid.v4().replace(/-/g, ''),
        expires_in: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30 * 6), // 6 months
        token,
        type: 'access_token',
        interactive: true,
        last_login: new Date()
      };

      const accessToken = {
        name: oauthService + '-access_token',
        expires_in: new Date(Date.now() + data.result.expires_in * 1000),
        token: data.access_token,
        type: 'access_token',
        interactive: true,
        last_login: new Date()
      };

      const refreshToken = {
        name: oauthService + '-refresh_token',
        expires_in: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30 * 6), // 6 months
        token: data.refresh_token,
        type: 'refresh_token',
        interactive: true,
        last_login: new Date()
      };

      // append access token on user entity
      // remove expired tokens
      await this.userService.updateUserTokens(user.id, accessToken, resultTokens.filter(t => {
        return t?.expires_in.getTime() < Date.now();
      }));
      // append refresh token on user entity
      // remove all previous refresh tokens
      await this.userService.updateUserTokens(user.id, refreshToken, resultTokens.filter(t => {
        return t?.expires_in.getTime() > Date.now() && t?.name === oauthService + '-refresh_token';
      }));
      // append auth token on user entity
      await this.userService.updateUserTokens(user.id, authToken);
      this.logger.info('Token updated successfully on user entity', { id: user.id });

      authToken.expires_in = new Date(authToken.expires_in);
      return {
        email,
        user: {
          payload: user,
          status: {
            code: 200,
            message: 'success'
          }
        },
        token: authToken
      };
    } catch (err: any) {
      this.logger.error('Error on token exchange', err);
      return {
        user: {
          status: {
            code: err.code,
            message: err.message
          }
        }
      };
    }
  }

  async getToken(request: GetTokenRequest, context: any): Promise<DeepPartial<GetTokenResponse>> {
    try {
      const oauthService = request.service;
      if (!(oauthService in this.clients)) {
        throw new Error('Unknown service: ' + oauthService);
      }

      const user = await this.userService.findByToken(
        FindByTokenRequest.fromPartial(
          {
            token: request.subject.token
          }
        ),
        context
      );

      if (!user?.payload?.tokens) {
        return {
          status: {
            code: 404,
            message: 'user not found'
          }
        };
      }

      const tokens = user?.payload?.tokens?.filter((t: any) => t?.name?.startsWith(oauthService + '-'));
      if (tokens.length < 2) {
        if (tokens.length > 0) {
          return {
            token: tokens[0].token
          };
        } else {
          return {
            status: {
              code: 404,
              message: 'user has no token for this service'
            }
          };
        }
      }

      const toRemove = tokens.filter(
        t => t.expires_in.getTime() < Date.now()
      );

      await this.userService.removeToken(
        user.payload.id,
        toRemove
      ).catch(
        err => this.logger.warn(
          'Failed to remove expired tokens',
          { err, toRemove }
        )
      );

      const validAccessToken = tokens.find(
        t => t.name.endsWith('access_token')
          && t.expires_in.getTime() >= Date.now()
      );

      if (validAccessToken) {
        return {
          token: validAccessToken.token
        };
      }

      const validRefreshToken = tokens.find(
        t => t.name.endsWith('refresh_token')
          && t.expires_in.getTime() >= Date.now()
      );

      const data: any = validRefreshToken && await new Promise(
        (resolve, reject) => this.clients[oauthService].getOAuthAccessToken(
          validRefreshToken.token,
          {
            grant_type: 'refresh_token'
          },
          (err, access_token, refresh_token, result) => {
            if (err) {
              this.logger.error('Error Refreshing Token', err);
              reject(err);
              return;
            }

            resolve({
              access_token,
              refresh_token,
              result
            });
          }
        )
      );

      if (!data) {
        return {status: {code: 400, message: 'refresh token has expired'}};
      }

      const newAccessToken = {
        name: oauthService + '-access_token',
        expires_in: new Date(Date.now() + data.result.expires_in * 1000),
        token: data.access_token,
        type: 'access_token',
        interactive: true,
        last_login: new Date()
      };

      // append access token on user entity
      await this.userService.updateUserTokens(user.payload.id, newAccessToken);
      this.logger.info('Token updated successfully on user entity', {id: user.payload.id});
      return { token: newAccessToken.token };
    } catch (err: any) {
      this.logger.error('Error Updating Token', err);
      return {
        status: {
          code: err.code,
          message: err.message
        }
      };
    }
  }
}
