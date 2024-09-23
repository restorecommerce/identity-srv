import {
  type DefaultExportFunc
} from '@restorecommerce/scs-jobs';
import {
  deleteUsersWithExpiredActivation
} from './implementation/delete_users_with_expired_activation_job.js';
const DELETE_USERS_WITH_EXPIRED_ACTIVATION = 'delete-users-with-expired-activation-job';

const main: DefaultExportFunc = async (cfg, logger, events: any, runWorker) => {
  await runWorker(
    'identity-srv-queue', 1, cfg, logger, events,
    async (job: any) => {
      const name = job.type ?? job.name;
      if (name === DELETE_USERS_WITH_EXPIRED_ACTIVATION) {
        await deleteUsersWithExpiredActivation(cfg, logger);
      }
    }
  );
};

export default main;
