import {
  AuthZAction, Decision, PolicySetRQ, accessRequest, Subject
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { UserService, RoleService } from './service';
import { toStruct } from '@restorecommerce/grpc-client';

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

/**
 * parses the input resources list and adds entity meta data to object
 * and returns resource list Resource[]
 * @param {Array<any>} input input resources list
 * @param {AuthZAction} action action to be performed on resource
 * @param {string} entity target entity
 * @param {UserService | RoleService} service service object
 * @return {Resource[]}
 */
export const parseResourceList = async (resources: any, action: AuthZAction,
  entity: string, service: UserService | RoleService, subject?: Subject): Promise<any[]> => {
  let resourceListWithMeta = [];
  for (let resource of resources) {
    resource = await service.createMetadata(resource, action, subject);
    resourceListWithMeta.push({
      fields: _.keys(resource),
      instance: resource,
      type: entity
    });
  }
  return resourceListWithMeta;
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
  entity: string, service: UserService | RoleService): Promise<AccessResponse | ReadPolicyResponse> {
  let data: any;
  let authZ = service.authZ;
  if (!_.isArray(resources)) {
    resources = [resources];
  }
  if (action != AuthZAction.READ) {
    data = parseResourceList(resources, action, entity, service, subject);
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
  resources.custom_queries = data.args && data.args.custom_queries ? data.args.custom_queries : undefined;
  resources.custom_arguments = data.args && data.args.custom_arguments ? data.args.custom_arguments : undefined;
  resources.filter = data.args && data.args.filter ? data.args.filter : undefined;
  return {
    decision: Decision.PERMIT,
    policySet: result
  };
}

export const getSubjectFromRedis = async (call: any, service: UserService | RoleService) => {
  let subject = call.request.subject;
  let api_key = call.request.api_key;
  if (subject && subject.id && !subject.hierarchical_scopes) {
    let redisKey = `gql-cache:${subject.id}:subject`;
    let hierarchical_scopes: HierarchicalScope[];
    // update ctx with HR scope from redis
    subject = await new Promise((resolve, reject) => {
      service.redisClient.get(redisKey, async (err, response) => {
        if (!err && response) {
          // update user HR scope from redis
          subject.hierarchical_scopes = JSON.parse(response);
          resolve(subject);
        }
        // when not set in redis use default_scope as hrScope
        if ((err || (!err && !response)) && (service as UserService).find) {
          // disable authorization to read data
          service.disableAC();
          const result = await (service as UserService).find({ request: { id: subject.id } });
          // enable / resotre authorization back
          service.enableAC();
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
  } else if (!subject && api_key) {
    subject = { api_key };
  }
  return subject;
};