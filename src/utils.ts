import {
  AuthZAction, Decision, PolicySetRQ, accessRequest, Subject, DecisionResponse
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { UserService, RoleService } from './service';
import { AuthenticationLogService } from './authlog_service';
import { TokenService } from './token_service';
import { createServiceConfig } from '@restorecommerce/service-config';
import { GrpcClient } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import * as bcrypt from 'bcryptjs';
import { ReadPolicyResponse } from './interface';
import { FilterOperation, OperatorType } from '@restorecommerce/resource-base-interface';

// Create a ids client instance
let idsClientInstance;
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const logger = createLogger(cfg.get('logger'));
    if (grpcIDSConfig) {
      const idsClient = new GrpcClient(grpcIDSConfig, logger);
      idsClientInstance = idsClient.user;
    }
  }
  return idsClientInstance;
};


/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(subject: Subject, resources: any, action: AuthZAction,
  entity: string, service: UserService | RoleService | AuthenticationLogService | TokenService,
  resourceNameSpace?: string, useCache = true): Promise<DecisionResponse | ReadPolicyResponse> {
  let authZ = service.authZ;
  let data = _.cloneDeep(resources);
  let dbSubject;
  // resolve subject id using findByToken api and update subject with id
  if (subject && subject.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ token: subject.token });
      if (dbSubject && dbSubject.payload && dbSubject.payload.id) {
        subject.id = dbSubject.payload.id;
      }
    }
  }

  if (!_.isArray(resources) && action != AuthZAction.READ) {
    data = [resources];
  } else if (action === AuthZAction.READ) {
    data.args = resources;
    data.entity = entity;
  }

  let result: DecisionResponse | ReadPolicyResponse;
  try {
    result = await accessRequest(subject, data, action, authZ, entity, resourceNameSpace, useCache);
  } catch (err) {
    return {
      decision: Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  if (result && (result as ReadPolicyResponse).policy_sets) {
    let custom_queries = data.args.custom_queries;
    let custom_arguments = data.args.custom_arguments;
    (result as ReadPolicyResponse).filters = data.args.filters;
    (result as ReadPolicyResponse).custom_query_args = { custom_queries, custom_arguments };
    return result as ReadPolicyResponse;
  } else {
    return result as DecisionResponse;
  }
}

export const password = {
  hash: (pw): string => {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(pw, salt);
    return hash;
  },
  verify: (password_hash, pw) => {
    return bcrypt.compareSync(pw, password_hash);
  }
};

export const marshallProtobufAny = (msg: any): any => {
  return {
    type_url: 'identity.rendering.renderRequest',
    value: Buffer.from(JSON.stringify(msg))
  };
};

export const unmarshallProtobufAny = (msg: any): any => JSON.parse(msg.value.toString());

export const getDefaultFilter = (identifier) => {
  return [{
    filter: [
      {
        field: 'name',
        operation: FilterOperation.eq,
        value: identifier
      },
      {
        field: 'email',
        operation: FilterOperation.eq,
        value: identifier
      }],
    operator: OperatorType.or
  }];
};

export const getNameFilter = (userName) => {
  return [{
    filter: [{
      field: 'name',
      operation: FilterOperation.eq,
      value: userName
    }]
  }];
};

export const returnOperationStatus = (code: number, message: string) => {
  if (!code) {
    code = 500; // defaults to internal server error if no code is provided
  }
  return {
    operation_status: {
      code,
      message
    }
  };
};

export const returnStatus = (code: number, message: string, id?: string) => {
  if (!code) {
    code = 500; // defaults to internal server error if no code is provided
  }
  return {
    status: {
      id,
      code,
      message
    }
  };
};

export const returnCodeMessage = (code: number, message: string) => {
  if (!code) {
    code = 500; // defaults to internal server error if no code is provided
  }
  return {
    code,
    message
  };
};

interface CodeIdMsgObj {
  code: number;
  message: string;
  id?: string;
}

export const returnStatusArray = (codeIdMsgObj: CodeIdMsgObj[]) => {
  let statusArray = { status: [] };
  for (let codeMsgObj of codeIdMsgObj) {
    statusArray.status.push(codeMsgObj);
  }
  return statusArray;
};