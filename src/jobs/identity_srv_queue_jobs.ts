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
      let jobPayload: any;
      try {
        jobPayload = JSON.parse(job?.data?.payload?.value?.toString());
      } catch (err) {
        logger.error('[JOB PAYLOAD PARSE FAILED]', { name, err });
        return;
      }
      logger.info('[JOB RECEIVED]', {name});
      if (name === DELETE_USERS_WITH_EXPIRED_ACTIVATION) {
        logger.info('[DELETE_USERS_WITH_EXPIRED_ACTIVATION] started');
        await deleteUsersWithExpiredActivation(cfg, logger, events, jobPayload);
        logger.info('[DELETE_USERS_WITH_EXPIRED_ACTIVATION] finished');
      }
    }
  );
};

export default main;
