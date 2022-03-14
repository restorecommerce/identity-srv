import {
  AuthZAction, Decision, accessRequest, Subject, DecisionResponse, Operation, PolicySetRQResponse, Filters
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { createServiceConfig } from '@restorecommerce/service-config';
import { GrpcClient } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import * as bcrypt from 'bcryptjs';
import { FilterOperation, OperatorType } from '@restorecommerce/resource-base-interface';

// Create a ids client instance
let idsClientInstance;
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    const logger = createLogger(loggerCfg);
    if (grpcIDSConfig) {
      const idsClient = new GrpcClient(grpcIDSConfig, logger);
      idsClientInstance = idsClient.user;
    }
  }
  return idsClientInstance;
};

export interface Resource {
  resource: string;
  id?: string | string[]; // for what is allowed operation id is not mandatory
  property?: string[];
}

export interface Attribute {
  id: string;
  value: string;
  attribute: Attribute[];
}

export interface CtxResource {
  id: string;
  meta: {
    created?: number;
    modified?: number;
    modified_by?: string;
    owner: Attribute[]; // id and owner is mandatory in ctx resource other attributes are optional
  };
  [key: string]: any;
}

export interface GQLClientContext {
  // if subject is missing by default it will be treated as unauthenticated subject
  subject?: Subject;
  resources?: CtxResource[];
}

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction,
  operation: Operation, useCache = true): Promise<DecisionResponse | PolicySetRQResponse> {
  let subject = ctx.subject;
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
    result = await accessRequest(subject, resource, action, ctx, operation, 'arangoDB', useCache);
  } catch (err) {
    return {
      decision: Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  return result;
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

export const getLoginIdentifierFilter = (loginIdentifiers, value) => {
  if (typeof loginIdentifiers === 'string') {
    return [{
      filter: [{
        field: loginIdentifiers,
        operation: FilterOperation.eq,
        value
      }]
    }];
  } else if (_.isArray(loginIdentifiers)) {
    let filters = [{ filter: [], operator: OperatorType.or }];
    for (let identifier of loginIdentifiers) {
      filters[0].filter.push(
        {
          field: identifier,
          operation: FilterOperation.eq,
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
export const getACSFilters = (accessResponse: PolicySetRQResponse, resource: string): Filters[] => {
  let acsFilters = [];
  const resourceFilterMap = accessResponse?.filters;
  const resourceFilter = resourceFilterMap?.filter((e) => e?.resource === resource);
  // for a given entity there should be one filter map
  if (resourceFilter && resourceFilter.length === 1 && resourceFilter[0].filters && resourceFilter[0].filters[0]?.filter.length > 0) {
    acsFilters = resourceFilter[0].filters;
  }
  return acsFilters;
};