import {
  AuthZAction, Decision, PolicySetRQ, accessRequest, Subject
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { UserService, RoleService } from './service';
import { AuthenticationLogService } from './authlog_service';
import { TokenService } from './token_service';
import { createServiceConfig } from '@restorecommerce/service-config';
import { Client } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface Response {
  payload: any;
  count: number;
  status?: {
    code: number;
    message: string;
  };
}

export interface AccessResponse {
  decision: Decision;
  response?: Response;
}

export interface FilterType {
  field?: string;
  operation?: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'in' | 'isEmpty' | 'iLike';
  value?: string;
  type?: 'string' | 'boolean' | 'number' | 'date' | 'array';
}

export interface ReadPolicyResponse extends AccessResponse {
  policySet?: PolicySetRQ;
  filter?: FilterType[];
  custom_query_args?: {
    custom_queries: any;
    custom_arguments: any;
  };
}

// Create a ids client instance
let idsClientInstance;
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const logger = createLogger(cfg.get('logger'));
    if (grpcIDSConfig) {
      const idsClient = new Client(grpcIDSConfig, logger);
      idsClientInstance = await idsClient.connect();
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
  resourceNameSpace?: string, useCache = true): Promise<AccessResponse | ReadPolicyResponse> {
  let authZ = service.authZ;
  let data = _.cloneDeep(resources);
  let dbSubject;
  // resolve subject id using findByToken api and update subject with id
  if (subject && subject.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ request: { token: subject.token } });
      if (dbSubject && dbSubject.data && dbSubject.data.id) {
        subject.id = dbSubject.data.id;
      }
    }
  }

  if (!_.isArray(resources) && action != AuthZAction.READ) {
    data = [resources];
  } else if (action === AuthZAction.READ) {
    data.args = resources;
    data.entity = entity;
  }

  let result: Decision | PolicySetRQ;
  try {
    result = await accessRequest(subject, data, action, authZ, entity, resourceNameSpace, useCache);
  } catch (err) {
    return {
      decision: Decision.DENY,
      response: {
        payload: undefined,
        count: 0,
        status: {
          code: err.code || 500,
          message: err.details || err.message,
        }
      }
    };
  }
  if (typeof result === 'string') {
    return {
      decision: result
    };
  }
  let custom_queries = data.args.custom_queries;
  let custom_arguments = data.args.custom_arguments;
  return {
    decision: Decision.PERMIT,
    policySet: result,
    filter: data.args.filter,
    custom_query_args: { custom_queries, custom_arguments }
  };
}