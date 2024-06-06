import {
  AuthZAction, accessRequest, DecisionResponse, Operation, PolicySetRQResponse, ACSClientContext
} from '@restorecommerce/acs-client';
import * as _ from 'lodash-es';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createClient, createChannel } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import bcrypt from 'bcryptjs';
import {
  DeepPartial,
  FilterOp, FilterOp_Operator,
  Filter_Operation
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import {
  UserServiceDefinition,
  UserServiceClient
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';

// Create a ids client instance
let idsClientInstance: UserServiceClient;
const cfg = createServiceConfig(process.cwd());
export const getUserServiceClient = (): UserServiceClient => {
  if (!idsClientInstance) {
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    const logger = createLogger(loggerCfg);
    if (grpcIDSConfig) {
      const channel = createChannel(grpcIDSConfig.address);
      idsClientInstance = createClient({
        ...grpcIDSConfig,
        logger
      }, UserServiceDefinition, channel);
    }
  }
  return idsClientInstance;
};

export interface Resource {
  resource: string;
  id?: string | string[]; // for what is allowed operation id is not mandatory
  property?: string[];
}

export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction, operation: Operation.isAllowed, useCache?: boolean): Promise<DecisionResponse>;
export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction, operation: Operation.whatIsAllowed, useCache?: boolean): Promise<PolicySetRQResponse>;

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction,
  operation: Operation, useCache = true): Promise<DecisionResponse | PolicySetRQResponse> {
  const subject = ctx.subject as Subject;
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

  let result: DecisionResponse | PolicySetRQResponse;
  try {
    result = await accessRequest(subject, resource, action, ctx, { operation, useCache, roleScopingEntityURN: cfg?.get('authorization:urns:roleScopingEntityURN') });
  } catch (err) {
    return {
      decision: Response_Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  return result;
}

export const password = {
  hash: (pw: string): string => {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(pw, salt);
    return hash;
  },
  verify: (password_hash: string, pw: string) => {
    return bcrypt.compareSync(pw, password_hash);
  }
};

export const marshallProtobufAny = (msg: any): any => {
  return {
    type_url: 'identity.rendering.renderRequest',
    value: Buffer.from(JSON.stringify(msg))
  };
};

export const unmarshallProtobufAny = (msg: any, logger: any): any => {
  try {
    if (msg.value) {
      return JSON.parse(msg.value.toString());
    }
  } catch (error) {
    logger.error('Error unmarshalling JSON', msg);
  }
};

export const getDefaultFilter = (identifier: string): DeepPartial<FilterOp[]> => {
  return [{
    filters: [
      {
        field: 'name',
        operation: Filter_Operation.eq,
        value: identifier
      },
      {
        field: 'email',
        operation: Filter_Operation.eq,
        value: identifier
      }],
    operator: FilterOp_Operator.or
  }];
};

export const getNameFilter = (userName: string) => {
  return [{
    filters: [{
      field: 'name',
      operation: Filter_Operation.eq,
      value: userName
    }]
  }];
};

export const getLoginIdentifierFilter = (loginIdentifiers, value: string) => {
  if (typeof loginIdentifiers === 'string') {
    return [{
      filters: [{
        field: loginIdentifiers,
        operation: Filter_Operation.eq,
        value
      }]
    }];
  } else if (_.isArray(loginIdentifiers)) {
    let filters = [{ filters: [], operator: FilterOp_Operator.or }];
    for (let identifier of loginIdentifiers) {
      filters[0].filters.push(
        {
          field: identifier,
          operation: Filter_Operation.eq,
          value
        });
    }
    return filters;
  }
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

/**
 * accessResponse returned from `acs-client` contains the filters for the list of
 * resources requested and it returns resource filter map, below api
 * returns applicable `Filters[]` for the specified resource, it iterates through
 * the ACS response and returns the applicable `Filters[]` for the resource.
 * @param accessResponse ACS response
 * @param enitity enitity name
 */
export const getACSFilters = (accessResponse: PolicySetRQResponse, resource: string): FilterOp[] => {
  let acsFilters = [];
  const resourceFilterMap = accessResponse?.filters;
  const resourceFilter = resourceFilterMap?.filter((e) => e?.resource === resource);
  // for a given entity there should be one filter map
  if (resourceFilter?.length === 1 && resourceFilter[0]?.filters[0]?.filters?.length > 0) {
    acsFilters = resourceFilter[0].filters;
  }
  return acsFilters;
};
