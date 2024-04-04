import * as _ from 'lodash';
import { returnOperationStatus, getUserServiceClient } from './../../utils';
import {
  DeleteRequest,
  Filter_ValueType,
  Filter_Operation
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';

export const deleteUsersWithExpiredActivation = async (cfg: any, logger: any): Promise<any> => {
  try {
    const idsClient = await getUserServiceClient();
    if (!idsClient) {
      logger.error('Identity service client not initialized');
      return returnOperationStatus(503, 'Identity service client not initialized');
    }
    const inactivatedAccountExpiry = cfg.get('service:inactivatedAccountExpiry');

    if (inactivatedAccountExpiry === undefined || inactivatedAccountExpiry === 'undefined' || inactivatedAccountExpiry <= 0) {
      logger.error(400, 'Invalid inactivatedAccountExpiry configuration');
      return returnOperationStatus(400, 'Invalid inactivatedAccountExpiry configuration');
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
      tokenTechUser = _.find(techUsersCfg, { id: 'upsert_user_tokens' });
    }

    const users = await idsClient.read({ filters, subject: { token: tokenTechUser.token } }, {});
    logger.info('Retrieved users: ', users);

    if (users.total_count > 0) {
      const usersToDelete = users.items.filter((user) => {
        if (user.payload.meta.modified !== null && user.payload.activation_code !== undefined || user.payload.activation_code === '') {
          const modifiedTimestamp = new Date(user.payload.meta.modified).getTime();
          return modifiedTimestamp < expirationTimestamp;
        }
        return false;
      });

      if (usersToDelete.length === 0) {
        logger.info('No expired inactivated user accounts found');
        return returnOperationStatus(200, 'No expired inactivated user accounts found');
      }

      // Extract user IDs to delete
      const userIDsToDelete = usersToDelete.map((user) => user.payload.id);

      // Call the delete function to delete expired inactivated user accounts
      const deleteStatusArr = await idsClient.delete(DeleteRequest.fromPartial({ ids: userIDsToDelete, subject: { token: tokenTechUser.token } }), {});
      logger.info('Deleted users: ', deleteStatusArr);
      return deleteStatusArr;
    }
    else {
      logger.info('No inactivated user accounts found');
      return returnOperationStatus(200, 'No inactivated user accounts found');
    }

  } catch (error) {
    logger.error(`Error in delete_expired_users_job: ${error.message}`);
    return returnOperationStatus(500, 'Internal Server Error');
  }
};