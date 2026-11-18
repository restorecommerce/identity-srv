import { Logger } from '@restorecommerce/logger';
import { OAuth2 } from 'oauth';
import { UserService } from './service.js';
import * as _ from 'lodash-es';
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
  FilterOp_Operator,
  ReadRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { randomUUID } from 'crypto';
import { ServiceConfig } from '@restorecommerce/service-config';

export class OAuthService implements OAuthServiceImplementation<WithRequestID> {
  readonly accountResolvers: Record<string, (access_token: string) => Promise<{ id?: string, email?: string }>> = {
    google: async access_token => {
      const response: any = await fetch(
        this.cfg.get('oauth:services:google') ?? 'https://www.googleapis.com/oauth2/v1/userinfo',
        {
          headers: {
            Authorization: 'Bearer ' + access_token
          }
        }
      ).then(
        response => response.json()
      );
      return response;
    }
  };

  constructor(
    private readonly cfg: ServiceConfig,
    private readonly logger: Logger,
    private readonly userService: UserService,
    private readonly clients: Record<string, OAuth2> = {},
  ) {
    const services = cfg.get('oauth:services');
    this.clients ??= {};
    if (services) {
      Object.keys(services).forEach(key => {
        if (!(key in this.accountResolvers)) {
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
          [key]: value.getAuthorizeUrl({
            redirect_uri: this.cfg.get('oauth:redirect_uri_base') + key,
            scope: this.cfg.get(`oauth:services:${key}:scope`),
            response_type: 'code',
            state: nonce,
            prompt: 'consent',
            access_type: 'offline'
          })
        }))
      )
    };
  }

  async exchangeCode(request: ExchangeCodeRequest, context: any): Promise<DeepPartial<ExchangeCodeResponse>> {
    try {
      const oauthService = request.service;
      const propertyUrn = this.cfg.get(`oauth:${oauthService}:property`);
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

      const resp = await this.accountResolvers[oauthService](data.access_token);
      const users = await this.userService.superRead(ReadRequest.fromPartial({
        filters: [
          {
            filters: [
              {
                field: 'email',
                operation: Filter_Operation.eq,
                value: resp.email,
              },
              ...(propertyUrn ? [{
                filters: [
                  {
                    filters: [
                      {
                        field: 'properties[*].id',
                        operation: Filter_Operation.in,
                        value: propertyUrn
                      },
                      {
                        field: 'properties[*].value',
                        operation: Filter_Operation.in,
                        value: resp.id
                      }
                    ],
                    operator: FilterOp_Operator.and
                  }
                ],
              }] : [])
            ],
            operator: FilterOp_Operator.or,
          }
        ],
        limit: 2
      }), context).then(
        response => response?.items
      );

      // You shell not return 404 Not Found, telling attackers that an account does not exists!
      // You shell not return 409 Conflict, telling attackers that another account with this configuration exists!
      // You shell always return 401 Unauthorized, leaving uncertainty!
      // But we can log it:
      if (users.length == 0) {
        this.logger?.debug('OAuth.exchangeCode(): No user found:', resp); // this is no error!
      }
      else if (users.length > 1) {
        this.logger?.error('OAuth.exchangeCode(): User identifier ambigous:', resp); // something's fishy!
      }

      if (users.length !== 1) {
        throw {
          code: 401,
          message: `Unauthorized for ${resp.email}`,
        };
      }

      const user = users[0].payload;
      const resultTokens = (user.tokens || []).filter(
        t => t.name === oauthService + '-access_token'
          || t.name === oauthService + '-refresh_token'
      );

      delete user.tokens;
      delete user.password_hash;

      const token = new jose.UnsecuredJWT({
        user
      }).setIssuedAt()
        .setExpirationTime((Date.now() / 1000) + (60 * 60 * 24 * 30 * 6))
        .encode();

      const authToken: any = {
        name: randomUUID().replace(/-/g, ''),
        expires_in: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30 * 6), // 6 months
        token,
        type: 'access_token',
        interactive: true,
        last_use: new Date(),
        creeated_at: new Date()
      };

      const accessToken = {
        name: oauthService + '-access_token',
        expires_in: new Date(Date.now() + data.result.expires_in * 1000),
        token: data.access_token,
        type: 'access_token',
        interactive: true,
        last_use: new Date(),
        creeated_at: new Date()
      };

      const refreshToken = {
        name: oauthService + '-refresh_token',
        expires_in: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30 * 6), // 6 months
        token: data.refresh_token,
        type: 'refresh_token',
        interactive: true,
        last_use: new Date(),
        creeated_at: new Date()
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
      this.logger.info('Token updated on user entity', { id: user.id });
      // Add identifier property if any
      if (propertyUrn) {
        this.logger.debug('Append identification property');
        user.properties ??= [];
        user.properties.push({
          id: propertyUrn,
          value: resp.id,
        });
        await this.userService.superUpdate(
          {
            items: [{
              properties: _.uniqWith(user.properties, _.isEqual)
            }]
          }, {}
        );
      }

      authToken.expires_in = new Date(authToken.expires_in);
      return {
        email: resp.email,
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
        this.logger.debug('OAuth.getToken(): No user found!'); // don't tell attackers!
        return {
          status: {
            code: 401,
            message: 'Unauthorized!'
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
          this.logger.debug('OAuth.getToken(): User has no token for this service!'); // don't tell attackers!
          return {
            status: {
              code: 401,
              message: 'Unauthorized!'
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
        last_use: new Date(),
        creeated_at: new Date()
      };

      // append access token on user entity
      await this.userService.updateUserTokens(user.payload.id, newAccessToken);
      this.logger.info('Token updated on user entity', {id: user.payload.id});
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
