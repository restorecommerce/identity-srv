import {
  getDefaultFilter,
  returnOperationStatus
} from '../utils';

import {
  DeleteRequest,
  ReadRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';

import { UserService } from '../service';

export default async (cfg, logger, events, runWorker) => {
  logger.info('Starting delete_expired_users_job...');

  await runWorker('job', 1, cfg, logger, events, async (job) => {
    try {
      const userService = new UserService(cfg, events, job.db, logger, true, job.role, job.auth_context);
      const subject = job.subject;
      const inactivatedAccountExpiry = cfg.get('service:inactivatedAccountExpiry');

      if (inactivatedAccountExpiry === undefined || inactivatedAccountExpiry <= 0) {
        return returnOperationStatus(400, 'Invalid inactivatedAccountExpiry configuration');
      }

      // Calculate the timestamp threshold for expiration
      const currentTimestamp = new Date().getTime(); // Current Unix timestamp in milliseconds
      const expirationTimestamp = currentTimestamp - inactivatedAccountExpiry * 1000; // Calculate the threshold

      // Fetch inactivated user accounts with expired activation codes
      const filters = getDefaultFilter('inactivated'); // Replace 'inactivated' with an appropriate filter for your inactive users
      const users = await userService.read(ReadRequest.fromPartial({ filters }), context);

      const usersToDelete = users.items.filter((user) => {
        if (user.payload.meta.created) {
          const activationTimestamp = new Date(user.payload.meta.created).getTime();
          return activationTimestamp < expirationTimestamp;
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
      const deleteStatusArr = await userService.delete(DeleteRequest.fromPartial({ ids: userIDsToDelete }), { subject });

      return deleteStatusArr;

    } catch (error) {
      logger.error(`Error in delete_expired_users_job: ${error.message}`);
      return returnOperationStatus(500, 'Internal Server Error');
    }
  });
};
