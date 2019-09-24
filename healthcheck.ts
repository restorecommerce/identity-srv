import * as sconfig from '@restorecommerce/service-config';
import {Logger} from '@restorecommerce/logger';
import {grpcClient} from '@restorecommerce/grpc-client';

const cfg = sconfig(process.cwd());
const logger = new Logger(cfg.get('logger'));

const grpcConfig = cfg.get('server:transports')[0];

grpcConfig['service'] = grpcConfig['services'][cfg.get('serviceNames:cis')];
grpcConfig['protos'] = ['io/restorecommerce/commandinterface.proto'];
grpcConfig['timeout'] = 3000;

const client = new grpcClient(grpcConfig, logger);
const command = client.makeEndpoint('command', 'grpc://' + grpcConfig['addr']);

Object.keys(grpcConfig['services']).forEach(async (service) => {
  const value = new Buffer(JSON.stringify({service})).toString('base64');
  const response = await command({name: 'health_check', payload: {type_url: 'payload', value}});

  if ('data' in response && 'value' in response.data) {
    const decoded = Buffer.from(response.data.value, 'base64').toString();
    const realValue = JSON.parse(decoded);
    if ('status' in realValue) {
      if (realValue.status !== 'SERVING') {
        logger.error(service + ' is down: ' + realValue.status);
        process.exit(1);
      } else {
        logger.info(service + ' is serving');
      }
    } else {
      logger.error('ERR!', realValue);
      process.exit(1);
    }
  } else {
    logger.error('ERR!', response);
    process.exit(1);
  }
});
