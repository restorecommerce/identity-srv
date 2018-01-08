import * as co from 'co';
import * as sconfig from '@restorecommerce/service-config';
import * as util from 'util';
import * as _ from 'lodash';
import { Events, Topic } from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import { database, grpc, Server } from '@restorecommerce/chassis-srv';
import { Service } from './service';
import * as rcsi from '@restorecommerce/command-interface';

const RESTORE_CMD_EVENT = 'restoreCommand';
const HEALTH_CMD_EVENT = 'healthCheckCommand';
const HEALTH_RES_EVENT = 'healthCheckResponse';
const RESET_START_EVENT = 'resetCommand';
const RESET_DONE_EVENT = 'resetResponse';
const RENDER_RESPONSE_EVENT = 'identityRenderResponse';

let service: Service;
export class Worker {
  loader: any;
  events: Events;
  server: any;
  logger: Logger;
  cfg: any;
  topics: any;
  constructor(loader?: any, cfg?: any) {
    this.loader = loader;
    if (cfg) {
      this.cfg = cfg
    } else {
      this.cfg = sconfig(process.cwd());
    }

    this.logger = new Logger(this.cfg.get('logger'));
    this.topics = {};
  }

  async start(): Promise<any> {
    // Load config
    const cfg = this.cfg;
    const logger = this.logger;
    const kafkaCfg = cfg.get('events:kafka');
    const userTopic = kafkaCfg.topics.users.topic;
    const commandTopic = kafkaCfg.topics.command.topic;
    const renderingTopic = kafkaCfg.topics.rendering.topic;

    // Create a new microservice Server
    const server = new Server(cfg.get('server'), logger);
    server.middleware.push(makeLoggingMiddleware());

    // database
    logger.verbose('Connecting to GSS');
    const db = await co(database.get(cfg.get('database:main'), logger));

    // topics
    logger.verbose('Setting up topics');
    const events = new Events(cfg.get('events:kafka'), logger);
    await events.start();

    // Enable events firing for resource api using config
    let isEventsEnabled = cfg.get('events:enableEvents');
    if (isEventsEnabled === 'true') {
      isEventsEnabled = true;
    } else { // Undefined means events not enabled
      isEventsEnabled = false;
    }

    // list of service names
    const serviceNamesCfg = cfg.get('serviceNames');
    const validServiceNames = [
      // identit gRPC services
      serviceNamesCfg.user,
      serviceNamesCfg.reflection,
      serviceNamesCfg.cis
    ];

    let identityServiceEventListener = async function eventListener(msg: any,
      context: any, config: any, eventName: string): Promise<any> {
      if (eventName === RESTORE_CMD_EVENT) {
        if (msg && (msg.topics[0].topic === userTopic)) {
          await cis.restore(msg);
        }
      }
      else if (eventName === HEALTH_CMD_EVENT) {
        if (msg && (_.includes(validServiceNames, msg.service))) {
          const serviceStatus = cis.check(msg);
          const healthCheckTopic = events.topic(commandTopic);
          await healthCheckTopic.emit(HEALTH_RES_EVENT,
            serviceStatus);
        }
      }
      else if (eventName === RESET_START_EVENT) {
        const resetStatus = await cis.reset(msg);
        if (resetStatus) {
          const healthCheckTopic = events.topic(commandTopic);
          await healthCheckTopic.emit(RESET_DONE_EVENT,
            resetStatus);
        }
      }
      else if (eventName === RENDER_RESPONSE_EVENT) {
        if (service.emailEnabled) {
          await service.sendEmail(msg);
        }
      }
    };

    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      this.topics[topicType] = events.topic(topicName);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await this.topics[topicType].on(eventName, identityServiceEventListener);
        }
      }
    }

    // user service
    logger.verbose('Setting up user service');
    service = new Service(cfg, this.topics, db, logger, true);
    await co(server.bind(serviceNamesCfg.user, service));

    // Add CommandInterfaceService
    const CommandInterfaceService = rcsi.CommandInterface;
    const userRestoreSetup = makeUserRestoreSetup(db);
    const restoreSetup = {
      [userTopic]: {
        topic: this[userTopic],
        events: userRestoreSetup,
      },
    };
    const cis = new CommandInterfaceService(server, restoreSetup, cfg.get(), logger);
    await co(server.bind(serviceNamesCfg.cis, cis));

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new grpc.ServerReflection(transport.$builder, server.config);
    await co(server.bind(reflectionServiceName, reflectionService));

    const hbsTemplates = cfg.get('client:hbs_templates');
    if (hbsTemplates) {
      await service.setRenderRequestConfigs(this[renderingTopic], hbsTemplates);
    }
    // Start server
    await co(server.start());

    this.events = events;
    this.server = server;
  }

  async stop(): Promise<any> {
    this.logger.info('Shutting down');
    await co(this.server.end());
    await this.events.stop();
  }
}

/**
 * Simple request/response logging middleware.
 */
function makeLoggingMiddleware(): any {
  return async function makeMiddleware(next: any): Promise<any> {
    return async function middleware(call: any, context: any): Promise<any> {
      const request = call.request;
      context.logger.debug(
        util.format('received request to endpoint %s over transport %s',
          context.method, context.transport), request);
      const response = await co(next(call, context));
      context.logger.debug(
        util.format('response for request to endpoint %s over transport %s',
          context.method, context.transport), request, response);
      return response;
    };
  };
}

function makeUserRestoreSetup(db: any): any {
  return {
    unregistered: async function restoreUnregistered(message: any, context: any,
      config: any, eventName: string): Promise<any> {
      await co(db.delete('users', { id: message.id }));
      return {};
    },
    usersModified: async function restoreUsersModified(message: any,
      context: any, config: any, eventName: string): Promise<any> {
      await co(db.update('users', { id: message.id }),
        message);
      return {};
    },
    passwordChanged: async function restorePasswordChange(message: any,
      context: any, config: any, eventName: string): Promise<any> {
      await co(db.update('users', { id: message.id }),
        { password_hash: message.password_hash });
      return {};
    },
    activated: async function restoreActivated(message: any, context: any,
      config: any, eventName: string): Promise<any> {
      const patch = {
        active: true,
        activation_code: '',
      };
      await co(db.update('users', { id: message.id }, patch));
      return {};
    },
    registered: async function restoreUsersRegistered(message: any, context: any,
      config: any, eventName: string): Promise<any> {
      await co(db.insert('users', message));
      return {};
    },
  };
}

if (require.main === module) {
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
}

