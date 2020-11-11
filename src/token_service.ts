import { Logger, errors } from '@restorecommerce/chassis-srv';
import { ACSAuthZ, PermissionDenied, AuthZAction, Decision, Subject } from '@restorecommerce/acs-client';
import { AccessResponse, checkAccessRequest } from './utils';
import * as _ from 'lodash';
import { UserService } from './service';
import * as uuid from 'uuid';

interface TokenData {
  id: string;
  payload: any;
  expires_in: number;
  subject?: Subject;
  token_type?: string;
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
    let tokenTechUser;
    const techUsersCfg = this.cfg.get('techUsers');
    if (techUsersCfg && techUsersCfg.length > 0) {
      tokenTechUser = _.find(techUsersCfg, { id: 'upsert_user_tokens' });
    }
    let acsResponse: AccessResponse;
    let tokenData = call.request;
    let subject = call.request.subject;
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

    const payload = unmarshallProtobufAny(tokenData.payload);
    tokenData.payload = payload;
    const tokent_type = tokenData.token_type;
    tokenData.payload = JSON.stringify(payload);

    let response;
    try {
      // pass tech user for subject find operation
      const userData = await this.userService.find({ request: { id: payload.accountId, subject } });
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
          expires_at: payload.exp,
          token: payload.jti,
          tokent_type,
          interactive: true
        };
        currentTokenList.push(token);
        user.tokens = currentTokenList;
        user.last_login = new Date().getTime();
        user.last_access = new Date().getTime();
        await this.userService.update({ request: { items: [user], tokenTechUser } });
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
    const token_type = call.request.token_type;
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
      const user = await this.userService.findByToken({ token: id });
      if (user && user.data && user.data.tokens && user.tokens.length > 0) {
        for (let token of user.tokens) {
          if (token.token === id && token.token_type === token_type) {
            tokenData = token;
            break;
          }
        }
      }
      if (user && tokenData) {
        data = {
          accountId: user.id,
          exp: tokenData.expires_at,
          claims: user,
          kind: tokenData.token_type,
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
    const token_type = call.request.token_type;
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
              if (token.token === id && token.token_type === token_type) {
                // token exists, delete it
                updateToken = true;
                break;
              }
            }
            if (updateToken) {
              const updatedTokenList = currentTokenList.filter(token => token.token !== id);
              user.tokens = updatedTokenList;
              user.last_access = new Date().getTime();
              await this.userService.update({ request: { items: [user], subject } });
            }
          };
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
      if (subject && subject.token) {
        const user = await this.userService.findByToken({ token: subject.token });
        if (user.data && user.data.id) {
          orgOwnerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user
            },
            {
              id: urns.ownerInstance,
              value: user.data.id
            });
        }
      }
      resource.meta.owner = orgOwnerAttributes;
    }
    return resources;
  }
}