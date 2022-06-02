import { Logger } from 'winston';
import { OAuth2 } from 'oauth';
import { Call } from './interface';
import { fetch } from './utils';
import { UserService } from './service';
import { FilterOperation } from '@restorecommerce/resource-base-interface';
import { AuthZAction, Decision, Subject, DecisionResponse, Operation } from '@restorecommerce/acs-client';
import { checkAccessRequest } from './utils';
import * as _ from 'lodash';
import * as uuid from 'uuid';
import * as jose from 'jose';

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

export class OAuthService {

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

  async availableServices(call: any, context: any): Promise<any> {
    return {
      services: Object.keys(this.clients)
    };
  }

  async generateLinks(call: any, context: any): Promise<any> {
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

  async exchangeCode(call: Call<ExchangeCodeRequest>, context: any): Promise<any> {
    const oauthService = call.request.service;
    if (!(oauthService in this.clients)) {
      throw new Error('Unknown service: ' + oauthService);
    }

    const data: any = await new Promise((resolve, reject) => this.clients[oauthService].getOAuthAccessToken(call.request.code, {
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

    const users = await this.userService.superRead({
      request: {
        filters: [
          {
            filter: [
              {
                field: 'email',
                operation: FilterOperation.eq,
                value: email
              }
            ]
          }
        ]
      }
    });

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

    if (!(call.request as any).id) {
      (call.request as any).id = uuid.v4().replace(/-/g, '');
    }
    let acsResponse: DecisionResponse;
    let tokenData = call.request;
    try {
      if (!context) { context = {}; };
      call.request = await this.createMetadata(tokenData, tokenTechUser);
      context.subject = tokenTechUser;
      context.resources = call.request;
      acsResponse = await checkAccessRequest(context, [{ resource: 'token', id: (call.request as any).id }], AuthZAction.MODIFY,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for token upsert', err);
      return { user: { status: { code: err.code, message: err.message } } };
    }

    if (acsResponse.decision != Decision.PERMIT) {
      const response = { status: { code: acsResponse.operation_status.code, message: acsResponse.operation_status.message } };
      return { user: { response } };
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

  /**
   * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
   */
  async createMetadata(res: any, subject?: Subject): Promise<any> {
    let resources = _.cloneDeep(res);
    let orgOwnerAttributes = [];
    if (!_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    for (let resource of resources) {
      if (!resource.meta) {
        resource.meta = {};
      }
      if (subject && subject.id) {
        orgOwnerAttributes.push(
          {
            id: urns.ownerIndicatoryEntity,
            value: urns.user
          },
          {
            id: urns.ownerInstance,
            value: subject.id
          });
      } else if (subject && subject.token) {
        // when no subjectID is provided find the subjectID using findByToken
        const user = await this.userService.findByToken({ request: { token: subject.token } }, {});
        if (user && user.payload && user.payload.id) {
          orgOwnerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user
            },
            {
              id: urns.ownerInstance,
              value: user.payload.id
            });
        }
      }
      resource.meta.owner = orgOwnerAttributes;
    }
    return resources;
  }

  async getToken(call: Call<GetTokenRequest>, context: any): Promise<GetTokenResponse> {
    const oauthService = call.request.service;
    if (!(oauthService in this.clients)) {
      throw new Error('Unknown service: ' + oauthService);
    }

    const user = await this.userService.findByToken({request: {token: call.request.subject.token}}, {});
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
