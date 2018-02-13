import * as co from 'co';
import * as sconfig from '@restorecommerce/service-config';
import * as util from 'util';
import * as _ from 'lodash';
import { Events, Topic } from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { UserService, RoleService } from './service';

const RESET_DONE_EVENT = 'resetResponse';
const RENDER_RESPONSE_EVENT = 'renderResponse';

export class Worker {
  events: Events;
  server: any;
  logger: Logger;
  cfg: any;
  topics: any;
  constructor(cfg?: any) {
    this.cfg = cfg || sconfig(process.cwd());
    this.logger = new Logger(this.cfg.get('logger'));
    this.topics = {};
  }

  async start(): Promise<any> {
    // Load config
    const cfg = this.cfg;
    const logger = this.logger;
    const kafkaCfg = cfg.get('events:kafka');

    // Create a new microservice Server
    const server = new chassis.Server(cfg.get('server'), logger);
    // server.middleware.push(makeLoggingMiddleware());

    // database
    const db = await co(chassis.database.get(cfg.get('database:main'), logger));

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

	  const cis = new UserCommandInterface(server, cfg.get(), logger, events);

    let identityServiceEventListener = async function eventListener(msg: any,
      context: any, config: any, eventName: string): Promise<any> {
      // command events
      await cis.command(msg, context);
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
    logger.verbose('Setting up user and role services');
    const roleService = new RoleService(db, this.topics['roles.resource'], logger, true);
    const userService = new UserService(cfg, this.topics, db, logger, true, roleService);


    await co(server.bind(serviceNamesCfg.user, userService));
    await co(server.bind(serviceNamesCfg.role, roleService));
    await co(server.bind(serviceNamesCfg.cis, cis));

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new chassis.grpc.ServerReflection(transport.$builder, server.config);
    await co(server.bind(reflectionServiceName, reflectionService));

    const hbsTemplates = cfg.get('client:hbs_templates');
    if (hbsTemplates) {
      await userService.setRenderRequestConfigs(hbsTemplates);
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

class UserCommandInterface extends chassis.CommandInterface {
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events) {
    super(server, cfg, logger, events);
  }

  makeResourcesRestoreSetup(db: any, collectionName: string) {
    return {
      unregistered: async function restoreUnregistered(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await co(db.delete(collectionName, { id: message.id }));
        return {};
      },
      usersModified: async function restoreUsersModified(message: any,
        context: any, config: any, eventName: string): Promise<any> {
        await co(db.update(collectionName, { id: message.id }),
          message);
        return {};
      },
      passwordChanged: async function restorePasswordChange(message: any,
        context: any, config: any, eventName: string): Promise<any> {
        await co(db.update(collectionName, { id: message.id }),
          { password_hash: message.password_hash });
        return {};
      },
      activated: async function restoreActivated(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        const patch = {
          active: true,
          activation_code: '',
        };
        await co(db.update(collectionName, { id: message.id }, patch));
        return {};
      },
      registered: async function restoreUsersRegistered(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await co(db.insert(collectionName, message));
        return {};
      },
    };
  }
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

