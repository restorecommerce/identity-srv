import { ServiceBase, ResourcesAPIBase, toStruct } from '@restorecommerce/resource-base-interface';
import { Logger, errors } from '@restorecommerce/chassis-srv';
import { ACSAuthZ, PermissionDenied, AuthZAction, Decision, Subject } from '@restorecommerce/acs-client';
import { Topic } from '@restorecommerce/kafka-client';
import { AccessResponse, ReadPolicyResponse, checkAccessRequest } from './utils';
import * as _ from 'lodash';

export class AuthenticationLogService extends ServiceBase {
  logger: Logger;
  cfg: any;
  authZ: ACSAuthZ;
  constructor(cfg: any, db: any, authLogTopic: Topic, logger: any,
    isEventsEnabled: boolean, authZ: ACSAuthZ) {
    super('authentication_log', authLogTopic, logger, new ResourcesAPIBase(db, 'authentication_logs'), isEventsEnabled);
    this.logger = logger;
    this.authZ = authZ;
    this.cfg = cfg;
  }

  async create(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.items || call.request.items.length == 0) {
      throw new errors.InvalidArgument('No role was provided for creation');
    }

    let subject = call.request.subject;
    call.request.items = await this.createMetadata(call.request.items, AuthZAction.CREATE, subject);
    return super.create(call, context);
  }

  /**
   * Extends ServiceBase.read()
   * @param  {any} call request contains read request
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async read(call: any, context?: any): Promise<any> {
    const readRequest = call.request;
    let subject = call.request.subject;
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        'authentication_log', this);
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

    let items = call.request.items;
    let subject = call.request.subject;
    // update owner information
    items = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, items, AuthZAction.MODIFY,
        'authentication_log', this);
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
        const auth_log = items[i];
        const filter = toStruct({
          id: { $eq: auth_log.id }
        });
        const auth_logs = await super.read({ request: { filter } }, context);
        if (auth_logs.total_count === 0) {
          throw new errors.NotFound('roles not found for updating');
        }
        const authLogDB = auth_logs.data.items[0];
        // update meta information from existing Object in case if its
        // not provided in request
        if (!auth_log.meta) {
          auth_log.meta = authLogDB.meta;
        } else if (auth_log.meta && _.isEmpty(auth_log.meta.owner)) {
          auth_log.meta.owner = authLogDB.meta.owner;
        }
        // check for ACS if owner information is changed
        if (!_.isEqual(auth_log.meta.owner, authLogDB.meta.owner)) {
          let acsResponse: AccessResponse;
          try {
            acsResponse = await checkAccessRequest(subject, [auth_log], AuthZAction.MODIFY,
              'authentication_log', this, undefined, false);
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

    let subject = call.request.subject;
    call.reqeust.items = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request.items, AuthZAction.MODIFY,
        'authentication_log', this);
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
    let authLogIDs = request.ids;
    let resources = {};
    let subject = call.request.subject;
    let acsResources;
    if (authLogIDs) {
      Object.assign(resources, { id: authLogIDs });
      acsResources = await this.createMetadata({ id: authLogIDs }, AuthZAction.DELETE, subject);
    }
    if (call.request.collection) {
      acsResources = [{ collection: call.request.collection }];
    }
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, AuthZAction.DELETE,
        'authentication_log', this);
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
        logger.info('AuthenticationLog collection deleted:');
        return {};
      }
      if (!_.isArray(authLogIDs)) {
        authLogIDs = [authLogIDs];
      }
      logger.silly('deleting Role IDs:', { authLogIDs });
      // Check each user exist if one of the user does not exist throw an error
      for (let authLogID of authLogIDs) {
        const filter = toStruct({
          id: { $eq: authLogID }
        });
        const roles = await super.read({ request: { filter } }, context);
        if (roles.total_count === 0) {
          logger.debug('AuthLog does not exist for deleting:', { authLogID });
          throw new errors.NotFound(`AuthLog with ${authLogID} does not exist for deleting`);
        }
      }
      // delete users
      const serviceCall = {
        request: {
          ids: authLogIDs
        }
      };
      await super.delete(serviceCall, context);
      logger.info('AuthenticationLogs deleted:', { authLogIDs });
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
              value: subject.id
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
            value: subject.id
          });
        resource.meta.owner = ownerAttributes;
      }
    }
    return resources;
  }
}