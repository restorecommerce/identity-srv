import * as should from 'should';
import * as _ from 'lodash';
import { GrpcClient } from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { Worker } from '../src/worker';
import { createServiceConfig } from '@restorecommerce/service-config';
import { Topic } from '@restorecommerce/kafka-client/lib/events/provider/kafka';
import { createMockServer } from 'grpc-mock';
import { updateConfig } from '@restorecommerce/acs-client';
import { FilterOperation } from '@restorecommerce/resource-base-interface';

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
let roleService: any;
let mockServer: any;

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
  await (events.start());
  topic = await events.topic(cfg.get(`events:kafka:topics:${resourceName}:topic`));

  return new GrpcClient(cfg.get(clientCfg), logger);
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
    this.timeout(60000);
    await start();
    // disable authorization
    cfg.set('authorization:enabled', false);
    cfg.set('authorization:enforce', false);
    updateConfig(cfg);
  });

  after(async function stopServer(): Promise<void> {
    this.timeout(60000);
    worker && await worker.stop();
    events && await events.stop();
  });

  describe('testing Role service', () => {
    let role: any;

    before(async function connectRoleService(): Promise<void> {
      role = await connect('client:service-role', 'role.resource');
      roleService = await role.connect();
    });

    after(async function stopRoleService(): Promise<void> {
      await role.end();
    });

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

        should.not.exist(result.error);
        should.exist(result);
        should.exist(result.data);
        should.exist(result.data.items);
        result.data.items.should.have.length(3);
      });
    });
  });

  describe('testing User service with disabled email constraint', () => {
    let userService, testUserID, user, testUserName, userBaseService;
    before(async function connectUserService(): Promise<void> {
      userBaseService = await connect('client:service-user', 'user.resource');
      userService = await userBaseService.connect();
      user = {
        name: 'test.user1', // this user is used in the next tests
        first_name: 'test',
        last_name: 'user',
        password: 'notsecure',
        email: 'test@ms.restorecommerce.io'
      };
    });

    after(async function stopUserService(): Promise<void> {
      await userBaseService.end();
    });

    describe('with test client with disabled email constraint', () => {

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
          await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: userPolicySetRQ },
          { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }]);
          // read by email
          const getResult = await userService.read({
            filters: [{
              filter: [{
                field: 'email',
                operation: FilterOperation.eq,
                value: data.value
              }]
            }]
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
        it('should throw an error when re-send activation email for registered user with email identifier when is not unique', async function sendActivationEmail(): Promise<void> {
          const result = await userService.sendActivationEmail({ identifier: user.email });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for send activation email, multiple users found for identifier test@ms.restorecommerce.io`);
        });
        it('should successfully re-send activation email for registered user with user name as identifier', async function sendActivationEmail(): Promise<void> {
          const result = await userService.sendActivationEmail({ identifier: user.name });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
        });
        it('should successfully unregister user with user name as identifier', async function unregisterUsers(): Promise<void> {
          const result = await userService.unregister({ identifier: 'test.user1' });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
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
          password: 'notsecure',
          email: 'test@ms.restorecommerce.io',
          role_associations: [{
            role: 'user-r-id',
            attributes: []
          }]
        };
        it('should create multiple users with same email and different user names', async function createUser(): Promise<void> {
          let testUsers = [];
          for (let i = 1; i <= 4; i++) {
            let userObj = Object.assign(testusersTemplate, { id: `testuser${i}`, name: `testuser${i}` });
            testUsers.push(_.cloneDeep(userObj));
          }
          const result = await userService.create({ items: testUsers });
          should.exist(result);
          should.exist(result.data);
          should.exist(result.data.items);
          result.data.items.length.should.equal(4);

        });
        it('Shoul throw an error when trying to create an user with existing user name', async () => {
          // testuser4 already exists from above test case
          let testUser = Object.assign(testusersTemplate, { id: 'testuser5', name: 'testuser4' });
          const result = await userService.create({ items: [testUser] });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('AlreadyExists');
          result.error.details.should.equal('6 ALREADY_EXISTS: user does already exist');
        });
      });

      describe('calling find', () => {
        it('finding by email should return 4 created users', async () => {
          const result = await userService.find({
            email: 'test@ms.restorecommerce.io'
          });
          should.exist(result);
          result.data.total_count.should.equal(4);
        });
        it('finding by name should return only specific user', async () => {
          const result = await userService.find({
            name: 'testuser1'
          });
          should.exist(result);
          result.data.total_count.should.equal(1);
        });
      });

      describe('login', () => {
        it('should throw an error when logging in with email identifier when is not unique', async () => {
          const result = await userService.login({
            identifier: 'test@ms.restorecommerce.io',
            password: 'notsecure',
          });
          should.exist(result);
          should.exist(result.error);
          should.not.exist(result.data);
          should.exist(result.error.message);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal('3 INVALID_ARGUMENT: Invalid identifier provided for login, multiple users found for identifier test@ms.restorecommerce.io');
        });
        it('should login with valid user name identifier and password', async () => {
          const result = await userService.login({
            identifier: 'testuser1',
            password: 'notsecure',
          });
          should.exist(result);
          should.not.exist(result.error);
          should.exist(result.data);
          const compareResult = await userService.find({
            name: 'testuser1',
          });
          const userDBDoc = compareResult.data.items[0];
          result.data.should.deepEqual(userDBDoc);
        });
      });

      describe('Unregister', () => {
        it('should throw an error when unregistering with email identifier when is not unique', async () => {
          const result = await userService.unregister({ identifier: 'test@ms.restorecommerce.io' });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for unregistering, multiple users found for identifier test@ms.restorecommerce.io`);
        });
        it('should successfully unregister with unique user name as identifier', async () => {
          const result = await userService.unregister({ identifier: 'testuser1' });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
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
          activation_code = result_1.data.activation_code;
          const result = await userService.activate({
            identifier: result_1.data.email,
            activation_code
          });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal('3 INVALID_ARGUMENT: Invalid identifier provided for user activation, multiple users found for identifier test@ms.restorecommerce.io');
        });
        it('should successfully activate user with unique user name as identifier', async () => {
          const result = await userService.activate({
            identifier: 'test.user1',
            activation_code
          });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
        });
      });

      describe('ChangePassword', () => {
        let activation_code;
        const email = 'test@ms.restorecommerce.io';
        const userName = 'test.user1';
        it('should throw an error for ChangePassword with email as identifier when is not unique', async () => {
          const result = await userService.changePassword({
            identifier: email,
            password: 'notsecure',
            new_password: 'secure'
          });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for change password, multiple users found for identifier ${email}`);
        });
        it('should allow to ChangePassword with user name as identifier', async () => {
          // password_hash before change pass
          const user_before = await userService.find({
            name: userName
          });
          const prev_pass_hash = user_before.data.items[0].password_hash;
          should.exist(prev_pass_hash);
          const result = await userService.changePassword({
            identifier: userName,
            password: 'notsecure',
            new_password: 'secure'
          });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
          // password_hash after change pass
          const user_after = await userService.find({
            name: userName
          });
          const current_pass_hash = user_after.data.items[0].password_hash;
          current_pass_hash.should.not.equal(prev_pass_hash);
        });
        it('should throw an error for RequestPasswordChange with email as identifier when is not unique', async () => {
          const result = await userService.requestPasswordChange({
            identifier: email
          });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for request password change, multiple users found for identifier ${email}`);
        });
        it('should successfully RequestPasswordChange with user name as identifier', async () => {
          // activation_code should be empty initially
          const user = await userService.find({ name: userName });
          const activation_code_before = user.data.items[0].activation_code;
          activation_code_before.should.be.empty();
          const result = await userService.requestPasswordChange({
            identifier: userName
          });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
          // activation_code value should exist after requesting passwordChange
          const user_mod = await userService.find({
            name: userName
          });
          activation_code = user_mod.data.items[0].activation_code;
          should.exist(activation_code);
        });
        it('should throw an error for ConfirmPasswordChange with email as identifier when is not unique', async () => {
          const result = await userService.confirmPasswordChange({
            identifier: email,
            activation_code,
            password: 'newpassword'
          });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for confirm password change, multiple users found for identifier ${email}`);
        });
        it('should successfully ConfirmPasswordChange with user name as identifier', async () => {
          // password_hash before confirm pass
          const user_before = await userService.find({
            name: userName
          });
          const prev_pass_hash = user_before.data.items[0].password_hash;
          should.exist(prev_pass_hash);
          const result = await userService.confirmPasswordChange({
            identifier: userName,
            activation_code,
            password: 'newpassword'
          });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
          // password_hash after confirm pass
          const user_after = await userService.find({
            name: userName
          });
          const current_pass_hash = user_after.data.items[0].password_hash;
          current_pass_hash.should.not.equal(prev_pass_hash);
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
          should.exist(result);
          should.exist(result.error);
          should.not.exist(result.data);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for send invitation email, multiple users found for identifier ${email}`);
        });
        it('should successfully send invitation with user name as identifier', async () => {
          const result = await userService.sendInvitationEmail({
            identifier: userName,
            invited_by_user_identifier: 'test.user1'
          });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
        });
        it('should throw an error when confirming invitation with email as identifier when not unique', async () => {
          const user = await userService.find({ name: userName });
          activation_code = user.data.items[0].activation_code;
          const result = await userService.confirmUserInvitation({
            identifier: email,
            password: 'new_password',
            activation_code
          });
          should.exist(result);
          should.exist(result.error);
          should.not.exist(result.data);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for user invitation confirmation, multiple users found for identifier ${email}`);
        });
        it('should successfully confirm user invitation with user name as identifier', async () => {
          const result = await userService.confirmUserInvitation({
            identifier: userName,
            password: 'new_password',
            activation_code
          });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
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
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for request email change, multiple users found for identifier ${email}`);
        });
        it('should change new_email field with provided email using user name as identifier', async () => {
          const result = await userService.requestEmailChange({
            identifier: userName,
            new_email: 'new_test@ms.restorecommerce.io'
          });
          should.exist(result);
          should.not.exist(result.error);
          should.exist(result.data);
          result.data.should.be.empty();
          const user_mod = await userService.find({
            name: userName
          });
          const new_email = user_mod.data.items[0].new_email;
          activation_code = user_mod.data.items[0].activation_code;
          new_email.should.equal('new_test@ms.restorecommerce.io');
        });
        it('should throw an error when confirming email providing email as identifier when not unique', async () => {
          const result = await userService.confirmEmailChange({
            identifier: email,
            activation_code
          });
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal(`3 INVALID_ARGUMENT: Invalid identifier provided for confirm email change, multiple users found for identifier ${email}`);
        });
        it('should successfully change email with confirmEmailChange and name as identifier', async () => {
          const result = await userService.confirmEmailChange({
            identifier: userName,
            activation_code
          });
          should.exist(result);
          should.not.exist(result.error);
          result.data.should.be.empty();
          const user = await userService.find({ name: userName });
          const changed_email = user.data.items[0].email;
          changed_email.should.equal('new_test@ms.restorecommerce.io');
          // drop all roles and users
          await roleService.delete({
            collection: true
          });
          await userService.delete({
            collection: true
          });
          await stopGrpcMockServer();
        });
      });
    });
  });
});
