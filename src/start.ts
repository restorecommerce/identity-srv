import * as Cluster from '@restorecommerce/cluster-service';

const cfg = require('@restorecommerce/service-config')(process.cwd());
const server = new Cluster(cfg);
server.run('./lib/worker');
process.on('SIGINT', () => {
  server.stop();
});
