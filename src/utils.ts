import {
  AuthZAction, accessRequest, DecisionResponse, Operation, PolicySetRQResponse, ACSClientContext
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createClient, createChannel } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import * as bcrypt from 'bcryptjs';
import {
  DeepPartial,
  FilterOp, FilterOp_Operator,
  Filter_Operation
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';
import {
  UserServiceDefinition,
  UserServiceClient
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth';
import { FilterOpts, JobType, KafkaOpts, Priority } from './types';
import { createClient as createRedisClient } from 'redis';
import { Events } from '@restorecommerce/kafka-client';
import { Logger } from 'winston';
import { Processor } from 'bullmq';
import { JobsOptions, Worker } from 'bullmq';
import { Data } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job';

// Create a ids client instance
let idsClientInstance: UserServiceClient;
const getUserServiceClient = (): UserServiceClient => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    const logger = createLogger(loggerCfg);
    if (grpcIDSConfig) {
      const channel = createChannel(grpcIDSConfig.address);
      idsClientInstance = createClient({
        ...grpcIDSConfig,
        logger
      }, UserServiceDefinition, channel);
    }
  }
  return idsClientInstance;
};

export interface Resource {
  resource: string;
  id?: string | string[]; // for what is allowed operation id is not mandatory
  property?: string[];
}

export interface Attribute {
  id: string;
  value: string;
  attributes: Attribute[];
}

export interface CtxResource {
  id: string;
  meta: {
    created?: number;
    modified?: number;
    modified_by?: string;
    owners: Attribute[]; // id and owner is mandatory in ctx resource other attributes are optional
  };
  [key: string]: any;
}

