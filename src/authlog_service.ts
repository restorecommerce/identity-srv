import * as _ from 'lodash-es';
import * as uuid from 'uuid';
import { ServiceBase, ResourcesAPIBase } from '@restorecommerce/resource-base-interface';
import {
  ACSAuthZ,
  AuthZAction,
  DecisionResponse,
  PolicySetRQResponse,
  Operation
} from '@restorecommerce/acs-client';
import { Topic } from '@restorecommerce/kafka-client';
import { checkAccessRequest, resolveSubject, returnOperationStatus } from './utils.js';
import {
  AuthenticationLogServiceImplementation,
  AuthenticationLogListResponse,
  AuthenticationLogList
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/authentication_log.js';
import {
  DeepPartial, DeleteRequest, DeleteResponse, ReadRequest,
  Resource,
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { Filter_Operation } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';
import { Filter_ValueType } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/filter.js';

export class AuthenticationLogService extends ServiceBase<AuthenticationLogListResponse, AuthenticationLogList> implements AuthenticationLogServiceImplementation {
  cfg: any;
  authZ: ACSAuthZ;

  constructor(cfg: any, db: any, authLogTopic: Topic, logger: any,
    isEventsEnabled: boolean, authZ: ACSAuthZ) {
    let resourceFieldConfig;
    if (cfg.get('fieldHandlers')) {
      resourceFieldConfig = cfg.get('fieldHandlers');
      resourceFieldConfig['bufferFields'] = resourceFieldConfig?.bufferFields?.authentication_logs;
      if (cfg.get('fieldHandlers:timeStampFields')) {
        resourceFieldConfig['timeStampFields'] = [];
        for (const timeStampFiledConfig of cfg.get('fieldHandlers:timeStampFields')) {
          if (timeStampFiledConfig.entities.includes('authentication_logs')) {
            resourceFieldConfig['timeStampFields'].push(...timeStampFiledConfig.fields);
          }
        }
      }
    }
    super('authentication_log', authLogTopic, logger, new ResourcesAPIBase(db, 'authentication_logs', resourceFieldConfig), isEventsEnabled);
    this.authZ = authZ;
    this.cfg = cfg;
  }

  async create(request: AuthenticationLogList, context: any): Promise<DeepPartial<AuthenticationLogListResponse>> {
    if (!request || !request.items || request.items.length == 0) {
      return returnOperationStatus(400, 'No role was provided for creation');
    }

    const subject = await resolveSubject(request.subject);
    request.items = await this.createMetadata(request.items, AuthZAction.CREATE, subject);
    return super.create(request, context);
  }

  /**
   * Extends ServiceBase.read()
   */
  async read(request: ReadRequest, context: any): Promise<DeepPartial<AuthenticationLogListResponse>> {
    const readRequest = request;
    let acsResponse: PolicySetRQResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject: request.subject,
        resources: []
      }, [{ resource: 'authentication_log' }], AuthZAction.READ, Operation.whatIsAllowed) as PolicySetRQResponse;
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv for authentication_log read', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse?.custom_query_args && acsResponse.custom_query_args.length > 0) {
      readRequest.custom_queries = acsResponse.custom_query_args[0].custom_queries;
      readRequest.custom_arguments = acsResponse.custom_query_args[0].custom_arguments;
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      return super.read(readRequest, context);
    }
  }

  /**
   * Extends the generic update operation in order to update any fields
   */
  async update(request: AuthenticationLogList, context: any): Promise<DeepPartial<AuthenticationLogListResponse>> {
    if (_.isNil(request) || _.isNil(request.items) || _.isEmpty(request.items)) {
      return returnOperationStatus(400, 'No items were provided for update');
    }

    // update owners information
    const subject = await resolveSubject(request.subject);
    const items = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: items
      }, [{ resource: 'authentication_log', id: items.map(e => e.id) }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv for authentication_log update', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      for (let i = 0; i < items?.length; i += 1) {
        // read the role from DB and check if it exists
        const auth_log = items[i];
        const filters = [{
          filters: [{
            field: 'id',
            operation: Filter_Operation.eq,
            value: auth_log.id,
          }],
        }];
        const auth_logs = await super.read(ReadRequest.fromPartial({ filters }), context);
        if (auth_logs?.total_count === 0) {
          return returnOperationStatus(400, 'roles not found for updating');
        }
        const authLogDB = auth_logs?.items[0];
        // update meta information from existing Object in case if its
        // not provided in request
        if (!auth_log?.meta) {
          auth_log.meta = authLogDB?.payload?.meta;
        } else if (auth_log.meta && _.isEmpty(auth_log?.meta?.owners)) {
          auth_log.meta.owners = authLogDB?.payload?.meta?.owners;
        }
        // check for ACS if owners information is changed
        if (!_.isEqual(auth_log?.meta?.owners, authLogDB?.payload?.meta?.owners)) {
          let acsResponse: DecisionResponse;
          try {
            if (!context) { context = {}; };
            context.subject = request.subject;
            context.resources = auth_log;
            acsResponse = await checkAccessRequest({
              ...context,
              subject: request.subject,
              resources: auth_log
            }, [{ resource: 'authentication_log', id: auth_log.id }], AuthZAction.MODIFY, Operation.isAllowed, false);
          } catch (err: any) {
            this.logger.error('Error occurred requesting access-control-srv for authentication_log update', err);
            return returnOperationStatus(err.code, err.message);
          }
          if (acsResponse.decision != Response_Decision.PERMIT) {
            return { operation_status: acsResponse.operation_status };
          }
        }
      }
      return super.update(request, context);
    }
  }

  /**
   * Extends the generic upsert operation in order to upsert any fields
   */
  async upsert(request: AuthenticationLogList, context: any): Promise<DeepPartial<AuthenticationLogListResponse>> {
    if (_.isNil(request) || _.isNil(request.items) || _.isEmpty(request.items)) {
      return returnOperationStatus(400, 'No items were provided for upsert');
    }

    const subject = await resolveSubject(request.subject);
    request.items = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: request.items
      }, [{ resource: 'authentication_log', id: request?.items?.map(e => e?.id) }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv for authentication_log upsert', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      return super.upsert(request, context);
    }
  }

  /**
   * Endpoint delete, to delete a role or list of roles
   */
  async delete(request: DeleteRequest, context: any): Promise<DeepPartial<DeleteResponse>> {
    const logger = this.logger;
    const authLogIDs = request.ids;
    const resources = {};
    let acsResources;
    const subject = await resolveSubject(request.subject);
    if (authLogIDs) {
      Object.assign(resources, { id: authLogIDs });
      acsResources = await this.createMetadata<any>({ id: authLogIDs }, AuthZAction.DELETE, subject);
    }
    if (request?.collection) {
      acsResources = [{ collection: request.collection }];
    }
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject: request.subject,
        resources: acsResources
      }, [{ resource: 'authentication_log', id: authLogIDs }], AuthZAction.DELETE, Operation.isAllowed);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv for authentication_log delete', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const deleteResponse = await super.delete({ collection: request.collection, ids: undefined, views: [], analyzers: [] }, context);
        logger.info('AuthenticationLog collection deleted:');
        return deleteResponse;
      }
      logger.silly('deleting Role IDs:', { authLogIDs });
      // Check each user exist if one of the user does not exist throw an error
      for (const authLogID of authLogIDs || []) {
        const filters = [{
          filters: [{
            field: 'id',
            operation: Filter_Operation.eq,
            value: authLogID
          }]
        }];
        const roles = await super.read(ReadRequest.fromPartial({ filters }), context);
        if (roles.total_count === 0) {
          logger.debug('AuthLog does not exist for deleting:', { authLogID });
          return returnOperationStatus(400, `AuthLog with ${authLogID} does not exist for deleting`);
        }
      }
      // delete users
      const deleteResponse = await super.delete({ ids: authLogIDs, collection: undefined, views: [], analyzers: [] }, context);
      logger.info('AuthenticationLogs deleted:', { authLogIDs });
      return deleteResponse;
    }
  }

  /**
   * reads meta data from DB and updates owners information in resource if action is UPDATE / DELETE
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
   */
  async createMetadata<T extends Resource>(resources: T | T[], action: string, subject?: Subject): Promise<T[]> {
    const urns = this.cfg.get('authorization:urns');
    if (!Array.isArray(resources)) {
      resources = [resources];
    }

    const setDefaultMeta = (resource: T) => {
      if (!resource.id?.length) {
        resource.id = uuid.v4().replace(/-/g, '');
      }

      if (!resource.meta) {
        resource.meta = {};
        resource.meta.owners = [];

        if (subject?.scope) {
          resource.meta.owners.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.organization,
              attributes: [{
                id: urns.ownerInstance,
                value: subject.scope
              }]
            }
          );
        }

        if (subject?.id) {
          resource.meta.owners.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user,
              attributes: [{
                id: urns.ownerInstance,
                value: subject.id
              }]
            }
          );
        }
      }
    };

    if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
      const ids = [
        ...new Set(
          resources.map(
            r => r.id
          ).filter(
            id => id
          )
        ).values()
      ];
      const filters = ReadRequest.fromPartial({
        filters: [
          {
            filters: [
              {
                field: 'id',
                operation: Filter_Operation.in,
                value: JSON.stringify(ids),
                type: Filter_ValueType.ARRAY
              }
            ]
          }
        ],
        limit: ids.length
      });

      const result_map = await super.read(filters, {}).then(
        resp => new Map(
          resp.items?.map(
            item => [item.payload?.id, item?.payload]
          )
        )
      );

      for (const resource of resources) {
        if (!resource.meta && result_map.has(resource?.id)) {
          resource.meta = result_map.get(resource?.id).meta;
        }
        else {
          setDefaultMeta(resource);
        }
      }
    }
    else if (action === AuthZAction.CREATE) {
      for (const resource of resources) {
        setDefaultMeta(resource);
      }
    }

    return resources;
  }
}
