import { ServiceBase, ResourcesAPIBase, toStruct } from '@restorecommerce/resource-base-interface';
import { Logger, errors } from '@restorecommerce/chassis-srv';
import { ACSAuthZ, PermissionDenied, AuthZAction, Decision, Subject } from '@restorecommerce/acs-client';
import { RedisClient, createClient } from 'redis';
import { Topic } from '@restorecommerce/kafka-client';
import { AccessResponse, ReadPolicyResponse, getSubjectFromRedis, checkAccessRequest } from './utils';

export class AuthenticationLogService extends ServiceBase {
  logger: Logger;
  redisClient: RedisClient;
  cfg: any;
  authZ: ACSAuthZ;
  authZCheck: boolean;
  constructor(cfg: any, db: any, roleTopic: Topic, logger: any,
    isEventsEnabled: boolean, authZ: ACSAuthZ) {
    super('role', roleTopic, logger, new ResourcesAPIBase(db, 'roles'), isEventsEnabled);
    this.logger = logger;
    const redisConfig = cfg.get('redis');
    redisConfig.db = cfg.get('redis:db-indexes:db-subject');
    this.redisClient = createClient(redisConfig);
    this.authZ = authZ;
    this.cfg = cfg;
    this.authZCheck = this.cfg.get('authorization:enabled');
  }

  async create(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.items || call.request.items.length == 0) {
      throw new errors.InvalidArgument('No role was provided for creation');
    }

    const items = call.request.items;
    let subject = await getSubjectFromRedis(call);
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.CREATE, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.CREATE,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      for (let role of items) {
        // check unique constraint for role name
        if (!role.name) {
          throw new errors.InvalidArgument('argument role name is empty');
        }
        const result = await super.read({
          request: {
            filter: toStruct({
              name: { $eq: role.name }
            })
          }
        }, context);
        if (result && result.items && result.items.length > 0) {
          throw new errors.AlreadyExists(`Role ${role.name} already exists`);
        }
      }
      return super.create(call, context);
    }
  }

  /**
   * Extends ServiceBase.read()
   * @param  {any} call request contains read request
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async read(call: any, context?: any): Promise<any> {
    const readRequest = call.request;
    let subject = await getSubjectFromRedis(call);
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      return await super.read({ request: readRequest });
    }
  }

  /**
   * Extends the generic update operation in order to update any fields
   * @param call
   * @param context
   */
  async update(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for update');
    }

    const items = call.request.items;
    let subject = await getSubjectFromRedis(call);
    // update owner information
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.MODIFY,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      for (let i = 0; i < items.length; i += 1) {
        // read the role from DB and check if it exists
        const role = items[i];
        const filter = toStruct({
          id: { $eq: role.id }
        });
        const roles = await super.read({ request: { filter } }, context);
        if (roles.total_count === 0) {
          throw new errors.NotFound('roles not found for updating');
        }
        const rolesDB = roles.data.items[0];
        // update meta information from existing Object in case if its
        // not provided in request
        if (!role.meta) {
          role.meta = rolesDB.meta;
        } else if (role.meta && _.isEmpty(role.meta.owner)) {
          role.meta.owner = rolesDB.meta.owner;
        }
        // check for ACS if owner information is changed
        if (!_.isEqual(role.meta.owner, rolesDB.meta.owner)) {
          let acsResponse: AccessResponse;
          try {
            acsResponse = await checkAccessRequest(subject, [role], AuthZAction.MODIFY,
              'role', this, undefined, false);
          } catch (err) {
            this.logger.error('Error occurred requesting access-control-srv:', err);
            throw err;
          }
          if (acsResponse.decision != Decision.PERMIT) {
            throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
          }
        }
      }
      return super.update(call, context);
    }
  }

  /**
   * Extends the generic upsert operation in order to upsert any fields
   * @param call
   * @param context
   */
  async upsert(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for upsert');
    }

    let subject = await getSubjectFromRedis(call);
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.MODIFY,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      return super.upsert(call, context);
    }
  }

  /**
   * Endpoint delete, to delete a role or list of roles
   * @param  {any} call request containing list of userIds or collection name
   * @param {any} context
   * @return {} returns empty response
   */
  async delete(call: any, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    let roleIDs = request.ids;
    let resources = {};
    let subject = await getSubjectFromRedis(call);
    let acsResources;
    if (roleIDs) {
      Object.assign(resources, { id: roleIDs });
      acsResources = await this.createMetadata({ id: roleIDs }, AuthZAction.DELETE, subject);
    }
    if (call.request.collection) {
      acsResources = [{ collection: call.request.collection }];
    }
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, AuthZAction.DELETE,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const serviceCall = {
          request: {
            collection: request.collection
          }
        };
        await super.delete(serviceCall, context);
        logger.info('Role collection deleted:');
        return {};
      }
      if (!_.isArray(roleIDs)) {
        roleIDs = [roleIDs];
      }
      logger.silly('deleting Role IDs:', { roleIDs });
      // Check each user exist if one of the user does not exist throw an error
      for (let roleID of roleIDs) {
        const filter = toStruct({
          id: { $eq: roleID }
        });
        const roles = await super.read({ request: { filter } }, context);
        if (roles.total_count === 0) {
          logger.debug('Role does not exist for deleting:', { roleID });
          throw new errors.NotFound(`Role with ${roleID} does not exist for deleting`);
        }
      }
      // delete users
      const serviceCall = {
        request: {
          ids: roleIDs
        }
      };
      await super.delete(serviceCall, context);
      logger.info('Roles deleted:', roleIDs);
      return {};
    }
  }

  /**
   * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
   */
  async createMetadata(res: any, action: string, subject?: Subject): Promise<any> {
    let resources = _.cloneDeep(res);
    let orgOwnerAttributes = [];
    if (!_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    if (subject && subject.scope && (action === AuthZAction.CREATE || action === AuthZAction.MODIFY)) {
      // add user and subject scope as default owner
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization
        },
        {
          id: urns.ownerInstance,
          value: subject.scope
        });
    }

    for (let resource of resources) {
      if (!resource.meta) {
        resource.meta = {};
      }
      if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
        let result = await super.read({
          request: {
            filter: toStruct({
              id: {
                $eq: resource.id
              }
            })
          }
        });
        // update owner info
        if (result.items.length === 1) {
          let item = result.items[0];
          resource.meta.owner = item.meta.owner;
        } else if (result.items.length === 0 && !resource.meta.owner) {
          let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          ownerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user
            },
            {
              id: urns.ownerInstance,
              value: resource.id
            });
          resource.meta.owner = ownerAttributes;
        }
      } else if (action === AuthZAction.CREATE && !resource.meta.owner) {
        let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
        ownerAttributes.push(
          {
            id: urns.ownerIndicatoryEntity,
            value: urns.user
          },
          {
            id: urns.ownerInstance,
            value: resource.id
          });
        resource.meta.owner = ownerAttributes;
      }
    }
    return resources;
  }
}