export interface GQLClientContext {
  // if subject is missing by default it will be treated as unauthenticated subject
  subject?: Subject;
  resources?: CtxResource[];
}

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction,
  operation: Operation, useCache = true): Promise<DecisionResponse | PolicySetRQResponse> {
  let subject = ctx.subject;
  let dbSubject;
  // resolve subject id using findByToken api and update subject with id
  if (subject && subject.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ token: subject.token });
      if (dbSubject && dbSubject.payload && dbSubject.payload.id) {
        subject.id = dbSubject.payload.id;
      }
    }
  }

  let result: DecisionResponse | PolicySetRQResponse;
  try {
    result = await accessRequest(subject, resource, action, ctx, operation, 'arangoDB', useCache);
  } catch (err) {
    return {
      decision: Response_Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  return result;
}

export const password = {
  hash: (pw): string => {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(pw, salt);
    return hash;
  },
  verify: (password_hash, pw) => {
    return bcrypt.compareSync(pw, password_hash);
  }
};

export const marshallProtobufAny = (msg: any): any => {
  return {
    type_url: 'identity.rendering.renderRequest',
    value: Buffer.from(JSON.stringify(msg))
  };
};

export const unmarshallProtobufAny = (msg: any, logger: any): any => {
  try {
    if (msg.value) {
      return JSON.parse(msg.value.toString());
    }
  } catch (error) {
    logger.error('Error unmarshalling JSON', msg);
  }
};

export const getDefaultFilter = (identifier): DeepPartial<FilterOp[]> => {
  return [{
    filters: [
      {
        field: 'name',
        operation: Filter_Operation.eq,
        value: identifier
      },
      {
        field: 'email',
        operation: Filter_Operation.eq,
        value: identifier
      }],
    operator: FilterOp_Operator.or
  }];
};

export const getNameFilter = (userName) => {
  return [{
    filters: [{
      field: 'name',
      operation: Filter_Operation.eq,
      value: userName
    }]
  }];
};

export const getLoginIdentifierFilter = (loginIdentifiers, value) => {
  if (typeof loginIdentifiers === 'string') {
    return [{
      filters: [{
        field: loginIdentifiers,
        operation: Filter_Operation.eq,
        value
      }]
    }];
  } else if (_.isArray(loginIdentifiers)) {
    let filters = [{ filters: [], operator: FilterOp_Operator.or }];
    for (let identifier of loginIdentifiers) {
      filters[0].filters.push(
        {
          field: identifier,
          operation: Filter_Operation.eq,
          value
        });
    }
    return filters;
  }
};

export const returnOperationStatus = (code: number, message: string) => {
  if (!code) {
    code = 500; // defaults to internal server error if no code is provided
  }
  return {
    operation_status: {
      code,
      message
    }
  };
};

export const returnStatus = (code: number, message: string, id?: string) => {
  if (!code) {
    code = 500; // defaults to internal server error if no code is provided
  }
  return {
    status: {
      id,
      code,
      message
    }
  };
};

export const returnCodeMessage = (code: number, message: string) => {
  if (!code) {
    code = 500; // defaults to internal server error if no code is provided
  }
  return {
    code,
    message
  };
};

interface CodeIdMsgObj {
  code: number;
  message: string;
  id?: string;
}

export const returnStatusArray = (codeIdMsgObj: CodeIdMsgObj[]) => {
  let statusArray = { status: [] };
  for (let codeMsgObj of codeIdMsgObj) {
    statusArray.status.push(codeMsgObj);
  }
  return statusArray;
};

/**
 * accessResponse returned from `acs-client` contains the filters for the list of
 * resources requested and it returns resource filter map, below api
 * returns applicable `Filters[]` for the specified resource, it iterates through
 * the ACS response and returns the applicable `Filters[]` for the resource.
 * @param accessResponse ACS response
 * @param enitity enitity name
 */
export const getACSFilters = (accessResponse: PolicySetRQResponse, resource: string): FilterOp[] => {
  let acsFilters = [];
  const resourceFilterMap = accessResponse?.filters;
  const resourceFilter = resourceFilterMap?.filter((e) => e?.resource === resource);
  // for a given entity there should be one filter map
  if (resourceFilter?.length === 1 && resourceFilter[0]?.filters[0]?.filters?.length > 0) {
    acsFilters = resourceFilter[0].filters;
  }
  return acsFilters;
};

// node-fetch is now ESM only module
// prevent TypeScript rewrite of async import() to require() in CJS projects
const _importDynamic = new Function('modulePath', 'return import(modulePath)');

export async function fetch(...args) {
  const { default: fetch } = await _importDynamic('node-fetch');
  return fetch(...args);
}


export function _filterJobData(data: Data, encode: boolean, logger: Logger): Pick<Data, 'meta' | 'payload' | 'subject_id'> {
  const picked = _.pick(data, [
    'meta', 'payload', 'subject_id'
  ]);

  if (encode) {
    if (picked?.payload?.value && typeof picked.payload.value === 'string') {
      (picked as any).payload = marshallProtobufAny(unmarshallProtobufAny(picked.payload, logger));
    }
  }

  if(picked?.meta?.created && typeof picked.meta.created === 'string') {
    picked.meta.created = new Date(picked.meta.created);
  }

  if(picked?.meta?.modified && typeof picked.meta.modified === 'string') {
    picked.meta.modified = new Date(picked.meta.modified);
  }

  return picked as any;
}


export function _filterQueuedJob<T extends FilterOpts>(job: T, logger: Logger): Pick<T, 'id' | 'type' | 'data' | 'opts' | 'name'> {
  if (job && !job.type) {
    (job as any).type = (job as any).name;
  }
  const picked: any = _.pick(job, [
    'id', 'type', 'data', 'opts', 'name'
  ]);

  if (picked?.data) {
    picked.data = _filterJobData(picked.data, false, logger);
    if (picked?.data?.payload?.value) {
      picked.data.payload.value = Buffer.from(picked.data.payload.value);
    }
  }

  return picked as any;
}

export async function runWorker(queue: string, concurrency: number, cfg: any, logger: Logger, events: Events, cb: Processor): Promise<Worker> {
  // Get a redis connection
  const redisConfig = cfg.get('redis');
  // below config is used for bull queu options and it still uses db config
  redisConfig.db = cfg.get('redis:db-indexes:db-jobStore');

  const reccurTimeCfg = cfg.get('redis');
  reccurTimeCfg.database = cfg.get('redis:db-indexes:db-reccurTime');
  const redisClient = createRedisClient(reccurTimeCfg);
  redisClient.on('error', (err) => logger.error('Redis client error in recurring time store', err));
  await redisClient.connect();

  if ('keyPrefix' in redisConfig) {
    delete redisConfig.keyPrefix;
  }

  const jobEvents = await events.topic('io.restorecommerce.jobs');

  const redisURL = new URL(redisConfig.url);
  const worker = new Worker(queue, async job => {
    const filteredJob = _filterQueuedJob<JobType>(job as any, logger);
    // For recurring job add time so if service goes down we can fire jobs
    // for the missed schedules comparing the last run time
    let lastRunTime;
    if (filteredJob?.opts?.repeat &&
      ((filteredJob.opts.repeat as any).every ||
        (filteredJob.opts.repeat as any).cron)) {
      if (filteredJob?.data) {
        // adding time to payload data for recurring jobs
        const dateTime = new Date();
        lastRunTime = JSON.stringify({ time: dateTime });
        const bufObj = Buffer.from(JSON.stringify({ time: dateTime }));
        if (filteredJob?.data?.payload) {
          if (filteredJob?.data?.payload?.value) {
            let jobBufferObj;
            try {
              jobBufferObj = JSON.parse(filteredJob.data.payload.value.toString());
            } catch (error) {
              logger.error('Error parsing job payload', {
                code: error.code,
                message: error.message, stack: error.stack
              });
            }

            if (!jobBufferObj) {
              jobBufferObj = {};
            }
            const jobTimeObj = Object.assign(jobBufferObj, { time: dateTime });
            // set last run time on DB index 7 with jobType identifier
            await redisClient.set(filteredJob.name, lastRunTime);
            filteredJob.data.payload.value = Buffer.from(JSON.stringify(jobTimeObj));
          } else {
            await redisClient.set(filteredJob.name, lastRunTime);
            filteredJob.data.payload = { value: bufObj, type_url: '' };
          }
        } else {
          await redisClient.set(filteredJob.name, lastRunTime);
          filteredJob.data = {
            subject_id: filteredJob.data.subject_id,
            payload: { value: bufObj, type_url: '' }
          };
        }
      }
    }

    logger.verbose(`job@${filteredJob.name}#${filteredJob.id} started execution`, filteredJob);
    const start = Date.now();
    const result = await cb(job);
    logger.verbose(`job@${filteredJob.name}#${filteredJob.id} completed in ${Date.now() - start}ms`, filteredJob);

    await jobEvents.emit('jobDone', {
      id: job.id, type: job.name, schedule_type: job.data.schedule_type, ...result
    });

    return result;
  }, {
    connection: {
      ...redisConfig,
      host: redisURL.hostname,
      port: parseInt(redisURL.port)
    },
    concurrency,
    autorun: false
  });

  worker.on('error', err => logger.error(`worker#${queue} error`, err));
  worker.on('closed', () => logger.verbose(`worker#${queue} closed`));
  worker.on('progress', (j, p) => logger.debug(`worker#${queue} job#${j.id} progress`, p));
  worker.on('failed', (j, err) => logger.error(`worker#${queue} job#${j.id} failed`, err));
  worker.on('closing', msg => logger.verbose(`worker#${queue} closing: ${msg}`));
  worker.on('completed', j => logger.info(`worker#${queue} job#${j.id} completed`));
  worker.on('stalled', j => logger.warn(`worker#${queue} job#${j} stalled`));
  worker.on('drained', () => logger.verbose(`worker#${queue} drained`));
  worker.on('paused', () => logger.verbose(`worker#${queue} paused`));
  worker.on('ready', () => logger.verbose(`worker#${queue} ready`));
  worker.on('resumed', () => logger.verbose(`worker#${queue} resumed`));

  worker.run().catch(err => logger.error(`worker#${queue} run error`, err));
  await worker.waitUntilReady();

  return worker;
}
