import {
  AuthZAction, Decision, PolicySetRQ, parseResourceList, accessRequest, updateConfig
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { UserService } from './service';
import { ACSAuthZ } from '@restorecommerce/acs-client';
import { UnAuthZ } from '@restorecommerce/acs-client';

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
  custom_query_args: {
    custom_queries: any;
    custom_arguments: any;
  };
}

// export async function GQLAccessRequest(args: any, ctx: Context, action: AuthZAction.READ, entity: string | Resource | ReadRequest): Promise<GQLReadPolicyResponse>;
// export async function GQLAccessRequest(args: any, ctx: Context, action: AuthZAction.CREATE | AuthZAction.MODIFY, entity: ReadRequest): Promise<GQLReadPolicyResponse>;
// export async function GQLAccessRequest(args: any, ctx: Context, action: Omit<AuthZAction, AuthZAction.READ>, entity: string | Resource, tenantOverride?: string): Promise<GQLAccessResponse>;

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(subject: any, resources: any, action: AuthZAction,
  entity: string, authZ: ACSAuthZ): Promise<AccessResponse | ReadPolicyResponse> {
  let data: any;
  if (typeof (resources) === 'object') {
    data = resources;
  } else if (action != AuthZAction.READ) {
    if (action === AuthZAction.DELETE) {
      resources = (resources as any)[0].ids;
    }
    data = parseResourceList(subject, resources, action, entity);
  } else if (action === AuthZAction.READ) {
    let preparedInput: any = {};

    if (resources) {
      preparedInput = _.cloneDeep(resources);
      if (preparedInput.filter) {
        if (!Array.isArray(preparedInput.filter)) {
          preparedInput.filter = [preparedInput.filter];
        }
      }
    }

    data = {
      entity,
      args: preparedInput
    };
  }

  let result: Decision | PolicySetRQ;
  try {
    result = await accessRequest(subject, data, action, authZ);
  } catch (err) {
    return {
      decision: Decision.DENY,
      response: {
        payload: undefined,
        count: 0,
        status: {
          code: err.code || 500,
          message: err.details,
        }
      }
    };
  }
  if (typeof result === 'string') {
    return {
      decision: result
    };
  }
  let custom_queries = data.args && data.args.custom_queries ? data.args.custom_queries : undefined;
  let custom_arguments = data.args && data.args.custom_arguments ? data.args.custom_arguments : undefined;
  return {
    decision: Decision.PERMIT,
    policySet: result,
    filter: data.args && data.args.filter ? data.args.filter : undefined,
    custom_query_args: { custom_queries, custom_arguments }
  };
}

export const getSubjectRedis = async (userID: string, service: UserService) => {
  let redisKey = `subject:${userID}:hrScope`;
  let hierarchical_scopes: HierarchicalScope[];
  let subject: any;
  // update ctx with HR scope from redis
  subject = await new Promise((resolve, reject) => {
    service.redisClient.get(redisKey, async (err, response) => {
      if (!err && response) {
        // update user HR scope from redis
        subject.hierarchical_scopes = JSON.parse(response);
        resolve(subject);
      }
      // when not set in redis use default_scope as hrScope
      if (err || (!err && !response)) {
        // disable authorization to read data
        let isAuthZEnabled = this.cfg.get('authorization:enabled');
        if (isAuthZEnabled) {
          this.cfg.set('authorization:enabled', false);
          updateConfig(this.cfg);
        }
        const result = await service.find({ request: { id: userID } });
        // enable authorization back
        if (isAuthZEnabled) {
          this.cfg.set('authorization:enabled', true);
          updateConfig(this.cfg);
        }
        if (result.data && result.data.items) {
          let data = result.data.items[0];
          if (!subject.role_associations) {
            subject.role_associations = data.role_associations;
          }
          if (data.default_scope) {
            // find the role matching default scope and use the first one
            // in case of multiple roles with same scope
            const userRoleAssocs = data.role_associations;
            let defaultRole;
            for (let role of userRoleAssocs) {
              if (role.attributes[1] && role.attributes[1].value &&
                role.attributes[1].value === data.default_scope) {
                defaultRole = role.role;
                break;
              }
            }
            hierarchical_scopes = [{ id: data.default_scope, role: defaultRole }];
          }
          subject.hierarchical_scopes = hierarchical_scopes;
          resolve(subject);
          return subject;
        }
      }
    });
  });
  return subject;
};