import * as mocha from 'mocha';
import * as should from 'should';
import * as _ from 'lodash';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { Worker } from '../lib/worker';
import { createServiceConfig } from '@restorecommerce/service-config';
import { User } from '../lib/interface';
import { Topic } from '@restorecommerce/kafka-client/lib/events/provider/kafka';
import { createMockServer } from 'grpc-mock';
import { updateConfig } from '@restorecommerce/acs-client';

const Events = kafkaClient.Events;

/*
 * Note: To run this test, a running ArangoDB and Kafka instance is required.
 */

let cfg: any;
let worker: Worker;
let client;
let logger;

// For event listeners
let events;
let topic: Topic;
let roleService: any;
let mockServer: any;

async function start(): Promise<void> {
  cfg = createServiceConfig(process.cwd() + '/test');
  // disable unique email constraint, by default it is true
  cfg.set('service:uniqueEmailConstraint', false);
  worker = new Worker(cfg);
  await worker.start();
}

async function connect(clientCfg: string, resourceName: string): Promise<any> { // returns a gRPC service
  logger = worker.logger;

  events = new Events(cfg.get('events:kafka'), logger);
  await (events.start());
  topic = events.topic(cfg.get(`events:kafka:topics:${resourceName}:topic`));

  client = new grpcClient.Client(cfg.get(clientCfg), logger);
  const service = await client.connect();
  return service;
}

let meta = {
  modified_by: 'SYSTEM',
  owner: [{
    id: 'urn:restorecommerce:acs:names:ownerIndicatoryEntity',
    value: 'urn:restorecommerce:acs:model:organization.Organization'
  },
  {
    id: 'urn:restorecommerce:acs:names:ownerInstance',
    value: 'orgC'
  }]
};

interface serverRule {
  method: string,
  input: any,
  output: any
}

