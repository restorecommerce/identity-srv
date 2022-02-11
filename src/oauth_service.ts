import { Logger } from 'winston';
import { OAuth2 } from 'oauth';
import { Call, User } from './interface';
import fetch from 'node-fetch';
import { UserService } from './service';
import { FilterOperation } from '@restorecommerce/resource-base-interface';
import { returnStatus } from './utils';
import * as _ from 'lodash';

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
          scope: 'email',
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
    if (!(call.request.service in this.clients)) {
      throw new Error('Unknown service: ' + call.request.service);
    }

    const data: any = await new Promise((resolve, reject) => this.clients[call.request.service].getOAuthAccessToken(call.request.code, {
      grant_type: 'authorization_code',
      redirect_uri: this.cfg.get('oauth:redirect_uri_base') + call.request.service,
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

    const email = await accountResolvers[call.request.service](data['access_token']);

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
      return {email};
    }

    const user = users.items[0].payload;

    let tokenTechUser: any = {};
    const techUsersCfg = this.cfg.get('techUsers');
    if (techUsersCfg && techUsersCfg.length > 0) {
      tokenTechUser = _.find(techUsersCfg, {id: 'upsert_user_tokens'});
    }
    tokenTechUser.scope = user.default_scope;

    const resultTokens = (user.tokens || []).filter(t => {
      return t.name !== call.request.service + '-access_token' && t.name !== call.request.service + '-refresh_token';
    });

    resultTokens.push({
      name: call.request.service + '-access_token',
      expires_in: Date.now() + (data['result']['expires_in'] * 1000),
      token: data['access_token'],
      type: 'access_token',
      interactive: true,
      last_login: Date.now()
    });

    resultTokens.push({
      name: call.request.service + '-refresh_token',
      expires_in: Date.now() + (1000 * 60 * 60 * 24 * 30 * 6), // 6 months
      token: data['refresh_token'],
      type: 'refresh_token',
      interactive: true,
      last_login: Date.now()
    });

    // remove expired tokens
    const updatedTokens = (resultTokens).filter(t => {
      return t.expires_in > Date.now();
    });
    user.tokens = updatedTokens;

    await this.userService.update({request: {items: [user], subject: tokenTechUser}}, {});

    return {email, user: {payload: user, status: {code: 200, message: 'success'}}};
  }

}
