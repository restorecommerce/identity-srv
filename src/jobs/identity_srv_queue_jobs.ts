import { deleteUsersWithExpiredActivation } from './implementation/delete_users_with_expired_activation_job.js';
const DELETE_USERS_WITH_EXPIRED_ACTIVATION = 'delete-users-with-expired-activation-job';

export default async (cfg, logger, events, runWorker) => {
  await runWorker('identity-srv-queue', 1, cfg, logger, events, async (job) => {
    if (job.type === DELETE_USERS_WITH_EXPIRED_ACTIVATION) {
      await deleteUsersWithExpiredActivation(cfg, logger);
    }
  });
};
