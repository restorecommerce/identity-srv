import * as _ from 'lodash-es';
import * as jose from 'jose';
import * as openid from 'openid-client';
import { Logger } from '@restorecommerce/logger';
import { UserService } from './service.js';
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
        this.cfg.get('oauth:services:google:api_path') ?? 'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            Authorization: 'Bearer ' + access_token
          }
        }
      ).then(
        response => response.json(),
        err => this.logger?.error('Oauth resolver setup failed:', err)
      );
      return response;
    }
  };

  protected constructor(
    private readonly cfg: ServiceConfig,
    private readonly userService: UserService,
    private readonly logger?: Logger,
    private readonly clients = new Map<string, openid.Configuration>(),
  ) {}

  protected async init() {
    const services = this.cfg.get('oauth:services') ?? {};
    this.logger?.debug('Oauth Service Cfg:', services);
    for (const key of Object.keys(services)) {
      if (!(key in this.accountResolvers)) {
        this.logger?.warn('Unknown oauth service: ', key);
      }

      const service = services[key];
      await openid.discovery(
        new URL(service.issuer),
        service.client_id,
        service.client_secret,
        openid.ClientSecretPost(service.client_secret)
      ).then(
        client => this.clients.set(key, client),
        err => this.logger?.error('OpenID discovery failed:', err),
      );
    };
    return this;
  }

  async availableServices(request: Empty, context: any): Promise<DeepPartial<ServicesResponse>> {
    return {
      services: Array.from(this.clients.keys()),
    };
  }

  async generateLinks(request: Empty, context: any): Promise<DeepPartial<GenerateLinksResponse>> {
    return {
      links: Array.from(this.clients).reduce((a: any, [key, client]) => {
        const srvCfg = this.cfg.get(`oauth:services:${key}`);
        const params = {
          redirect_uri: srvCfg.redirect_uri ?? (this.cfg.get('oauth::redirect_uri_base') + key),
          response_type: srvCfg.code ?? 'code',
          scope: srvCfg.scope,
          prompt: srvCfg.prompt ?? 'consent',
          access_type: srvCfg.access_type ?? 'offline',
        };
        a[key] = openid.buildAuthorizationUrl(
          client,
          params
        );
        return a;
      }, {})
    };
  }

  async exchangeCode(request: ExchangeCodeRequest, context: any): Promise<DeepPartial<ExchangeCodeResponse>> {
    try {
      const oauthService = request.service;
      const srvCfg = this.cfg.get(`oauth:services:${oauthService}`);
      const propertyUrn = srvCfg.property;
      const client = this.clients.get(oauthService);
      if (!client) {
        throw new Error(`Unknown service: ${oauthService}`);
      }

      const currentUrl = new URL(
        srvCfg.redirect_uri ?? (this.cfg.get('oauth::redirect_uri_base') + oauthService)
      );
      currentUrl.searchParams.set('iss', srvCfg.issuer);
      currentUrl.searchParams.set('code', request.code);
      currentUrl.searchParams.set('scope', srvCfg.scope);

      const data = await openid.authorizationCodeGrant(
        client,
        currentUrl,
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
      if (users.length === 0) {
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

      let user = users[0].payload;
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
        expires_in: new Date(Date.now() + data.expires_in * 1000),
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
      this.logger?.info('Token updated on user entity', { id: user.id });
      // Add identifier property if any
      if (propertyUrn) {
        this.logger?.debug('Append identification property');
        user.properties ??= [];
        user.properties.push({
          id: propertyUrn,
          value: resp.id,
        });
        user = await this.userService.superUpdate(
          {
            items: [{
              id: user.id,
              email: resp.email,
              properties: _.uniqWith(user.properties, _.isEqual),
              meta: user.meta
            }]
          }, {}
        ).then(
          resp => {
            if (resp.operation_status?.code !== 200) {
              throw resp.operation_status;
            }
            else {
              return resp.items?.pop()?.payload;
            }
          }
        );
      }

      authToken.expires_in = new Date(authToken.expires_in);
      return {
        email: user.email,
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
      this.logger?.error('Error on token exchange', err.cause ?? err);
      return {
        user: {
          status: {
            code: Number.isInteger(err.code) ? err.code : 500,
            message: err.message ?? 'Unknown Error!'
          }
        }
      };
    }
  }

  async getToken(request: GetTokenRequest, context: any): Promise<DeepPartial<GetTokenResponse>> {
    try {
      const oauthService = request.service;
      const client = this.clients.get(oauthService);
      if (!client) {
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
        this.logger?.debug('OAuth.getToken(): No user found!'); // don't tell attackers!
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
          this.logger?.debug('OAuth.getToken(): User has no token for this service!'); // don't tell attackers!
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
        err => this.logger?.warn(
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

      const data = await openid.refreshTokenGrant(
        client,
        validRefreshToken.token,
      );

      if (!data) {
        return {status: {code: 400, message: 'refresh token has expired'}};
      }

      const newAccessToken = {
        name: oauthService + '-access_token',
        expires_in: new Date(Date.now() + data.expires_in * 1000),
        token: data.access_token,
        type: 'access_token',
        interactive: true,
        last_use: new Date(),
        creeated_at: new Date()
      };

      // append access token on user entity
      await this.userService.updateUserTokens(user.payload.id, newAccessToken);
      this.logger?.info('Token updated on user entity', {id: user.payload.id});
      return { token: newAccessToken.token };
    } catch (err: any) {
      this.logger?.error('Error Updating Token', err);
      return {
        status: {
          code: err.code,
          message: err.message
        }
      };
    }
  }

  public static async init(
    cfg: ServiceConfig,
    userService: UserService,
    logger?: Logger,
    clients = new Map<string, openid.Configuration>(),
  ) {
    return await new OAuthService(
      cfg,
      userService,
      logger,
      clients,
    ).init();
  }; 
}
