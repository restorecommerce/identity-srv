import { Worker } from './worker.js';

const worker = new Worker();
const logger = worker.logger;
worker.start().then().catch((err) => {
  logger.error('startup error', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  worker.stop().then().catch((err) => {
    logger.error('shutdown error', err);
    process.exit(1);
  });
});
