import { Logger } from 'winston';
import { OAuth2 } from 'oauth';
import { checkAccessRequest, fetch } from './utils';
import { UserService } from './service';
import { AuthZAction, Operation } from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import * as uuid from 'uuid';
import * as jose from 'jose';
import {
  DeepPartial,
  ExchangeCodeResponse,
  GenerateLinksResponse,
  OAuthServiceImplementation,
  ServicesResponse
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/oauth';
import { Empty } from '@restorecommerce/rc-grpc-clients/dist/generated/google/protobuf/empty';
import { WithRequestID } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc/middlewares';
import { createMetadata } from './common';
import { FindByTokenRequest } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import {
  Filter_Operation,
  ReadRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';

export const accountResolvers: { [key: string]: (access_token: string) => Promise<string> } = {
  google: async access_token => {
    const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
      headers: {
        Authorization: 'Bearer ' + access_token
      }
    }).then(response => response.json());
    return response['email'];
  }
};

interface ExchangeCodeRequest {
  service: string;
  code: string;
  state: string;
}

interface GetTokenRequest {
  subject: any;
  service: string;
}

interface GetTokenResponse {
  status?: {
    code: number;
    message: string;
  };
  token?: string;
}

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

  async availableServices(request: Empty, context): Promise<DeepPartial<ServicesResponse>> {
    return {
      services: Object.keys(this.clients)
    };
  }

  async generateLinks(request: Empty, context): Promise<DeepPartial<GenerateLinksResponse>> {
    const nonce = 'nonce'; // TODO Generate, store and compare unique nonce
    return {
      links: Object.entries(this.clients).reduce((result, entry) => {
        result[entry[0]] = entry[1].getAuthorizeUrl({
          redirect_uri: this.cfg.get('oauth:redirect_uri_base') + entry[0],
          scope: this.cfg.get('oauth:services:' + entry[0] + ':scope'),
          response_type: 'code',
          state: nonce,
          prompt: 'consent',
          access_type: 'offline'
        });
        return result;
      }, {})
    };
  }

  async exchangeCode(request: ExchangeCodeRequest, context): Promise<DeepPartial<ExchangeCodeResponse>> {
    const oauthService = request.service;
    if (!(oauthService in this.clients)) {
      throw new Error('Unknown service: ' + oauthService);
    }

    const data: any = await new Promise((resolve, reject) => this.clients[oauthService].getOAuthAccessToken(request.code, {
      grant_type: 'authorization_code',
      redirect_uri: this.cfg.get('oauth:redirect_uri_base') + oauthService,
    }, (err, access_token, refresh_token, result) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        access_token,
        refresh_token,
        result
      });
    })).catch(err => {
      console.error(err);
      throw err;
    });

    const email = await accountResolvers[oauthService](data['access_token']);

    const users = await this.userService.superRead(ReadRequest.fromPartial({
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
      ]
    }), context);

    if (users.total_count === 0) {
      return { email };
    }

    const user = users.items[0].payload;

    let tokenTechUser: any = {};
    const techUsersCfg = this.cfg.get('techUsers');
    if (techUsersCfg && techUsersCfg.length > 0) {
      tokenTechUser = _.find(techUsersCfg, { id: 'upsert_user_tokens' });
    }
    tokenTechUser.scope = user.default_scope;

    const resultTokens = (user.tokens || []).filter(t => {
      return t.name === oauthService + '-access_token' || t.name === oauthService + '-refresh_token';
    });

    try {
      const acsResponse = await checkAccessRequest(
        {
          ...context,
          subject: tokenTechUser,
          resources: await createMetadata(request, this.cfg.get('authorization:urns'), this.userService, tokenTechUser)
        },
        [{ resource: 'token', id: context.id }], AuthZAction.MODIFY, Operation.isAllowed
      );

      if (acsResponse.decision != Response_Decision.PERMIT) {
        return {
          user: {
            status: {
              code: acsResponse.operation_status.code,
              message: acsResponse.operation_status.message
            }
          }
        };
      }
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for token upsert', err);
      return { user: { status: { code: err.code, message: err.message } } };
    }

    const userCopy = {
      ...user
    };

    delete userCopy['tokens'];
    delete userCopy['password_hash'];
    delete userCopy['data'];

    const token = new jose.UnsecuredJWT({
      user: userCopy
    }).setIssuedAt()
      .setExpirationTime((Date.now() / 1000) + (60 * 60 * 24 * 30 * 6))
      .encode();

    const authToken = {
      name: uuid.v4().replace(/-/g, ''),
      expires_in: Date.now() + (1000 * 60 * 60 * 24 * 30 * 6), // 6 months
      token,
      type: 'access_token',
      interactive: true,
      last_login: Date.now()
    };

    const accessToken = {
      name: oauthService + '-access_token',
      expires_in: Date.now() + (data['result']['expires_in'] * 1000),
      token: data['access_token'],
      type: 'access_token',
      interactive: true,
      last_login: Date.now()
    };

    const refreshToken = {
      name: oauthService + '-refresh_token',
      expires_in: Date.now() + (1000 * 60 * 60 * 24 * 30 * 6), // 6 months
      token: data['refresh_token'],
      type: 'refresh_token',
      interactive: true,
      last_login: Date.now()
    };

    try {
      // append access token on user entity
      // remove expired tokens
      await this.userService.updateUserTokens(user.id, accessToken, resultTokens.filter(t => {
        return t.expires_in < Date.now();
      }));
      // append refresh token on user entity
      // remove all previous refresh tokens
      await this.userService.updateUserTokens(user.id, refreshToken, resultTokens.filter(t => {
        return t.expires_in > Date.now() && t.name === oauthService + '-refresh_token';
      }));
      // append auth token on user entity
      await this.userService.updateUserTokens(user.id, authToken);
      this.logger.info('Token updated successfully on user entity', { id: user.id });
    } catch (err) {
      this.logger.error('Error Updating Token', err);
      return { user: { status: { code: err.code, message: err.message } } };
    }

    return { email, user: { payload: user, status: { code: 200, message: 'success' } }, token: authToken };
  }

  async getToken(request: GetTokenRequest, context): Promise<DeepPartial<GetTokenResponse>> {
    const oauthService = request.service;
    if (!(oauthService in this.clients)) {
      throw new Error('Unknown service: ' + oauthService);
    }

    const user = await this.userService.findByToken(FindByTokenRequest.fromPartial({token: request.subject.token}), context);
    if (!user || !user.payload || !user.payload.tokens) {
      return {status: {code: 404, message: 'user not found'}};
    }

    const tokens = user?.payload?.tokens?.filter((t: any) => t?.name?.startsWith(oauthService + '-'));
    if (tokens.length < 2) {
      if (tokens.length > 0) {
        return {token: tokens[0].token};
      } else {
        return {status: {code: 404, message: 'user has no token for this service'}};
      }
    }

    const toRemove = [];

    const accessTokens: any[] = tokens.filter(t => t.name.endsWith('access_token'));
    for (let accessToken of accessTokens) {
      if (accessToken.expires_in > Date.now()) {
        return {token: accessToken.token};
      }

      toRemove.push(accessToken);
    }

    const refreshTokens: any[] = tokens.filter(t => t.name.endsWith('refresh_token'));

    let data;
    for (const refreshToken of refreshTokens) {
      if (refreshToken.expires_in < Date.now()) {
        toRemove.push(refreshToken);
        continue;
      }

      data = await new Promise((resolve) => this.clients[oauthService].getOAuthAccessToken(refreshToken.token, {
        grant_type: 'refresh_token'
      }, (err, access_token, refresh_token, result) => {
        if (err) {
          this.logger.error('Error Refreshing Token', err);
          resolve(undefined);
          return;
        }

        resolve({
          access_token,
          refresh_token,
          result
        });
      }));

      if (data) {
        break;
      } else {
        toRemove.push(refreshToken);
      }
    }

    if (!data) {
      return {status: {code: 400, message: 'refresh token has expired'}};
    }

    const newAccessToken = {
      name: oauthService + '-access_token',
      expires_in: Date.now() + (data['result']['expires_in'] * 1000),
      token: data['access_token'],
      type: 'access_token',
      interactive: true,
      last_login: Date.now()
    };

    try {
      // append access token on user entity
      await this.userService.updateUserTokens(user.payload.id, newAccessToken, toRemove);
      this.logger.info('Token updated successfully on user entity', {id: user.payload.id});
    } catch (err) {
      this.logger.error('Error Updating Token', err);
      return {status: {code: err.code, message: err.message}};
    }

    return { token: newAccessToken.token };
  }

}
