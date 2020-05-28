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
 * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
 * @param reaources list of resources
 * @param entity entity name
 * @param action resource action
 */
const createMetadata = async (resource: any, entity: string, action: string,
  service: UserService | RoleService, subject?: Subject): Promise<any> => {
  let ownerAttributes = [];
  if (!resource.meta) {
    resource.meta = {};
  }
  if (resource.meta && resource.meta.owner) {
    ownerAttributes = resource.meta.owner;
  }

  const urns = service.cfg.get('authorization:urns');

  let ownUser = false;
  let foundEntity = false;
  for (let attribute of ownerAttributes) {
    if (attribute.id == urns.ownerIndicatoryEntity && attribute.value == urns.user) {
      foundEntity = true;
    } else if (attribute.id == urns.ownerInstance && attribute.value == subject.id && foundEntity) {
      ownUser = true;
      break;
    }
  }

  // if no owner attributes specified then by default add the subject scope and user as default owner
  if (!ownUser && subject && ownerAttributes.length === 0) {
    // subject owner
    ownerAttributes.push(
      {
        id: urns.ownerIndicatoryEntity,
        value: urns.organization
      },
      {
        id: urns.ownerInstance,
        value: subject.scope
      });
    // user owner
    ownerAttributes.push(
      {
        id: urns.ownerIndicatoryEntity,
        value: urns.user
      },
      {
        id: urns.ownerInstance,
        value: subject.id
      });
  }

  // read the entity to use owner information from exising value in DB for
  // UPDATE and DELETE actions
  if (resource.id && action != AuthZAction.CREATE && service.resourceapi) {
    let result = await service.resourceapi.read({
      filter: toStruct({
        id: {
          $eq: resource.id
        }
      })
    });
    // update owner info
    if (result.length === 1) {
      let item = result[0];
      if (!resource.meta) {
        resource.meta = {};
      }
      resource.meta.owner = item.meta.owner;
    }
  }
  return resource;
};

const convertToObject = (resources: any | any[]): any | any[] => {
  let resourcesArr = _.cloneDeep(resources);
  if (!_.isArray(resourcesArr)) {
    return JSON.parse(JSON.stringify(resourcesArr));
  }
  // GraphQL object is a pseudo-object;
  // when processing its fields, we get an exception from gRPC
  // so this fix is to sanitize all fields
  return resourcesArr.map((resource) => {
    const stringified = JSON.stringify(resource);
    return JSON.parse(stringified);
  });
};

/**
 * parses the input resources list and adds entity meta data to object
 * and returns resource list Resource[]
 * @param {Array<any>} input input resources list
 * @param {AuthZAction} action action to be performed on resource
 * @param {string} entity target entity
 * @param {UserService | RoleService} service service object
 * @return {Resource[]}
 */
export const parseResourceList = async (input: any, action: AuthZAction,
  entity: string, service: UserService | RoleService, subject?: Subject): Promise<any[]> => {
  let resourceListWithMeta = [];
  let resources = convertToObject(input.payload);
  for (let resource of resources) {
    resource = await createMetadata(resource, entity, action, service, subject);
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