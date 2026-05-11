import { createServiceConfig } from '@restorecommerce/service-config';
import { createClient, createChannel } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import {
  DeleteRequest,
  Filter_ValueType,
  Filter_Operation
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import {
  UserServiceDefinition,
  UserServiceClient
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';

// Create a ids client instance
let idsClientInstance: UserServiceClient;
const cfg = createServiceConfig(process.cwd());
const getUserServiceClient = (): UserServiceClient => {
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

export const deleteUsersWithExpiredActivation = async (cfg: any, logger: any, events: any, jobPayload: any): Promise<any> => {
  try {
    logger.info('[deleteUsersWithExpiredActivation] jobPayload', jobPayload);

    let jobData: any;
    try {
      jobData = JSON.parse(
        Buffer.from(jobPayload?.value?.data).toString()
      );
    } catch (err) {
      logger.error('[JOB PAYLOAD PARSE FAILED]', { name, err });
      return;
    }
    logger.info('[deleteUsersWithExpiredActivation] jobData', jobData);

    const idsClient = await getUserServiceClient();
    if (!idsClient) {
      logger.error('Identity service client not initialized');
      return { operation_status: { code: 503, message: 'Identity service client not initialized' } };
    }
    const inactivatedAccountExpiry = cfg.get('service:inactivatedAccountExpiry');

    if (inactivatedAccountExpiry === undefined || inactivatedAccountExpiry === 'undefined' || inactivatedAccountExpiry <= 0) {
      logger.error('Invalid inactivatedAccountExpiry configuration');
      return { operation_status: { code: 400, message: 'Invalid inactivatedAccountExpiry configuration' } };
    }

    // Calculate the timestamp threshold for expiration
    const currentTimestamp = new Date().getTime(); // Current Unix timestamp in milliseconds
    const expirationTimestamp = currentTimestamp - inactivatedAccountExpiry * 1000; // Calculate the threshold

    const filters = [{
      filters: [
        {
          field: 'active',
          operation: Filter_Operation.eq,
          value: 'false',
          type: Filter_ValueType.BOOLEAN
        }
      ]
    }];
    let tokenTechUser: any = {};
    const techUsersCfg = cfg.get('techUsers');
    if (techUsersCfg && techUsersCfg.length > 0) {
      tokenTechUser = techUsersCfg?.find((obj: any) => obj.id === 'upsert_user_tokens');
    }

    const users = await idsClient.read({ filters, subject: { token: tokenTechUser.token } }, {});
    logger.info('Retrieved users: ', users);

    const deletingUserFilters =
      jobData.deletingExpiredActivationAccount ?? [];

    logger.info('[deleteUsersWithExpiredActivation] deletingUserFilters', deletingUserFilters);

    if (users?.total_count > 0) {
      const usersToDelete = users?.items?.filter((user) => {
        const payload = user?.payload;

        const hasActivationCode =
          payload?.activation_code !== undefined &&
          payload?.activation_code !== '';

        if (!hasActivationCode) {
          return false;
        }

        // map configured filter names to actual timestamps
        const timestampsToCheck: Array<Date | undefined> = [];

        if (deletingUserFilters.includes('created')) {
          timestampsToCheck.push(payload?.meta?.created);
        }

        if (deletingUserFilters.includes('modified')) {
          timestampsToCheck.push(payload?.meta?.modified);
        }

        if (deletingUserFilters.includes('invited_at')) {
          timestampsToCheck.push(payload?.invited_at);
        }

        // if no valid configured timestamps exist
        if (timestampsToCheck.length === 0) {
          return false;
        }

        // delete if ANY configured timestamp is expired
        return timestampsToCheck.some((timestamp) => {
          if (!timestamp) {
            return false;
          }

          const ts = new Date(timestamp).getTime();

          return ts < expirationTimestamp;
        });
      });

      if (usersToDelete?.length === 0) {
        logger.info('No expired inactivated user accounts found');
        return { operation_status: { code: 200, message: 'No expired inactivated user accounts found' } };
      }

      // Extract user IDs to delete
      const userIDsToDelete = usersToDelete?.map((user) => user?.payload?.id);

      // Call the delete function to delete expired inactivated user accounts
      const deleteStatusArr = await idsClient.delete(DeleteRequest.fromPartial({ ids: userIDsToDelete, subject: { token: tokenTechUser.token } }), {});
      logger.info('Deleted users: ', deleteStatusArr);

      const topic = await events.topic('io.restorecommerce.user');
      for (const user of usersToDelete) {
        const userId = user?.payload?.id;
        const defaultScope = user?.payload?.default_scope;
        await topic.emit('userDeleted', {
          id: userId,
          default_scope: defaultScope
        });

        logger.info('[userDeleted emitted]', { userId, defaultScope });
      }
      return deleteStatusArr;
    }
    else {
      logger.info('No inactivated user accounts found');
      return { operation_status: { code: 200, message: 'No inactivated user accounts found' } };
    }

  } catch (error: any) {
    logger.error('Error in delete_expired_users_job', { code: error.code, message: error.message, stack: error.stack });
    return { operation_status: { code: 500, message: 'Internal Server Error' } };
  }
};
