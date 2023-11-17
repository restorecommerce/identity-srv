import { Logger } from 'winston';
import { ACSAuthZ, AuthZAction, DecisionResponse, Operation, PolicySetRQResponse } from '@restorecommerce/acs-client';
import { checkAccessRequest } from './utils';
import * as _ from 'lodash';
import { UserService } from './service';
import * as uuid from 'uuid';
import { createMetadata } from './common';
import {
  DeepPartial, GrantId,
  Identifier,
  TokenServiceImplementation,
  TokenData
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/token';
import { Any } from '@restorecommerce/rc-grpc-clients/dist/generated-server/google/protobuf/any';
import {
  FindByTokenRequest,
  FindRequest, UserList, User
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';

const unmarshallProtobufAny = (msg: Any): any => JSON.parse(msg.value.toString());

const marshallProtobufAny = (msg: any): Any => {
  if (msg) {
    return {
      type_url: '',
      value: Buffer.from(JSON.stringify(msg))
    };
  }
};

export class TokenService implements TokenServiceImplementation {
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
  async upsert(request: TokenData, context): Promise<DeepPartial<Any>> {
    if (!request || !request.id) {
      const response = { status: { code: 400, message: 'No id was provided for create / upsert' } };
      return marshallProtobufAny(response);
    }

    // using techUser to update user Tokens
    let tokenTechUser: any = {};
    const techUsersCfg = this.cfg.get('techUsers');
    if (techUsersCfg && techUsersCfg.length > 0) {
      tokenTechUser = _.find(techUsersCfg, { id: 'upsert_user_tokens' });
    }
    let acsResponse: DecisionResponse;
    let tokenData = request;
    // unmarshall payload
    const payload = unmarshallProtobufAny(tokenData.payload);
    tokenData.payload = payload;
    tokenTechUser.scope = payload?.claims?.data?.default_scope;
    try {
      if (!context) { context = {}; };
      request = await createMetadata(tokenData, this.cfg.get('authorization:urns'), this.userService, tokenTechUser);
      context.subject = tokenTechUser;
      context.resources = request;
      acsResponse = await checkAccessRequest(context, [{ resource: 'token', id: request.id }], AuthZAction.MODIFY,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for token upsert', err);
      const response = { status: { code: err.code, message: err.message } };
      return marshallProtobufAny(response);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      const response = { status: { code: acsResponse.operation_status.code, message: acsResponse.operation_status.message } };
      return marshallProtobufAny(response);
    }

    const type = tokenData.type;
    tokenData.payload = marshallProtobufAny(payload);

    let response;
    try {
      // pass tech user for subject find operation
      const userData = await this.userService.find(FindRequest.fromPartial({ id: payload.accountId, subject: tokenTechUser }), {});
      if (userData?.items?.length > 0) {
        let user = userData.items[0].payload;
        let expiredTokenList = [];
        if (user?.tokens?.length > 0) {
          // remove expired tokens
          expiredTokenList = (user.tokens).filter(obj => {
            if (obj.expires_in.getTime() < new Date().getTime()) {
              // since AQL is used to remove object - convert DateObject to time in ms
              (obj as any).expires_in = obj.expires_in ? obj.expires_in.getTime() : undefined;
              (obj as any).last_login = obj.last_login ? obj.last_login.getTime() : undefined;
              return obj;
            }
          });
        }
        let token_name;
        if (payload.claims && payload.claims.token_name) {
          token_name = payload.claims.token_name;
        } else {
          token_name = uuid.v4().replace(/-/g, '');
        }
        const token = {
          name: token_name,
          expires_in: tokenData?.expires_in?.getTime(), // since AQL is used to store to DB
          token: payload.jti,
          type,
          interactive: true,
          last_login: new Date().getTime()
        };
        try {
          // append tokens on user entity
          this.logger.debug('Removing expired token list', expiredTokenList);
          await this.userService.updateUserTokens(user.id, token, expiredTokenList);
          this.logger.info('Token updated successfully on user entity', { token, id: user.id });
        } catch (err) {
          this.logger.error('Error Updating Token', err);
        }
        response = {
          status: {
            code: 200,
            message: `Token updated successfully for Subject ${user.name}`
          }
        };
      } else {
        response = {
          status: {
            code: 401,
            message: `Invalid account, Subject ${payload.accountId} does not exist`
          }
        };
      }
      return marshallProtobufAny(response);
    } catch (err) {
      response = {
        status: {
          code: err.code,
          message: `Error updating token for Subject ${payload.accountId}`
        }
      };
      this.logger.error(`Error updating token for Subject ${payload.accountId}`, { err });
      return marshallProtobufAny(response);
    }
  }

  /**
   * Find access token data from User entity by tokenID
  **/
  async find(request: Identifier, context): Promise<Any> {
    const subject = request.subject;
    if (!request || !request.id) {
      const response = { status: { code: 400, message: 'No id was provided for find' } };
      return marshallProtobufAny(response);
    }
    let acsResponse: PolicySetRQResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: []
      }, [{ resource: 'token' }], AuthZAction.READ, Operation.whatIsAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for token find', err);
      const response = { status: { code: err.code, message: err.message } };
      return marshallProtobufAny(response);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      const response = { status: { code: acsResponse.operation_status.code, message: acsResponse.operation_status.message } };
      return marshallProtobufAny(response);
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      let data;
      let tokenData;
      const user = await this.userService.findByToken(FindByTokenRequest.fromPartial({ token: request.id }), context);
      if (user?.payload?.tokens?.length > 0) {
        let userTokens = user.payload.tokens;
        for (let token of userTokens) {
          if (token.token === request.id) {
            tokenData = token;
            break;
          }
        }
      }
      if (user?.payload && tokenData) {
        data = {
          accountId: user.payload.id,
          exp: tokenData.expires_in,
          claims: user,
          kind: tokenData.type,
          jti: tokenData.token
        };
      }
      if (!data) {
        return marshallProtobufAny({ message: 'No data found for provided token value' });
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
  **/
  async destroy(request: Identifier, context): Promise<DeepPartial<Any>> {
    if (!request || !request.id) {
      const response = { status: { code: 400, message: 'Key was not provided for delete operation' } };
      return marshallProtobufAny(response);
    }
    context.subject = request.subject;
    const resources = await createMetadata(request, this.cfg.get('authorization:urns'), this.userService, request.subject);
    context.resources = resources;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(context, [{ resource: 'token', id: request.id }], AuthZAction.DELETE, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for token destroy', err);
      const response = { status: { code: err.code, message: err.message } };
      return marshallProtobufAny(response);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      const response = { status: { code: acsResponse.operation_status.code, message: acsResponse.operation_status.message } };
      return marshallProtobufAny(response);
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      this.logger.info('Logout user', { request });
      let response;
      let user: User = {};
      try {
        let payload = await this.find(request, context);
        // delete user token here
        if (payload?.value) {
          const userData = await this.userService.findByToken(FindByTokenRequest.fromPartial({ token: request.id }), {});
          if (userData?.payload) {
            // search user by ID from DB
            const dbUserData = await this.userService.find(FindRequest.fromPartial({ id: userData?.payload?.id, subject: request.subject }), context);
            if (dbUserData?.items?.length > 0) {
              user = dbUserData.items[0].payload;
            } else {
              this.logger.info(`User ${user?.id} not found in DB or cannot be read`);
              return marshallProtobufAny({ status: { code: dbUserData?.operation_status?.code, message: dbUserData?.operation_status?.message } });
            }
            // check if the token exist, if so remove it
            const tokenExist = user?.tokens?.some((tokenObj) => tokenObj.token === request.id && tokenObj.type === request.type);
            if (tokenExist) {
              // AQL query to remove token
              await this.userService.removeToken(userData?.payload?.id, user?.tokens?.filter((obj) => {
                if (obj.token === request.id) {
                  // since AQL is used to remove object - convert DateObject to time in ms
                  (obj as any).expires_in = obj.expires_in ? obj.expires_in.getTime() : undefined;
                  (obj as any).last_login = obj.last_login ? obj.last_login.getTime() : undefined;
                  return obj;
                }
              }));
              this.logger.info('Removed token successfully from destroy api', { token: request.id, user });
              // flush token subject cache
              const numberOfDeletedKeys = await this.userService.tokenRedisClient.del(request.id);
              this.logger.info('Subject deleted from Redis', { noOfKeys: numberOfDeletedKeys });
              response = {
                status: {
                  code: 200,
                  message: `Key for subject ${user.id} deleted successfully`
                }
              };
            } else {
              this.logger.info(`Token ${request.id} does not exist`);
              return marshallProtobufAny({ status: { code: 404, message: `Token ${request.id} does not exist` } });
            }
          } else {
            response = { status: { code: 404, message: `Token ${request.id} not found` } };
          }
        }
      } catch (err) {
        this.logger.error(response);
        response = {
          status: {
            code: err.code,
            message: `Error deleting token for subject ${user.id}`
          }
        };
      }
      this.logger.debug('Token destroy response', response);
      return marshallProtobufAny(response);
    }
  }

  /**
  * Consume access token
  **/
  async consume(request: Identifier, context): Promise<DeepPartial<Any>> {
    if (!request || !request.id) {
      const response = { status: { code: 400, message: 'ID was not provided for consume operation' } };
      return marshallProtobufAny(response);
    }

    let acsResponse: PolicySetRQResponse;
    const subject = { token: request.id };
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject: {
          token: request.id
        },
        resources: []
      }, [{ resource: 'token' }], AuthZAction.READ, Operation.whatIsAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for token consume', err);
      const response = { status: { code: err.code, message: err.message } };
      return marshallProtobufAny(response);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      const response = { status: { code: acsResponse.operation_status.code, message: acsResponse.operation_status.message } };
      return marshallProtobufAny(response);
    }

    try {
      const tokenData = unmarshallProtobufAny(await this.find(Identifier.fromPartial({ id: request.id, subject }), context));
      if (tokenData) {
        // update last access
        const userData = await this.userService.find(FindRequest.fromPartial({ id: tokenData.accountId, subject }), context);
        if (userData?.items?.length > 0) {
          let user = userData.items[0].payload;
          user.last_access = new Date();
          await this.userService.update(UserList.fromPartial({ items: [user], subject }), context);
        }
      };
      let response = { status: { code: 200, message: `AccessToken with ID ${request.id} consumed` } };
      return marshallProtobufAny(response);
    } catch (err) {
      this.logger.error('Error consuming token', { message: err.message });
      let response = { status: { code: err.code, message: err.message } };
      return marshallProtobufAny(response);
    }
  }

  /**
  * Delete access token data using grant_id
  *
  **/
  async revokeByGrantId(request: GrantId, context): Promise<DeepPartial<Any>> {
    if (!request || !request.grant_id) {
      const response = { status: { code: 400, message: 'GrantId was not provided for revoke operation' } };
      return marshallProtobufAny(response);
    }
    context.subject = request.subject;
    let subject = request.subject;
    let tokens = await this.userService.tokenRedisClient.get(request.grant_id) as any;
    if (tokens) {
      this.logger.debug('Found grant_id in redis cache');
      tokens = JSON.parse(tokens);
    }
    Object.assign(subject, { tokens });
    const resources = await createMetadata(request, this.cfg.get('authorization:urns'), this.userService, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = resources;
      acsResponse = await checkAccessRequest(context, [{ resource: 'token', id: request.grant_id }], AuthZAction.DELETE, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for token revoke by grant id', err);
      const response = { status: { code: err.code, message: err.message } };
      return marshallProtobufAny(response);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      const response = { status: { code: acsResponse.operation_status.code, message: acsResponse.operation_status.message } };
      return marshallProtobufAny(response);
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (typeof tokens === 'string') {
        tokens = [tokens];
      }

      if (tokens && _.isArray(tokens)) {
        for (let token of tokens) {
          const userData = await this.find(Identifier.fromPartial({ id: token, subject }), context);
          if (!_.isEmpty(userData)) {
            let tokenData = unmarshallProtobufAny(userData);
            await this.destroy(Identifier.fromPartial({ id: tokens, type: tokenData.kind, subject }), context);
          }
        }
      }
    }
  }
}
