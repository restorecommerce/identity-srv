import * as co from 'co';
import * as sconfig from '@restorecommerce/service-config';
import * as util from 'util';
import * as _ from 'lodash';
import { Events, Topic } from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { UserService, RoleService } from './service';

const RENDER_RESPONSE_EVENT = 'renderResponse';

export class Worker {
  events: Events;
  server: any;
  logger: Logger;
  cfg: any;
  topics: any;
  offsetStore: chassis.OffsetStore;
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

    // list of service names
    const serviceNamesCfg = cfg.get('serviceNames');
    const validServiceNames = [
      // identit gRPC services
      serviceNamesCfg.user,
      serviceNamesCfg.reflection,
      serviceNamesCfg.cis,
      serviceNamesCfg.role
    ];

    const serviceCfg = cfg.get('service');
    if (!serviceCfg.register) {
      // disabling register-related operations
      // only raw 'create' operations are allowed in this case
      logger.warn('Register flag is set to false. User registry-related operations are disabled.');

      const userServiceCfg = cfg.get(`server`);
      delete userServiceCfg.services[serviceNamesCfg.user].register;
      delete userServiceCfg.services[serviceNamesCfg.user].activate;
      delete userServiceCfg.services[serviceNamesCfg.user].unregister;

      cfg.set(`server`, userServiceCfg);
      this.cfg = cfg;
    }

    const server = new chassis.Server(cfg.get('server'), logger);

    // database
    const db = await co(chassis.database.get(cfg.get('database:main'), logger));

    // topics
    logger.verbose('Setting up topics');
    const events = new Events(cfg.get('events:kafka'), logger);
    await events.start();
    this.offsetStore = new chassis.OffsetStore(events, cfg, logger);

    // Enable events firing for resource api using config
    let isEventsEnabled = cfg.get('events:enableEvents');
    if (isEventsEnabled === 'true') {
      isEventsEnabled = true;
    } else { // Undefined means events not enabled
      isEventsEnabled = false;
    }

    const cis = new UserCommandInterface(server, cfg.get(), logger, events);

    let identityServiceEventListener = async function eventListener(msg: any,
      context: any, config: any, eventName: string): Promise<any> {
      if (eventName === RENDER_RESPONSE_EVENT) {
        if (userService.emailEnabled) {
          await userService.sendEmail(msg);
        }
      } else {
        // command events
        await cis.command(msg, context);
      }
    };

    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      this.topics[topicType] = events.topic(topicName);
      const offSetValue = await this.offsetStore.getOffset(topicName);
      logger.info('subscribing to topic with offset value', topicName, offSetValue);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await this.topics[topicType].on(eventName,
            identityServiceEventListener, offSetValue);
        }
      }
    }

    // user service
    logger.verbose('Setting up user and role services');
    const roleService = new RoleService(db,
      this.topics['role.resource'], logger, true);
    const userService = new UserService(cfg,
      this.topics, db, logger, true, roleService);

    await server.bind(serviceNamesCfg.user, userService);
    await server.bind(serviceNamesCfg.role, roleService);
    await server.bind(serviceNamesCfg.cis, cis);

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new chassis.grpc.ServerReflection(transport.$builder, server.config);
    await server.bind(reflectionServiceName, reflectionService);

    const hbsTemplates = cfg.get('client:hbs_templates');
    if (hbsTemplates && cfg.get('service:enableEmail')) {
      await userService.setRenderRequestConfigs(hbsTemplates);
    } else {
      logger.info('Email sending is disabled');
    }
    // Start server
    await server.start();

    this.events = events;
    this.server = server;
  }

  async stop(): Promise<any> {
    this.logger.info('Shutting down');
    await this.server.stop();
    await this.events.stop();
    await this.offsetStore.stop();
  }
}

class UserCommandInterface extends chassis.CommandInterface {
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events) {
    super(server, cfg, logger, events);
  }

  makeResourcesRestoreSetup(db: any, collectionName: string) {
    return {
      unregistered: async function restoreUnregistered(message: any,
        eventName: string): Promise<any> {
        await co(db.delete(collectionName, { id: message.id }));
        return {};
      },
      usersModified: async function restoreUsersModified(message: any,
        eventName: string): Promise<any> {
        await co(db.update(collectionName, { id: message.id }),
          message);
        return {};
      },
      activated: async function restoreActivated(message: any,
        eventName: string): Promise<any> {
        const patch = {
          active: true,
          activation_code: '',
        };
        await co(db.update(collectionName, { id: message.id }, patch));
        return {};
      },
      registered: async function restoreUsersRegistered(message: any,
        eventName: string): Promise<any> {
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

