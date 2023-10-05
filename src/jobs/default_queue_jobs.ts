import { deleteUsersWithExpiredActivation } from './implementation/delete_users_with_expired_activation_job';

export default async (cfg, logger, events, runWorker) => {
  await runWorker('defaultQueue', 1, cfg, logger, events, async (job) => {
    if (job.type === 'DELETE_USERS_WITH_EXPIRED_ACTIVATION') {
      await deleteUsersWithExpiredActivation(cfg, logger);
    }
  });
};
