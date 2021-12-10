import { createServiceConfig } from '@restorecommerce/service-config';
import * as _ from 'lodash';
import { Events } from '@restorecommerce/kafka-client';
import { createLogger } from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { Logger } from 'winston';
import { UserService, RoleService } from './service';
import { ACSAuthZ, initAuthZ, updateConfig, authZ as FallbackAuthZ, initializeCache } from '@restorecommerce/acs-client';
import Redis from 'ioredis';
import { AuthenticationLogService } from './authlog_service';
import { TokenService } from './token_service';
import { Arango } from '@restorecommerce/chassis-srv/lib/database/provider/arango/base';
import { Database } from 'arangojs';
import 'source-map-support/register';

const RENDER_RESPONSE_EVENT = 'renderResponse';
const CONTRACT_CANCELLED = 'contractCancelled';

class UserCommandInterface extends chassis.CommandInterface {
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events, redisClient: Redis) {
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
  logger: Logger;
  cfg: any;
  topics: any;
  offsetStore: chassis.OffsetStore;
  userService: UserService;
  authZ: ACSAuthZ;
  redisClient: Redis;
  roleService: RoleService;

  constructor(cfg?: any) {
    this.cfg = cfg || createServiceConfig(process.cwd());
    const loggerCfg = this.cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    this.logger = createLogger(loggerCfg);
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

    this.authZ = await initAuthZ(this.cfg) as ACSAuthZ;

    // init redis client for subject index
    const redisConfig = cfg.get('redis');
    redisConfig.db = this.cfg.get('redis:db-indexes:db-subject');
    this.redisClient = new Redis(redisConfig);

    // init ACS cache
    await initializeCache();

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
      this.topics[topicType] = await events.topic(topicName);
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
    this.roleService = new RoleService(cfg, db, this.topics['role.resource'], logger, true, this.authZ);
    this.userService = new UserService(cfg, this.topics, db, logger, true, this.roleService, this.authZ);
    const authLogService = new AuthenticationLogService(cfg, db, this.topics['authlog.resource'], logger, true, this.authZ);

    // token service
    const tokenService = new TokenService(cfg, logger, this.authZ, this.userService);

    await server.bind(serviceNamesCfg.user, this.userService);
    await server.bind(serviceNamesCfg.role, this.roleService);
    await server.bind(serviceNamesCfg.authenticationLog, authLogService);
    await server.bind(serviceNamesCfg.token, tokenService);
    await server.bind(serviceNamesCfg.cis, cis);

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new chassis.grpc.ServerReflection(transport.$builder, server.config);
    await server.bind(reflectionServiceName, reflectionService);

    await server.bind(serviceNamesCfg.health, new chassis.Health(cis, {
      logger,
      cfg,
      dependencies: ['acs-srv'],
      readiness: async () => !!await ((db as Arango).db as Database).version()
    }));

    // Start server
    await server.start();

    this.events = events;
    this.server = server;
  }

  async stop(): Promise<any> {
    this.logger.info('Shutting down');
    await Promise.all([
      this.server.stop(),
      this.events.stop(),
      this.offsetStore.stop(),
      this.redisClient.quit(),
      this.roleService.stop(),
      this.userService.stop()
    ]);
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

