import {} from 'mocha';
import should from 'should';
import _ from 'lodash-es';
import { createClient, createChannel } from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { Worker } from '../src/worker';
import { createServiceConfig } from '@restorecommerce/service-config';
import { Topic } from '@restorecommerce/kafka-client/lib/events/provider/kafka';
import { GrpcMockServer, ProtoUtils } from '@alenon/grpc-mock-server';
import * as proto_loader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import { updateConfig } from '@restorecommerce/acs-client';
import {
  UserServiceDefinition,
  UserServiceClient, UserType,
  User
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import {
  RoleServiceDefinition,
  RoleServiceClient
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/role';
import { Filter_Operation } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';
import { PolicySetRQ } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/policy_set';
import { Effect, RuleRQ } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/rule';

const Events = kafkaClient.Events;

/*
 * Note: To run this test, a running ArangoDB and Kafka instance is required.
 */

let cfg: any;
let worker: Worker;
let logger;

// For event listeners
let events;
let topic: Topic;
let roleService: RoleServiceClient;

/* eslint-disable */
async function start(): Promise<void> {
  cfg = createServiceConfig(process.cwd() + '/test');
  // disable unique email constraint, by default it is true
  cfg.set('service:uniqueEmailConstraint', false);
  worker = new Worker(cfg);
  await worker.start();
}

async function connect(clientCfg: string, resourceName: string): Promise<any> { // returns a gRPC service
  logger = worker.logger;

  if (events) {
    await events.stop();
    events = undefined;
  }

  events = new Events(cfg.get('events:kafka'), logger);
  await events.start();
  let topicLable = `${resourceName}.resource`;
  topic = await events.topic(cfg.get(`events:kafka:topics:${topicLable}:topic`));

  const channel = createChannel(cfg.get(clientCfg).address);
  if (resourceName.startsWith('user')) {
    return createClient({
      ...cfg.get(clientCfg),
      logger
    }, UserServiceDefinition, channel) as any;
  } else if (resourceName.startsWith('role')) {
    return createClient({
      ...cfg.get(clientCfg),
      logger
    }, RoleServiceDefinition, channel) as any;
  }
}

let meta = {
  modified_by: 'SYSTEM',
  owner: [{
    id: 'urn:restorecommerce:acs:names:ownerIndicatoryEntity',
    value: 'urn:restorecommerce:acs:model:organization.Organization',
    attributes: [{
      id: 'urn:restorecommerce:acs:names:ownerInstance',
      value: 'orgC'
    }]
  }]
};

const permitUserRule: RuleRQ = {
  id: 'permit_rule_id',
  target: {
    actions: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:user.User' }],
    subjects: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: Effect.PERMIT
};

const genPolicySets = (...rules: RuleRQ[]): { policy_sets: PolicySetRQ[] } => ({
  policy_sets:
    [{
      combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
      id: 'user_test_policy_set_id',
      policies: [
        {
          combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
          id: 'user_test_policy_id',
          target: {
            actions: [],
            resources: [{
              id: 'urn:restorecommerce:acs:names:model:entity',
              value: 'urn:restorecommerce:acs:model:user.User'
            }],
            subjects: []
          }, effect: Effect.PERMIT,
          rules,
          has_rules: true
        }]
    }]
});

interface MethodWithOutput {
  method: string,
  output: any
};

const PROTO_PATH: string = 'io/restorecommerce/access_control.proto';
const PKG_NAME: string = 'io.restorecommerce.access_control';
const SERVICE_NAME: string = 'AccessControlService';

const pkgDef: grpc.GrpcObject = grpc.loadPackageDefinition(
  proto_loader.loadSync(PROTO_PATH, {
    includeDirs: ['node_modules/@restorecommerce/protos/'],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  })
);

const proto: any = ProtoUtils.getProtoFromPkgDefinition(
  PKG_NAME,
  pkgDef
);

const mockServer = new GrpcMockServer('localhost:50061');

const startGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  const implementations = {
    isAllowed: (call: any, callback: any) => {
      const isAllowedResponse = methodWithOutput.filter(e => e.method === 'IsAllowed');
      const response: any = new proto.Response.constructor(isAllowedResponse[0]!.output);
      callback(null, response);
    },
    whatIsAllowed: (call: any, callback: any) => {
      // check the request object and provide UserPolicies / RolePolicies
      const whatIsAllowedResponse = methodWithOutput.filter(e => e.method === 'WhatIsAllowed');
      const response: any = new proto.ReverseQuery.constructor(whatIsAllowedResponse[0]!.output);
      callback(null, response);
    }
  };
  try {
    mockServer.addService(PROTO_PATH, PKG_NAME, SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos/'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServer.start();
    logger.info('Mock ACS Server started on port 50061');
  } catch (err) {
    logger.error('Error starting mock ACS server', err);
  }
};

const stopGrpcMockServer = async () => {
  await mockServer.stop();
  logger.info('Mock ACS Server closed successfully');
};

describe('testing identity-srv', () => {

  before(async function startServer(): Promise<void> {
    this.timeout(60000);
    await start();
    // disable authorization
    cfg.set('authorization:enabled', false);
    cfg.set('authorization:enforce', false);
    updateConfig(cfg);

    roleService = await connect('client:role', 'role');

    // drop all roles and users
    await roleService.delete({
      collection: true
    });
    const userService: UserServiceClient = await connect('client:user', 'user');
    await userService.delete({
      collection: true
    });
  });

  after(async function stopServer(): Promise<void> {
    // drop all roles and users
    await roleService.delete({
      collection: true
    });
    const userService: UserServiceClient = await connect('client:user', 'user');
    await userService.delete({
      collection: true
    }).then();
    await stopGrpcMockServer();
    this.timeout(60000);
    worker && await worker.stop();
    events && await events.stop();
  });

  describe('testing Role service', () => {
    describe('with test client', () => {

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
        should.exist(result);
        should.exist(result!.items);
        result!.items!.should.have.length(3);
        // validate item status and overall status
        result!.operation_status!.code!.should.equal(200);
        result!.operation_status!.message!.should.equal('success');
        _.forEach(result!.items, (item) => {
          item!.status!.code!.should.equal(200);
          item!.status!.message!.should.equal('success');
        });
      });
    });
  });

  describe('testing User service with disabled email constraint', () => {
    let userService: UserServiceClient;
    let testUserID, user, testUserName;
    before(async function connectUserService(): Promise<void> {
      userService = await connect('client:user', 'user');
      user = {
        name: 'test.user1', // this user is used in the next tests
        first_name: 'test',
        last_name: 'user',
        password: 'CNQJrH%KAayeDpf3h',
        email: 'test@ms.restorecommerce.io'
      };
    });

    after(async function stopUserService(): Promise<void> {
      // service stopped using worker thread
    });

    describe('with test client with disabled email constraint', () => {

      describe('calling register', function registerUser(): void {
        it('should allow to register a user with same email but different names', async function registerUser(): Promise<void> {
          const listener = function listener(message: any, context: any): void {
            user.email!.should.equal(message.email);
          };
          await topic.on('registered', listener);
          const result = await (userService.register(user));
          should.exist(result);
          should.exist(result!.payload);
          const data = result!.payload;
          should.exist(data!.id);
          testUserID = result!.payload!.id;
          testUserName = result!.payload!.name;
          should.exist(data!.name);
          data!.name!.should.equal(user.name);
          should.exist(data!.password_hash);
          should.exist(data!.email);
          data!.email!.should.equal(user.email);
          data!.active!.should.be.false();
          data!.activation_code!.should.not.be.empty();
          // register user with same email but different names
          user.name = 'test.user2';
          const result_2 = await userService.register(user);
          should.exist(result_2.payload!.name);
          result_2.payload!.name!.should.equal('test.user2');
          user.name = 'test.user3';
          const result_3 = await userService.register(user);
          should.exist(result_3.payload!.name);
          result_3.payload!.name!.should.equal('test.user3');
          user.name = 'test.user4';
          const result_4 = await userService.register(user);
          should.exist(result_4.payload!.name);
          result_4.payload!.name!.should.equal('test.user4');
          const userPolicySetRQ = genPolicySets(permitUserRule);
          // start mock acs-srv - needed for read operation since acs-client makes a req to acs-srv
          // to get applicable policies although acs-lookup is disabled
          await startGrpcMockServer([{ method: 'WhatIsAllowed', output: userPolicySetRQ },
          { method: 'IsAllowed', output: { decision: 'PERMIT' } }]);
          // read by email
          const getResult = await userService.read({
            filters: [{
              filters: [{
                field: 'email',
                operation: Filter_Operation.eq,
                value: data!.email
              }]
            }]
          });
          should.exist(getResult);
          should.exist(getResult.items);
          getResult.items!.length!.should.equal(4);
          // validate item status and overall status
          getResult.operation_status!.code!.should.equal(200);
          getResult.operation_status!.message!.should.equal('success');
          _.forEach(getResult.items, (item) => {
            item!.status!.code!.should.equal(200);
            item!.status!.message!.should.equal('success');
          });
          await topic.removeListener('registered', listener);
        });
        it('should throw an error when registering user with username already exists', async function registerUserAgain(): Promise<void> {
          const result = await userService.register(user);
          should.exist(result);
          should.not.exist(result!.payload);
          result!.status!.code!.should.equal(409);
          result!.status!.message!.should.equal('user does already exist');
        });
        it('should throw an error when re-send activation email for registered user with email identifier when is not unique', async function sendActivationEmail(): Promise<void> {
          const result = await userService.sendActivationEmail({ identifier: user.email });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal('Invalid identifier provided for send activation email, multiple users found for identifier test@ms.restorecommerce.io');
        });
        it('should successfully re-send activation email for registered user with user name as identifier', async function sendActivationEmail(): Promise<void> {
          const result = await userService.sendActivationEmail({ identifier: user.name });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
        it('should successfully unregister user with user name as identifier', async function unregisterUsers(): Promise<void> {
          const result = await userService.unregister({ identifier: 'test.user1' });
          should.exist(result);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          await userService.unregister({ identifier: 'test.user2' });
          await userService.unregister({ identifier: 'test.user3' });
          await userService.unregister({ identifier: 'test.user4' });
        });
      });

      describe('calling createUsers', function createUser(): void {
        const testusersTemplate = {
          id: 'testuser1', name: 'testuser1',
          first_name: 'test',
          last_name: 'user',
          password: 'CNQJrH%KAayeDpf3h',
          email: 'test@ms.restorecommerce.io',
          role_associations: [{
            role: 'user-r-id',
            attributes: []
          }],
          active: true
        };
        it('should create multiple users with same email and different user names', async function createUser(): Promise<void> {
          let testUsers = new Array<User>();
          for (let i = 1; i <= 4; i++) {
            let userObj = Object.assign(testusersTemplate, { id: `testuser${i}`, name: `testuser${i}` });
            testUsers.push(_.cloneDeep(userObj));
          }
          const result = await userService.create({ items: testUsers });
          should.exist(result);
          should.exist(result!.items);
          result!.items!.length!.should.equal(4);
          // validate item status and overall status
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          _.forEach(result!.items, (item) => {
            item!.status!.code!.should.equal(200);
            item!.status!.message!.should.equal('success');
          });
        });
        it('Shoul throw an error when trying to create an user with existing user name', async () => {
          // testuser4 already exists from above test case
          let testUser = Object.assign(testusersTemplate, { id: 'testuser5', name: 'testuser4' });
          const result = await userService.create({ items: [testUser] });
          should.exist(result!.items);
          should.not.exist(result!.items![0]!.payload);
          // item status
          result!.items![0]!.status!.code!.should.equal(409);
          result!.items![0]!.status!.message!.should.equal('user does already exist');
          // overall status
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
        it('Should create a tech user without password and delete it', async () => {
          // techUser with no password
          let techUser = Object.assign(testusersTemplate,
            {
              id: 'techUserID1', name: 'techUserName', email: 'techuser@techuser',
              user_type: UserType.TECHNICAL_USER,
              role_associations: [{
                id: 'user-r-role-assoc-id',
                role: 'user-r-id',
                attributes: []
              }],
              tokens: [{
                name: 'techUserTOken',
                token: 'c110091d9c54438ea50c72fb32148457',
                scopes: ['user-r-role-assoc-id']
              }],
              active: true
            });
          const result = await userService.create({ items: [techUser] });
          should.exist(result!.items);
          should.exist(result!.items![0]!.payload);
          result!.items![0]!.payload!.tokens![0]!.token!.should.equal('c110091d9c54438ea50c72fb32148457');
          result!.items![0]!.status!.code!.should.equal(200);
          result!.items![0]!.status!.message!.should.equal('success');
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          const deleteResponse = await userService.delete({ ids: ['techUserID1'] });
          deleteResponse.status![0]!.id!.should.equal('techUserID1');
          deleteResponse.status![0]!.code!.should.equal(200);
          deleteResponse.status![0]!.message!.should.equal('success');
          deleteResponse.operation_status!.code!.should.equal(200);
          deleteResponse.operation_status!.message!.should.equal('success');
        });
        it('Shoul create a tech user with password', async () => {
          // techUser
          let techUser = Object.assign(testusersTemplate, {
            id: 'techUserID1',
            name: 'techUserName', password: 'CNQJrH%KAayeDpf3h',
            email: 'techuser@techuser', user_type: UserType.TECHNICAL_USER,
            role_associations: [{
              id: 'user-r-role-assoc-id',
              role: 'user-r-id',
              attributes: []
            }],
            tokens: [{
              name: 'techUserTOken',
              token: 'c110091d9c54438ea50c72fb32148457',
              scopes: ['user-r-role-assoc-id']
            }],
            active: true
          });
          const result = await userService.create({ items: [techUser] });
          should.exist(result!.items);
          should.exist(result!.items![0]!.payload);
          result!.items![0]!.payload!.tokens![0]!.token!.should.equal('c110091d9c54438ea50c72fb32148457');
          result!.items![0]!.status!.code!.should.equal(200);
          result!.items![0]!.status!.message!.should.equal('success');
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
      });

      describe('calling find', () => {
        it('finding by email should return 4 created users', async () => {
          const result = await userService.find({
            email: 'test@ms.restorecommerce.io'
          });
          should.exist(result);
          result!.total_count!.should.equal(4);
          _.forEach(result!.items, (item) => {
            item!.status!.code!.should.equal(200);
            item!.status!.message!.should.equal('success');
          });
          // overall status
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
        it('finding by name should return only specific user', async () => {
          const result = await userService.find({
            name: 'testuser1'
          });
          should.exist(result);
          result!.total_count!.should.equal(1);
          _.forEach(result!.items, (item) => {
            item!.status!.code!.should.equal(200);
            item!.status!.message!.should.equal('success');
          });
          // overall status
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
      });

      describe('login', () => {
        it('should throw an error when logging in with email identifier when is not unique', async () => {
          const result = await userService.login({
            identifier: 'test@ms.restorecommerce.io',
            password: 'CNQJrH%KAayeDpf3h',
          });
          should.exist(result);
          should.not.exist(result!.payload);
          should.exist(result!.status);
          result!.status!.code!.should.equal(400);
          result!.status!.message!.should.equal('Invalid identifier provided for login, multiple users found for identifier test@ms.restorecommerce.io');
        });
        it('should login with valid user name identifier and password', async () => {
          const result = await userService.login({
            identifier: 'testuser1',
            password: 'CNQJrH%KAayeDpf3h',
          });
          should.exist(result);
          should.exist(result!.payload);
          result!.status!.code!.should.equal(200);
          result!.status!.message!.should.equal('success');
          const compareResult = await userService.find({
            name: 'testuser1',
          });
          const userDBDoc = compareResult.items![0]!.payload;
          result!.payload!.should.deepEqual(userDBDoc);
        });
        it('should login for tech user wth valid user name identifier and password', async () => {
          const result = await userService.login({
            identifier: 'techUserName',
            password: 'CNQJrH%KAayeDpf3h',
          });
          should.exist(result);
          should.exist(result!.payload);
          result!.status!.code!.should.equal(200);
          result!.status!.message!.should.equal('success');
          const compareResult = await userService.find({
            name: 'techUserName',
          });
          const userDBDoc = compareResult.items![0]!.payload;
          result!.payload!.should.deepEqual(userDBDoc);
        });
      });

      describe('Unregister', () => {
        it('should throw an error when unregistering with email identifier when is not unique', async () => {
          const result = await userService.unregister({ identifier: 'test@ms.restorecommerce.io' });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal('Invalid identifier provided for unregistering, multiple users found for identifier test@ms.restorecommerce.io');
        });
        it('should successfully unregister with unique user name as identifier', async () => {
          const result = await userService.unregister({ identifier: 'testuser1' });
          should.exist(result);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          await userService.unregister({ identifier: 'testuser2' });
          await userService.unregister({ identifier: 'testuser3' });
          await userService.unregister({ identifier: 'testuser4' });
          // TODO remove and put in end
          await roleService.delete({
            collection: true
          });
          await stopGrpcMockServer();
        });
      });

      describe('Activate', () => {
        let activation_code;
        it('should throw an error when activating with email identifier when is not unique', async () => {
          // register 2 users
          user.name = 'test.user1';
          const result_1 = await userService.register(user);
          user.name = 'test.user2';
          const result_2 = await userService.register(user);
          activation_code = result_1.payload!.activation_code;
          const result = await userService.activate({
            identifier: result_1.payload!.email,
            activation_code
          });
          should.exist(result);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal('Invalid identifier provided for user activation, multiple users found for identifier test@ms.restorecommerce.io');
        });
        it('should successfully activate user with unique user name as identifier', async () => {
          const result = await userService.activate({
            identifier: 'test.user1',
            activation_code
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
      });

      describe('ChangePassword', () => {
        let activation_code;
        const email = 'test@ms.restorecommerce.io';
        const userName = 'test.user1';
        it('should throw an error for RequestPasswordChange with email as identifier when is not unique', async () => {
          const result = await userService.requestPasswordChange({
            identifier: email
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal(`Invalid identifier provided for request password change, multiple users found for identifier ${email}`);
        });
        it('should successfully RequestPasswordChange with user name as identifier', async () => {
          // activation_code should be empty initially
          const user = await userService.find({ name: userName });
          const activation_code_before = user.items![0]!.payload!.activation_code;
          activation_code_before!.should.be.empty();
          const result = await userService.requestPasswordChange({
            identifier: userName
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          // activation_code value should exist after requesting passwordChange
          const user_mod = await userService.find({
            name: userName
          });
          activation_code = user_mod.items![0]!.payload!.activation_code;
          should.exist(activation_code);
        });
        it('should throw an error for ConfirmPasswordChange with email as identifier when is not unique', async () => {
          const result = await userService.confirmPasswordChange({
            identifier: email,
            activation_code,
            password: 'CNQJrH%KAayeDpf3h'
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal(`Invalid identifier provided for confirm password change, multiple users found for identifier ${email}`);
        });
        it('should successfully ConfirmPasswordChange with user name as identifier', async () => {
          // password_hash before confirm pass
          const user_before = await userService.find({
            name: userName
          });
          const prev_pass_hash = user_before.items![0]!.payload!.password_hash;
          should.exist(prev_pass_hash);
          const result = await userService.confirmPasswordChange({
            identifier: userName,
            activation_code,
            password: 'CNQJrH%KAayeDpf3h655'
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          // password_hash after confirm pass
          const user_after = await userService.find({
            name: userName
          });
          const current_pass_hash = user_after.items![0]!.payload!.password_hash;
          current_pass_hash!.should.not.equal(prev_pass_hash);
        });
      });

      describe('SendAndConfirmInvitation', () => {
        const email = 'test@ms.restorecommerce.io';
        const userName = 'test.user2'; // testuser2 invited by testuser1
        let activation_code;
        it('should throw an error when sending invitation with email as identifier when not unique', async () => {
          const result = await userService.sendInvitationEmail({
            identifier: email,
            invited_by_user_identifier: 'test.user1'
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal(`Invalid identifier provided for send invitation email, multiple users found for identifier ${email}`);
        });
        it('should successfully send invitation with user name as identifier', async () => {
          const result = await userService.sendInvitationEmail({
            identifier: userName,
            invited_by_user_identifier: 'test.user1'
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
        it('should throw an error when confirming invitation with email as identifier when not unique', async () => {
          const user = await userService.find({ name: userName });
          activation_code = user.items![0]!.payload!.activation_code;
          const result = await userService.confirmUserInvitation({
            identifier: email,
            password: 'CNQJrH%5KAayeDpf3h',
            activation_code
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal(`Invalid identifier provided for user invitation confirmation, multiple users found for identifier ${email}`);
        });
        it('should successfully confirm user invitation with user name as identifier', async () => {
          const result = await userService.confirmUserInvitation({
            identifier: userName,
            password: 'CNQJrH%5KAayeDpf3h',
            activation_code
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
        });
      });

      describe('ChangeEmail', () => {
        const email = 'test@ms.restorecommerce.io';
        const userName = 'test.user1';
        let activation_code;
        it('should throw an error when requesting to change email with email as identifier when is not unique', async () => {
          const result = await userService.requestEmailChange({
            identifier: email,
            new_email: 'new_test@ms.restorecommerce.io'
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal(`Invalid identifier provided for request email change, multiple users found for identifier ${email}`);
        });
        it('should change new_email field with provided email using user name as identifier', async () => {
          const result = await userService.requestEmailChange({
            identifier: userName,
            new_email: 'new_test@ms.restorecommerce.io'
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          const user_mod = await userService.find({
            name: userName
          });
          const new_email = user_mod.items![0]!.payload!.new_email;
          activation_code = user_mod.items![0]!.payload!.activation_code;
          new_email!.should.equal('new_test@ms.restorecommerce.io');
        });
        it('should throw an error when confirming email providing email as identifier when not unique', async () => {
          const result = await userService.confirmEmailChange({
            identifier: email,
            activation_code
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(400);
          result!.operation_status!.message!.should.equal(`Invalid identifier provided for confirm email change, multiple users found for identifier ${email}`);
        });
        it('should successfully change email with confirmEmailChange and name as identifier', async () => {
          const result = await userService.confirmEmailChange({
            identifier: userName,
            activation_code
          });
          should.exist(result!.operation_status);
          result!.operation_status!.code!.should.equal(200);
          result!.operation_status!.message!.should.equal('success');
          const user = await userService.find({ name: userName });
          const changed_email = user.items![0]!.payload!.email;
          changed_email!.should.equal('new_test@ms.restorecommerce.io');
        });
      });
    });
  });
});
