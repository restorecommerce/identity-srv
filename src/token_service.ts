import { errors } from '@restorecommerce/chassis-srv';
import { Logger } from 'winston';
import { ACSAuthZ, PermissionDenied, AuthZAction, Decision, Subject } from '@restorecommerce/acs-client';
import { AccessResponse, checkAccessRequest } from './utils';
import * as _ from 'lodash';
import { UserService } from './service';
import * as uuid from 'uuid';
import { resolve } from 'dns';

interface TokenData {
  id: string;
  payload: any;
  expires_in: number;
  subject?: Subject;
  type?: string;
}

interface ReqTokenData {
  request: TokenData;
}

const unmarshallProtobufAny = (msg: any): any => JSON.parse(msg.value.toString());

const marshallProtobufAny = (msg: any): any => {
  if (msg) {
    return {
      type_url: '',
      value: Buffer.from(JSON.stringify(msg))
    };
  }
};

export class TokenService {
  logger: Logger;
  cfg: any;
  authZ: ACSAuthZ;
  userService: UserService;
  constructor(cfg: any, logger: any, authZ: ACSAuthZ, userService: UserService) {
    this.logger = logger;
    this.authZ = authZ;
    this.cfg = cfg;
    this.userService = userService;
  }

  /**
   * Store / Upsert accessToken Data to User entity
   *
  **/
  async upsert(call: ReqTokenData, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('No id was provided for creat / upsert');
    }

