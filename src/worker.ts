import { createServiceConfig } from '@restorecommerce/service-config';
import * as _ from 'lodash-es';
import { Events, registerProtoMeta } from '@restorecommerce/kafka-client';
import { createLogger } from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { Logger } from 'winston';
import { UserService, RoleService } from './service.js';
import { ACSAuthZ, initAuthZ, updateConfig, authZ as FallbackAuthZ, initializeCache } from '@restorecommerce/acs-client';
import { createClient, RedisClientType } from 'redis';
import { AuthenticationLogService } from './authlog_service.js';
import { TokenService } from './token_service.js';
import { Arango } from '@restorecommerce/chassis-srv/lib/database/provider/arango/base.js';
import 'source-map-support/register.js';
import { OAuthService } from './oauth_service.js';
import { OAuthServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/oauth.js';
import { BindConfig } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc/index.js';
import { HealthDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/health/v1/health.js';
import {
  UserServiceDefinition,
  protoMetadata as userMeta, UserList
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import {
  protoMetadata as jobMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job.js';
import {
  RoleServiceDefinition,
  protoMetadata as roleMeta,
  RoleList
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/role.js';
import {
  AuthenticationLogServiceDefinition,
  protoMetadata as authenticationLogMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/authentication_log.js';
import {
  TokenServiceDefinition,
  protoMetadata as tokenMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/token.js';
import {
  CommandInterfaceServiceDefinition,
  protoMetadata as commandInterfaceMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/commandinterface.js';
import {
  protoMetadata as renderingMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/rendering.js';
import {
  protoMetadata as reflectionMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/reflection/v1alpha/reflection.js';
import {
  protoMetadata as notificationReqMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/notification_req.js';
import { ServerReflectionService } from 'nice-grpc-server-reflection';
import * as fs from 'node:fs';
import { runWorker } from '@restorecommerce/scs-jobs';

registerProtoMeta(
  userMeta,
  roleMeta,
  jobMeta,
  authenticationLogMeta,
  tokenMeta,
  commandInterfaceMeta,
  renderingMeta,
  reflectionMeta,
  notificationReqMeta
);

const RENDER_RESPONSE_EVENT = 'renderResponse';
const CONTRACT_CANCELLED = 'contractCancelled';

class UserCommandInterface extends chassis.CommandInterface {
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events, redisClient: RedisClientType<any, any>) {
    super(server, cfg, logger, events as any, redisClient as any);
  }

  makeResourcesRestoreSetup(db: any, resource: string): any {
    const that = this;
    return {
      unregistered: async function restoreUnregistered(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        try {
          await db.delete(`${resource}s`, { id: message.id });
        } catch (err: any) {
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
        } catch (err: any) {
          that.logger.error('Exception caught while restoring modified User',
            message);
        }
        return {};
      },
      registered: async function restoreUsersRegistered(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        try {
          await db.insert(`${resource}s`, message);
        } catch (err: any) {
          that.logger.error('Exception caught while restoring registered User',
            message);
        }
        return {};
      },
      userCreated: async function restoreUsersCreated(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        try {
          await db.insert(`${resource}s`, message);
        } catch (err: any) {
          that.logger.error('Exception caught while restoring registered User',
            message);
        }
        return {};
      },
    };
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
  redisClient: RedisClientType<any, any>;
  roleService: RoleService;

  constructor(cfg?: any) {
    this.cfg = cfg ?? createServiceConfig(process.cwd());
    const loggerCfg = this.cfg.get('logger');
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
    this.offsetStore = new chassis.OffsetStore(events as any, cfg, logger);

    let externalJobFiles;
    try {
      externalJobFiles = fs.readdirSync(process.env.EXTERNAL_JOBS_DIR || './lib/jobs');
    } catch (err: any) {
      if (err.message.includes('no such file or directory')) {
        logger.info('No files for external job processors found');
      } else {
        logger.error('Error reading jobs files');
      }
    }
    if (externalJobFiles && externalJobFiles.length > 0) {
      externalJobFiles.forEach(async (externalFile) => {
        if (externalFile.endsWith('.js') || externalFile.endsWith('.cjs')) {
          let require_dir = './jobs/';
          if (process.env.EXTERNAL_JOBS_REQUIRE_DIR) {
            require_dir = process.env.EXTERNAL_JOBS_REQUIRE_DIR;
          }
          // check for double default
          let fileImport = await import(require_dir + externalFile);
          if (fileImport?.default?.default) {
            (async () => (await import(require_dir + externalFile)).default.default(cfg, logger, events, runWorker))().catch(err => {
              this.logger.error(`Error scheduling external job ${externalFile}`, { err: err.message });
            });
          } else {
            (async () => (await import(require_dir + externalFile)).default(cfg, logger, events, runWorker))().catch(err => {
              this.logger.error(`Error scheduling external job ${externalFile}`, { err: err.message });
            });
          }
        }
      });
    }

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
    redisConfig.database = this.cfg.get('redis:db-indexes:db-subject');
    this.redisClient = createClient(redisConfig);
    this.redisClient.on('error', (err) => logger.error('Redis Client Error', err));
    await this.redisClient.connect();

    // init ACS cache
    await initializeCache();

    const cis = new UserCommandInterface(server, this.cfg, logger, events, this.redisClient);

    const identityServiceEventListener = async (msg: any,
      context: any, config: any, eventName: string) => {
      if (eventName === RENDER_RESPONSE_EVENT) {
        if (this?.userService?.emailEnabled) {
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
    const tokenService = new TokenService(cfg, logger, this.userService);

    // oauth service
    const oauthServices = cfg.get('oauth:services');
    if (oauthServices) {
      const oauthService = new OAuthService(cfg, logger, this.userService);
      await server.bind(serviceNamesCfg.oauth, {
        service: OAuthServiceDefinition,
        implementation: oauthService
      } as BindConfig<OAuthServiceDefinition>);
    }

    await server.bind(serviceNamesCfg.user, {
      service: UserServiceDefinition,
      implementation: this.userService
    } as BindConfig<UserServiceDefinition>);

    await server.bind(serviceNamesCfg.role, {
      service: RoleServiceDefinition,
      implementation: this.roleService
    } as BindConfig<RoleServiceDefinition>);

    await server.bind(serviceNamesCfg.authenticationLog, {
      service: AuthenticationLogServiceDefinition,
      implementation: authLogService
    } as BindConfig<AuthenticationLogServiceDefinition>);

    await server.bind(serviceNamesCfg.token, {
      service: TokenServiceDefinition,
      implementation: tokenService
    } as BindConfig<TokenServiceDefinition>);

    await server.bind(serviceNamesCfg.cis, {
      service: CommandInterfaceServiceDefinition,
      implementation: cis
    } as BindConfig<CommandInterfaceServiceDefinition>);

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const reflectionService = chassis.buildReflectionService([
      { descriptor: userMeta.fileDescriptor },
      { descriptor: roleMeta.fileDescriptor },
      { descriptor: authenticationLogMeta.fileDescriptor },
      { descriptor: tokenMeta.fileDescriptor },
      { descriptor: commandInterfaceMeta.fileDescriptor }
    ]);
    await server.bind(reflectionServiceName, {
      service: ServerReflectionService,
      implementation: reflectionService
    });

    await server.bind(serviceNamesCfg.health, {
      service: HealthDefinition,
      implementation: new chassis.Health(cis, {
        logger,
        cfg,
        dependencies: ['acs-srv'],
        readiness: async () => !!await (db as Arango).db.version()
      })
    } as BindConfig<HealthDefinition>);

    // Import static seed roles
    const seedDataConfig = this.cfg.get('seed_data');
    if (seedDataConfig) {
      const entities = Object.keys(seedDataConfig);
      for (let entity of entities) {
        const filePath = seedDataConfig[entity];
        await new Promise<void>((resolve, reject) => {
          fs.readFile(filePath, (err, data) => {
            if (err) {
              this.logger.error(`Failed loading seed ${entity} file`, err);
              reject(err);
              return;
            }
            let seedData;
            try {
              seedData = JSON.parse(data.toString());
            } catch(err) {
              this.logger.error(`Error parsing seed ${entity} file`, err);
              reject(err);
              return;
            }
            this.logger.info(`Loaded ${seedData?.length} seed ${entity}`);
            const service = entity === 'users' ? this.userService : this.roleService;
            const serviceList = entity === 'users' ? UserList: RoleList;

            service.superUpsert(serviceList.fromPartial({ items: seedData }), undefined)
              .then(() => {
                this.logger.info(`Seed ${entity} upserted successfully`);
                resolve();
              })
              .catch( (err: any) => {
                this.logger.error(`Failed upserting seed ${entity} file`, err);
                reject(err);
              });
          });
        }).catch((err) => {
          this.logger.error(`Failed upserting seed ${entity} file`, err);
        });
      }
    }

    // Import static seed accounts
    const seedAccountFile = this.cfg.get('seed_account_file');
    if (seedAccountFile) {
      this.logger.info('Loading seed account file', { seedAccountFile });
      await new Promise<void>((resolve, reject) => {
        fs.readFile(seedAccountFile, (err, data) => {
          if (err) {
            this.logger.error('Failed loading seed account file:', err);
            reject(err);
            return;
          }

          const seedAccounts = JSON.parse(data.toString());
          this.logger.info(`Loaded ${seedAccounts.length} seed accounts`);

          const defaultSeedAccount = seedAccounts.find((p: any) => p?.tokens?.find((t: any) => t?.default_technical_token));
          if (!defaultSeedAccount) {
            logger.error('Failed to find default seed account');
            reject(new Error('Failed to find default seed account'));
          }

          this.userService.superUpsert(UserList.fromPartial({
            items: seedAccounts,
          }), undefined)
            .then(() => {
              this.logger.info('Seed accounts upserted successfully');
              resolve();
            })
            .catch(err => {
              this.logger.error('Failed upserting seed account file:', err);
              reject(err);
            });
        });
      });
    }

    // Start server
    await server.start();

    this.events = events;
    this.server = server;
    this.logger.info('Server started successfully');
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
