import * as sconfig from '@restorecommerce/service-config';
import * as _ from 'lodash';
import { Events } from '@restorecommerce/kafka-client';
import { Logger } from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { UserService, RoleService } from './service';
import { ACSAuthZ, initAuthZ, updateConfig, initializeCache } from '@restorecommerce/acs-client';
import { RedisClient, createClient } from 'redis';

const RENDER_RESPONSE_EVENT = 'renderResponse';
const CONTRACT_CANCELLED = 'contractCancelled';

class UserCommandInterface extends chassis.CommandInterface {
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events, redisClient: RedisClient) {
    super(server, cfg, logger, events, redisClient);
  }

  makeResourcesRestoreSetup(db: any, resource: string): any {
    const that = this;
    return {
      unregistered: async function restoreUnregistered(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        try {
          await db.delete(`${resource}s`, { id: message.id });
        } catch (err) {
          that.logger.error('Exception caught while restoring unregistered User',
            message);
        }
        return {};
      },
      userModified: async function restoreUsersModified(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        try {
          await db.update(`${resource}s`, { id: message.id },
            message);
        } catch (err) {
          that.logger.error('Exception caught while restoring modified User',
            message);
        }
        return {};
      },
      registered: async function restoreUsersRegistered(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        try {
          await db.insert(`${resource}s`, message);
        } catch (err) {
          that.logger.error('Exception caught while restoring registered User',
            message);
        }
        return {};
      },
      userCreated: async function restoreUsersCreated(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        try {
          await db.insert(`${resource}s`, message);
        } catch (err) {
          that.logger.error('Exception caught while restoring registered User',
            message);
        }
        return {};
      },
    };
  }

  async setApiKey(payload: any): Promise<any> {
    const commandResponse = await super.setApiKey(payload);
    updateConfig(this.config);
    return commandResponse;
  }

  async configUpdate(payload: any): Promise<any> {
    const commandResponse = await super.configUpdate(payload);
    updateConfig(this.config);
    return commandResponse;
  }
}

export class Worker {
  events: Events;
  server: any;
  logger: chassis.Logger;
  cfg: any;
  topics: any;
  offsetStore: chassis.OffsetStore;
  userService: UserService;
  authZ: ACSAuthZ;
  redisClient: RedisClient;
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
    const db = await chassis.database.get(cfg.get('database:main'), logger);

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

    let authZ = await initAuthZ(this.cfg) as ACSAuthZ;
    this.authZ = authZ;

    // init redis client for subject index
    const redisConfig = cfg.get('redis');
    redisConfig.db = this.cfg.get('redis:db-indexes:db-subject');
    this.redisClient = createClient(redisConfig);

    // init ACS cache
    initializeCache();

    const cis = new UserCommandInterface(server, this.cfg, logger, events, this.redisClient);

    const identityServiceEventListener = async (msg: any,
      context: any, config: any, eventName: string) => {
      if (eventName === RENDER_RESPONSE_EVENT) {
        if (this.userService.emailEnabled) {
          await this.userService.sendEmail(msg);
        }
      } else if (eventName === CONTRACT_CANCELLED) {
        const contractID = msg.id;
        const organization_ids = msg.organization_ids;
        logger.info('Deactivating users for Contract ID:',
          { id: contractID });
        // Update users to deactive
        await this.userService.disableUsers(organization_ids);
      }
      else {
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
            identityServiceEventListener, { startingOffset: offSetValue });
        }
      }
    }

    // user service
    logger.verbose('Setting up user and role services');
    const roleService = new RoleService(cfg, db,
      this.topics['role.resource'], logger, true, this.authZ);
    const userService = new UserService(cfg,
      this.topics, db, logger, true, roleService, this.authZ);
    this.userService = userService;

    await server.bind(serviceNamesCfg.user, userService);
    await server.bind(serviceNamesCfg.role, roleService);
    await server.bind(serviceNamesCfg.cis, cis);

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new chassis.grpc.ServerReflection(transport.$builder, server.config);
    await server.bind(reflectionServiceName, reflectionService);

    const hbsTemplates = cfg.get('service:hbs_templates');
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