    // using techUser to update user Tokens
    let tokenTechUser: any = {};
    const techUsersCfg = this.cfg.get('techUsers');
    if (techUsersCfg && techUsersCfg.length > 0) {
      tokenTechUser = _.find(techUsersCfg, { id: 'upsert_user_tokens' });
    }
    let acsResponse: AccessResponse;
    let tokenData = call.request;
    // unmarshall payload
    const payload = unmarshallProtobufAny(tokenData.payload);
    tokenData.payload = payload;
    tokenTechUser.scope = payload?.claims?.data?.default_scope;
    try {
      call.request = await this.createMetadata(tokenData, tokenTechUser);
      acsResponse = await checkAccessRequest(tokenTechUser, call.request, AuthZAction.MODIFY,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    const type = tokenData.type;
    tokenData.payload = JSON.stringify(payload);

    let response;
    try {
      // pass tech user for subject find operation
      const userData = await this.userService.find({ request: { id: payload.accountId, subject: tokenTechUser } });
      if (userData && userData.items && userData.items.length > 0) {
        let user = userData.items[0];
        let currentTokenList = [];
        if (user && user.tokens && user.tokens.length > 0) {
          currentTokenList = user.tokens;
        }
        let token_name;
        if (payload.claims && payload.claims.token_name) {
          token_name = payload.claims.token_name;
        } else {
          token_name = uuid.v4().replace(/-/g, '');
        }
        const token = {
          name: token_name,
          expires_in: payload.exp,
          token: payload.jti,
          type,
          interactive: true,
          last_login: new Date().getTime()
        };
        currentTokenList.push(token);
        user.tokens = currentTokenList;
        user.last_access = new Date().getTime();
        try {
          // temporary fix to append tokens on user entity
          await this.userService.updateUserTokens(user.id, token);
          this.logger.info('Token updated successfully on user entity', { token, id: user.id });
        } catch (err) {
          this.logger.error('Error Updating Token', err);
        }
        response = {
          status: `Token updated successfully for Subject ${user.name}`
        };
      } else {
        response = {
          status: `Invalid account, Subject ${payload.accountId} does not exist`
        };
      }
      return marshallProtobufAny(response);
    } catch (err) {
      response = {
        status: `Error updating token for Subject ${payload.accountId}`
      };
      this.logger.error(`Error updating token for Subject ${payload.accountId}`, { err });
      return marshallProtobufAny(response);
    }
  }

  /**
   * Find access token data from User entity by tokenID
   *
  **/
  async find(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('No id was provided for find');
    }

    let subject = call.request.subject;
    const id = call.request.id;
    const type = call.request.type;
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { entity: 'token' }, AuthZAction.READ,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      let data;
      let tokenData;
      const user = await this.userService.findByToken({ request: { token: id } });
      if (user && user.tokens && user.tokens.length > 0) {
        for (let token of user.tokens) {
          if (token.token === id) {
            tokenData = token;
            break;
          }
        }
      }
      if (user && tokenData) {
        data = {
          accountId: user.id,
          exp: tokenData.expires_in,
          claims: user,
          kind: tokenData.type,
          jti: tokenData.token
        };
      }
      if (!data) {
        return undefined;
      }

      if (typeof data === 'string') {
        return marshallProtobufAny(JSON.parse(data));
      } else if (data && typeof data === 'object') {
        return marshallProtobufAny(data);
      }
    }
  }

  /**
   * Delete access token data from User entity
   *
  **/
  async destroy(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('Key was not provided for delete operation');
    }

    let subject = call.request.subject;
    const id = call.request.id;
    const type = call.request.type;
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request, AuthZAction.DELETE,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      let response;
      let user: any = {};
      try {
        let payload = await this.find({ request: { id, subject } });
        // delete user token here
        if (payload && payload.value) {
          payload = unmarshallProtobufAny(payload);
          const userData = await this.userService.find({ request: { id: payload.accountId, subject } });
          if (userData && userData.items && userData.items.length > 0) {
            let user = userData.items[0];
            // check if the token is existing if not update it
            let updateToken = false;
            let currentTokenList = [];
            if (user && user.tokens && user.tokens.length > 0) {
              currentTokenList = user.tokens;
            }
            for (let token of currentTokenList) {
              if (token.token === id && token.type === type) {
                // token exists, delete it
                updateToken = true;
                break;
              }
            }
            if (updateToken) {
              const updatedTokenList = currentTokenList.filter(token => token.token !== id);
              user.tokens = updatedTokenList;
              user.last_access = new Date().getTime();

              let tokenTechUser: any = {};
              const techUsersCfg = this.cfg.get('techUsers');
              if (techUsersCfg && techUsersCfg.length > 0) {
                tokenTechUser = _.find(techUsersCfg, { id: 'upsert_user_tokens' });
              }
              tokenTechUser.scope = user.default_scope;
              await this.userService.update({ request: { items: [user], subject: tokenTechUser } });
            }
          }
          if (id) {
            // flush token subject cache
            await new Promise((resolve: any, reject) => {
              this.userService.tokenRedisClient.del(id, async (err, numberOfDeletedKeys) => {
                if (err) {
                  this.logger.error('Error deleting user data from redis', err);
                  resolve(err);
                } else {
                  this.logger.info('Subject data deleted from Reids', { noOfKeys: numberOfDeletedKeys });
                  resolve();
                }
              });
            });
          }
          response = `Key for subject ${user.id} deleted successfully`;
        }
      } catch (err) {
        response = `Error deleting token for subject ${user.id}`;
        this.logger.error(response);
      }
      return marshallProtobufAny({ response });
    }
  }

  /**
  * Consume access token
  *
  **/
  async consume(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('ID was not provided for consume operation');
    }

    let acsResponse: AccessResponse;
    const token = call.request.id;
    const subject = { token };
    try {
      acsResponse = await checkAccessRequest(subject, { entity: 'token' }, AuthZAction.READ,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    try {
      const tokenData = await this.find({ request: { token, subject: { token } } });
      if (tokenData) {
        // update last access
        const userData = await this.userService.find({ request: { id: tokenData.accountId, subject } });
        if (userData && userData.items && userData.items.length > 0) {
          let user = userData.items[0];
          user.last_access = new Date().getTime();
          await this.userService.update({ request: { items: [user], subject } });
        }
      };
      return marshallProtobufAny({ response: `AccessToken with ID ${call.request.id} consumed` });
    } catch (err) {
      return marshallProtobufAny({ response: `error consuming access token` });
    }
  }

  /**
  * Delete access token data using grant_id
  *
  **/
  async revokeByGrantId(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('GrantId was not provided for revoke operation');
    }

    let subject = call.request.subject;
    const grant_id = call.request.grant_id;
    let tokens = await new Promise((resolve, reject) => {
      this.userService.tokenRedisClient.get(grant_id, async (err, response) => {
        if (!err && response) {
          this.logger.debug('Found grant_id in redis cache');
          const redisResp = JSON.parse(response);
          resolve(redisResp);
        } else if (err) {
          this.logger.error('Error retrieving grant_id', { err });
          return resolve(marshallProtobufAny({ response: `Error retrieving grant_id ${grant_id}` }));
        }
      });
    });
    Object.assign(subject, { tokens });
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request, AuthZAction.DELETE,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (typeof tokens === 'string') {
        tokens = [tokens];
      }

      if (tokens && _.isArray(tokens)) {
        for (let token of tokens) {
          const userData = await this.find({ request: { id: token, subject } });
          if (!_.isEmpty(userData)) {
            let tokenData = unmarshallProtobufAny(userData);
            await this.destroy({ request: { id: tokens, type: tokenData.kind, subject } });
          }
        }
      }
    }
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
        const user = await this.userService.findByToken({ request: { token: subject.token } });
        if (user && user.id) {
          orgOwnerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user
            },
            {
              id: urns.ownerInstance,
              value: user.id
            });
        }
      }
      resource.meta.owner = orgOwnerAttributes;
    }
    return resources;
  }
}
