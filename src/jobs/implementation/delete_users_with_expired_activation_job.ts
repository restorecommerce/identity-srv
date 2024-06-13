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

export const deleteUsersWithExpiredActivation = async (cfg: any, logger: any): Promise<any> => {
  try {
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

    if (users?.total_count > 0) {
      const usersToDelete = users?.items?.filter((user) => {
        if (user?.payload?.meta?.modified !== null && user?.payload?.activation_code !== undefined || user?.payload?.activation_code === '') {
          const modifiedTimestamp = new Date(user.payload.meta.modified).getTime();
          return modifiedTimestamp < expirationTimestamp;
        }
        return false;
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
      return deleteStatusArr;
    }
    else {
      logger.info('No inactivated user accounts found');
      return { operation_status: { code: 200, message: 'No inactivated user accounts found' } };
    }

  } catch (error: any) {
    logger.error('Error in delete_expired_users_job', {code: error.code, message: error.message, stack: error.stack });
    return { operation_status: { code: 500, message: 'Internal Server Error' } };
  }
};
