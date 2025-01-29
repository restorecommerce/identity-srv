import * as _ from 'lodash-es';
import { Logger } from 'winston';
import { ACSAuthZ, AuthZAction, DecisionResponse, Operation, PolicySetRQResponse } from '@restorecommerce/acs-client';
import { checkAccessRequest, createMetadata } from './utils.js';
import { UserService } from './service.js';
import * as uuid from 'uuid';
import {
  DeepPartial, GrantId,
  Identifier,
  TokenServiceImplementation,
  TokenData
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/token.js';
import { Any } from '@restorecommerce/rc-grpc-clients/dist/generated-server/google/protobuf/any.js';
import {
  FindByTokenRequest,
  FindRequest, UserList, User
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import { Filter_Operation, ReadRequest } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';

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
  constructor(
    private readonly cfg: any,
    private readonly logger: any,
    private readonly userService: UserService
  ) {}

  /**
   * Store / Upsert accessToken Data to User entity
   *
  **/
  async upsert(request: TokenData, context: any): Promise<DeepPartial<Any>> {
    if (!request || !request.id) {
      const response = { status: { code: 400, message: 'No id was provided for create / upsert' } };
      return marshallProtobufAny(response);
    }

    const tokenData = request;
    // unmarshall payload
    const payload = unmarshallProtobufAny(tokenData.payload);
    const type = tokenData.type;
    let response;
    try {
      // Make a direct request to DB
      const filters = [{
        filters: [{
          field: 'id',
          operation: Filter_Operation.eq,
          value: payload?.accountId
        }],
        limit: 1
      }];
      const user = await this.userService.superRead(
        ReadRequest.fromPartial({ filters }), {}
      ).then(
        response => response.items?.[0]?.payload
      );
      if (user) {
        const expiredTokenList = user?.tokens?.filter(
          obj => obj?.expires_in && (obj.expires_in.getTime() < new Date().getTime())
        );
        let token_name;
        if (payload.claims?.token_name) {
          token_name = payload.claims.token_name;
        } else {
          token_name = uuid.v4().replace(/-/g, '');
        }
        const token = {
          name: token_name,
          expires_in: tokenData?.expires_in,
          token: payload.jti,
          type,
          interactive: true,
          last_login: new Date(),
          client_id: payload?.clientId
        };
        try {
          // append tokens on user entity
          this.logger.debug('Removing expired token list', expiredTokenList);
          await this.userService.updateUserTokens(user.id, token, expiredTokenList);
          this.logger.info('Token updated on user entity', { token, id: user.id });
        } catch (err: any) {
          this.logger.error('Error Updating Token', err);
        }
        response = {
          status: {
            code: 200,
            message: `Token updated for Subject ${user.name}`
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
    } catch (err: any) {
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
  async find(request: Identifier, context: any): Promise<Any> {
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
    } catch (err: any) {
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
        const userTokens = user.payload.tokens;
        for (const token of userTokens) {
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
          jti: tokenData.token,
          clientId: tokenData?.client_id
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
  async destroy(request: Identifier, context: any): Promise<DeepPartial<Any>> {
    if (!request || !request.id) {
      const response = { status: { code: 400, message: 'Key was not provided for delete operation' } };
      return marshallProtobufAny(response);
    }
    context.subject = request.subject;
    const resources = await createMetadata(request, this.cfg.get('authorization:urns'), request.subject);
    context.resources = resources;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(context, [{ resource: 'token', id: request.id }], AuthZAction.DELETE, Operation.isAllowed);
    } catch (err: any) {
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
        const payload = await this.find(request, context);
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
              this.logger.info('Removed token from destroy api', { token: request.id, user });
              // flush token subject cache
              const numberOfDeletedKeys = await this.userService.tokenRedisClient.del(request.id);
              this.logger.info('Subject deleted from Redis', { noOfKeys: numberOfDeletedKeys });
              response = {
                status: {
                  code: 200,
                  message: `Key for subject ${user.id} deleted`
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
      } catch (err: any) {
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
  async consume(request: Identifier, context: any): Promise<DeepPartial<Any>> {
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
    } catch (err: any) {
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
          const user = userData.items[0].payload;
          user.last_access = new Date();
          await this.userService.update(UserList.fromPartial({ items: [user], subject }), context);
        }
      };
      const response = { status: { code: 200, message: `AccessToken with ID ${request.id} consumed` } };
      return marshallProtobufAny(response);
    } catch (err: any) {
      this.logger.error('Error consuming token', { message: err.message });
      const response = { status: { code: err.code, message: err.message } };
      return marshallProtobufAny(response);
    }
  }

  /**
  * Delete access token data using grant_id
  *
  **/
  async revokeByGrantId(request: GrantId, context: any): Promise<DeepPartial<Any>> {
    if (!request || !request.grant_id) {
      const response = { status: { code: 400, message: 'GrantId was not provided for revoke operation' } };
      return marshallProtobufAny(response);
    }
    context.subject = request.subject;
    const subject = request.subject;
    let tokens = await this.userService.tokenRedisClient.get(request.grant_id) as any;
    if (tokens) {
      this.logger.debug('Found grant_id in redis cache');
      tokens = JSON.parse(tokens);
    }
    Object.assign(subject, { tokens });
    const resources = await createMetadata<any>(request, this.cfg.get('authorization:urns'), subject);
    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = resources;
      acsResponse = await checkAccessRequest(context, [{ resource: 'token', id: request.grant_id }], AuthZAction.DELETE, Operation.isAllowed);
    } catch (err: any) {
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
        for (const token of tokens) {
          const userData = await this.find(Identifier.fromPartial({ id: token, subject }), context);
          if (!_.isEmpty(userData)) {
            const tokenData = unmarshallProtobufAny(userData);
            await this.destroy(Identifier.fromPartial({ id: tokens as any, type: tokenData.kind, subject }), context);
          }
        }
      }
    }
  }
}
