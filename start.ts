'use strict';
import * as Cluster from '@restorecommerce/cluster-service';
import * as co from 'co';

const cfg = require('@restorecommerce/service-config')(process.cwd());
const server = new Cluster(cfg);
server.run('./worker');
