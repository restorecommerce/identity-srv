import {
  returnOperationStatus
} from '../utils';

import {
  DeleteRequest,
  ReadRequest,
  Filter_ValueType,
  Filter_Operation
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';

import * as _ from 'lodash';
import { UserService, RoleService } from '../service';
import * as chassis from '@restorecommerce/chassis-srv';
import { ACSAuthZ, initAuthZ, updateConfig, authZ as FallbackAuthZ, initializeCache } from '@restorecommerce/acs-client';

export default async (cfg, logger, events, runWorker) => {
  let topics = {};
  const kafkaCfg = cfg.get('events:kafka');
  const topicTypes = _.keys(kafkaCfg.topics);
  for (let topicType of topicTypes) {
    const topicName = kafkaCfg.topics[topicType].topic;
    topics[topicType] = await events.topic(topicName);
  }

  logger.info('Starting delete_expired_users_job...');
  const authZ = await initAuthZ(cfg) as ACSAuthZ;
  const db = await chassis.database.get(cfg.get('database:main'), logger);
  const roleService = new RoleService(cfg, db, topics['role.resource'], logger, true, authZ);
  const userService = new UserService(cfg, events, db, logger, true, roleService, authZ);
  await runWorker('defaultQueue', 1, cfg, logger, events, async (job) => {

    try {
      const inactivatedAccountExpiry = cfg.get('service:inactivatedAccountExpiry');

      if (inactivatedAccountExpiry === undefined || inactivatedAccountExpiry === 'undefined' || inactivatedAccountExpiry <= 0) {
        logger.error(400, ' Invalid inactivatedAccountExpiry configuration');
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

      const users = await userService.read(ReadRequest.fromPartial({ filters, subject: { token: tokenTechUser.token } }), {});
      const usersToDelete = users.items.filter((user) => {
        if (user.payload.meta.created !== null && user.payload.activation_code !== undefined || user.payload.activation_code === '') {
          const createdTimestamp = new Date(user.payload.meta.created).getTime();
          return createdTimestamp < expirationTimestamp;
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
      const deleteStatusArr = await userService.delete(DeleteRequest.fromPartial({ ids: userIDsToDelete, subject: { token: tokenTechUser.token } }), {});

      return deleteStatusArr;

    } catch (error) {
      logger.error(`Error in delete_expired_users_job: ${error.message}`);
      return returnOperationStatus(500, 'Internal Server Error');
    }
  });
};