const permitUserRule = {
  id: 'permit_rule_id',
  target: {
    action: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:user.User' }],
    subject: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: 'PERMIT'
};

let userPolicySetRQ = {
  policy_sets:
    [{
      combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
      id: 'user_test_policy_set_id',
      policies: [
        {
          combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
          id: 'user_test_policy_id',
          target: {
            action: [],
            resources: [{
              id: 'urn:restorecommerce:acs:names:model:entity',
              value: 'urn:restorecommerce:acs:model:user.User'
            }],
            subject: []
          }, effect: 'PERMIT',
          rules: [ // permit or deny rule will be added
          ],
          has_rules: true
        }]
    }]
};

const startGrpcMockServer = async (rules: serverRule[]) => {
  // Create a mock ACS server to expose isAllowed and whatIsAllowed
  mockServer = createMockServer({
    protoPath: 'test/protos/io/restorecommerce/access_control.proto',
    packageName: 'io.restorecommerce.access_control',
    serviceName: 'Service',
    options: {
      keepCase: true
    },
    rules
  });
  mockServer.listen('0.0.0.0:50061');
  logger.info('ACS Server started on port 50061');
};

const stopGrpcMockServer = async () => {
  await mockServer.close(() => {
    logger.info('Server closed successfully');
  });
};

describe('testing identity-srv', () => {

  before(async function startServer(): Promise<void> {
    await start();
    // disable authorization
    cfg.set('authorization:enabled', false);
    cfg.set('authorization:enforce', false);
    updateConfig(cfg);
  });

  after(async function stopServer(): Promise<void> {
    await worker.stop();
  });

  describe('testing Role service', () => {
    describe('with test client', () => {
      before(async function connectRoleService(): Promise<void> {
        roleService = await connect('client:service-role', 'role.resource');
      });

      it('should create roles', async () => {
        const roles = [
          {
            id: 'super-admin-r-id',
            name: 'super_admin_user',
            description: 'Super Admin User',
            meta
          },
          {
            id: 'admin-r-id',
            name: 'admin_user',
            description: 'Admin user',
            meta,
            assignable_by_roles: ['admin-r-id']
          },
          {
            id: 'user-r-id',
            name: 'normal_user',
            description: 'Normal user',
            meta,
            assignable_by_roles: ['admin-r-id']
          }];

        const result = await roleService.create({
          items: roles
        });

        should.not.exist(result.error);
        should.exist(result);
        should.exist(result.data);
        should.exist(result.data.items);
        result.data.items.should.have.length(3);
      });
    });
  });

  describe('testing User service with disabled email constraint', () => {
    describe('with test client with disabled email constraint', () => {
      let userService, testUserID, user, testUserName;
      before(async function connectUserService(): Promise<void> {
        userService = await connect('client:service-user', 'user.resource');
        user = {
          name: 'test.user1', // this user is used in the next tests
          first_name: 'test',
          last_name: 'user',
          password: 'notsecure',
          email: 'test@ms.restorecommerce.io'
        };
      });

      describe('calling register', function registerUser(): void {
        it('should allow to register a user with same email but different names', async function registerUser(): Promise<void> {
          const listener = function listener(message: any, context: any): void {
            user.email.should.equal(message.email);
          };
          await topic.on('registered', listener);
          const result = await (userService.register(user));
          should.not.exist(result.error);
          should.exist(result);
          should.exist(result.data);
          const data = result.data;
          should.exist(data.id);
          testUserID = result.data.id;
          testUserName = result.data.name;
          should.exist(data.name);
          data.name.should.equal(user.name);
          should.exist(data.password_hash);
          should.exist(data.email);
          data.email.should.equal(user.email);
          data.active.should.be.false();
          data.activation_code.should.not.be.empty();
          // register user with same email but different names
          user.name = 'test.user2';
          const result_2 = await userService.register(user);
          should.exist(result_2.data.name);
          result_2.data.name.should.equal('test.user2');
          user.name = 'test.user3';
          const result_3 = await userService.register(user);
          should.exist(result_3.data.name);
          result_3.data.name.should.equal('test.user3');
          user.name = 'test.user4';
          const result_4 = await userService.register(user);
          should.exist(result_4.data.name);
          result_4.data.name.should.equal('test.user4');
          userPolicySetRQ.policy_sets[0].policies[0].rules[0] = permitUserRule;
          // start mock acs-srv - needed for read operation since acs-client makes a req to acs-srv
          // to get applicable policies although acs-lookup is disabled
          startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: userPolicySetRQ },
          { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }]);
          // read by email
          const getResult = await userService.read({
            filter: grpcClient.toStruct({
              email: data.email
            })
          });
          should.exist(getResult);
          should.exist(getResult.data);
          should.not.exist(getResult.error);
          getResult.data.items.length.should.equal(4);
          await topic.removeListener('registered', listener);
        });

        it('should throw an error when registering user with username already exists', async function registerUserAgain(): Promise<void> {
          const result = await userService.register(user);
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('AlreadyExists');
          result.error.details.should.equal('6 ALREADY_EXISTS: user does already exist');
        });

        it('should throw an error when re-send activation email for registered user with email identifier which is not unique', async function sendActivationEmail(): Promise<void> {
          const result = await userService.sendActivationEmail({ identifier: user.email });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for send activation email, multiple users found for identifier test@ms.restorecommerce.io`);
        });
        it('unregister throw an error when unregistering users with email identifier', async function unregisterUsers(): Promise<void> {
          const result = await userService.unregister({ identifier: 'test@ms.restorecommerce.io' });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for unregistering, multiple users found for identifier test@ms.restorecommerce.io`);
        });
        it('should successfully unregister user with user name as identifier', async function unregisterUsers(): Promise<void> {
          const result = await userService.unregister({ identifier: 'test.user1' });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
          await userService.unregister({ identifier: 'test.user2' });
          await userService.unregister({ identifier: 'test.user3' });
          // await userService.unregister({ identifier: 'test.user4' });
          // TODO remove and put in end
          await roleService.delete({
            collection: true
          });
          await stopGrpcMockServer();
        });
      });
    });
  });
});
