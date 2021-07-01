import * as should from 'should';
import * as _ from 'lodash';
import { GrpcClient } from '@restorecommerce/grpc-client';
import { Events, Topic } from '@restorecommerce/kafka-client';
import { Worker } from '../src/worker';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createMockServer } from 'grpc-mock';
import { updateConfig } from '@restorecommerce/acs-client';
import { FilterOperation } from '@restorecommerce/resource-base-interface';

/*
 * Note: To run this test, a running ArangoDB and Kafka instance is required.
 */

let cfg: any;
let worker: Worker;
let client;
let logger;

// For event listeners
let events: Events;
let topic: Topic;
let roleService: any;
let mockServer: any;

/* eslint-disable */
async function start(): Promise<void> {
  cfg = createServiceConfig(process.cwd() + '/test');
  worker = new Worker(cfg);
  await worker.start();
}

async function connect(clientCfg: string, resourceName: string): Promise<any> { // returns a gRPC service
  logger = worker.logger;

  if (events) {
    await events.stop();
    events = undefined;
  }

  events = new Events({
    ...cfg.get('events:kafka'),
    groupId: 'restore-identity-srv-test-runner',
    kafka: {
      ...cfg.get('events:kafka:kafka'),
    }
  }, logger);
  await (events.start());
  let topicLable = `${resourceName}.resource`;
  topic = await events.topic(cfg.get(`events:kafka:topics:${topicLable}:topic`));

  client = new GrpcClient(cfg.get(clientCfg), logger);
  if (resourceName.startsWith('user')) {
    return client.user;
  } else if (resourceName.startsWith('role')) {
    return client.role;
  }
}

let meta = {
  modified_by: 'SYSTEM',
  owner: [{
    id: 'urn:restorecommerce:acs:names:ownerIndicatoryEntity',
    value: 'urn:restorecommerce:acs:model:organization.Organization'
  },
  {
    id: 'urn:restorecommerce:acs:names:ownerInstance',
    value: 'orgA'
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
    await worker.stop();
    await events.stop();
  });

  describe('testing Role service', () => {
    describe('with test client', () => {
      before(async function connectRoleService(): Promise<void> {
        roleService = await connect('client:role', 'role');
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
        should.exist(result);
        should.exist(result.items);
        should.exist(result.status);
        result.items.should.have.length(3);
        // validate overall status
        result.status.code.should.equal(200);
        result.status.message.should.equal('success');
        // validate individual status
        _.forEach(result.items, (item) => {
          item.status.code.should.equal(200);
          item.status.message.should.equal('success');
        });
      });
    });
  });

  describe('testing User service with email constraint (default)', () => {
    describe('with test client with email constraint (default)', () => {
      let userService, testUserID, upserUserID, user, testUserName;
      before(async function connectUserService(): Promise<void> {
        userService = await connect('client:user', 'user');
        user = {
          name: 'test.user1', // this user is used in the next tests
          first_name: 'test',
          last_name: 'user',
          password: 'notsecure',
          email: 'test@ms.restorecommerce.io'
        };
      });

      describe('calling register', function registerUser(): void {
        it('should register a user', async function registerUser(): Promise<void> {
          this.timeout(30000);
          const listener = function listener(message: any, context: any): void {
            user.name.should.equal(message.name);
            user.email.should.equal(message.email);
          };
          await topic.on('registered', listener);
          const registerResult = await (userService.register(user));
          should.exist(registerResult.payload);
          should.exist(registerResult.status);
          const result = registerResult.payload;
          should.exist(result);
          should.exist(result.id);
          testUserID = result.id;
          testUserName = result.name;
          should.exist(result.name);
          result.name.should.equal(user.name);
          should.exist(result.password_hash);
          should.exist(result.email);
          result.email.should.equal(user.email);
          result.active.should.be.false();
          result.activation_code.should.not.be.empty();
          // validate status
          registerResult.status.code.should.equal(200);
          registerResult.status.message.should.equal('success');
          userPolicySetRQ.policy_sets[0].policies[0].rules[0] = permitUserRule;
          // start mock acs-srv - needed for read operation since acs-client makes a req to acs-srv
          // to get applicable policies although acs-lookup is disabled
          startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: userPolicySetRQ },
          { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }]);
          const filters = [{
            filter: [{
              field: 'id',
              operation: FilterOperation.eq,
              value: result.id
            }]
          }];
          const readResult = await userService.read({ filters });
          should.exist(readResult);
          should.exist(readResult.items);
          readResult.items[0].payload.should.deepEqual(result);
          await topic.removeListener('registered', listener);
        });

        it('should re-send activation email for registered user', async function sendActivationEmail(): Promise<void> {
          this.timeout(60000);
          const listener = function listener(message: any, context: any): void {
            message.id.should.equal(`identity#test@ms.restorecommerce.io`);
          };

          const renderingTopic = await events.topic('io.restorecommerce.rendering');
          const offset = await renderingTopic.$offset(-1);
          await renderingTopic.on('renderRequest', listener);
          const result = await userService.sendActivationEmail({ identifier: user.name });

          should.exist(result);
          result.should.be.empty();
          await renderingTopic.$wait(offset);
          await renderingTopic.removeListener('renderRequest', listener);
        });

        it('should register guest User', async function registerUserAgain(): Promise<void> {
          const guest_user = {
            id: 'guest_id',
            name: 'guest_user',
            first_name: 'guest_first_name',
            last_name: 'guest_last_name',
            password: 'notsecure',
            email: 'guest@guest.com',
            guest: true
          };
          const registerResult = await (userService.register(guest_user));
          should.exist(registerResult);
          should.exist(registerResult.payload);
          should.exist(registerResult.status);
          const result = registerResult.payload;
          should.exist(result);
          result.id.should.equal('guest_id');
          result.guest.should.equal(true);
          registerResult.status.code.should.equal(200);
          registerResult.status.message.should.equal('success');
          await userService.unregister({ identifier: 'guest_user' });
        });

        it('should throw an error when registering same user', async function registerUserAgain(): Promise<void> {
          const registerResult = await (userService.register(user));
          should.exist(registerResult);
          should.not.exist(registerResult.payload);
          should.exist(registerResult.status);
          registerResult.status.code.should.equal(409);
          registerResult.status.message.should.equal('user does already exist');
        });

        it('should not create a user with an invalid username format - should test character repetition', async function registerUser(): Promise<void> {
          // the username should not contain --, __ or ..
          let userNameList: string[] = [
            '__TestUser', '--TestUser', '..TestUser',
            'Test__User', 'Test--User', 'Test..User',
            'TestUser__', 'TestUser--', 'TestUser..',
            '___TestUser', '---TestUser', '...TestUser',
            'Test___User', 'Test---User', 'Test...User',
            'TestUser___', 'TestUser---', 'TestUser...',
          ];

          const testInvalidUser = async (invalidUser: any) => {
            const result = await userService.register(invalidUser);
            should.exist(result);
            should.not.exist(result.payload);
            should.exist(result.status);
            result.status.code.should.equal(400);
            result.status.message.should.startWith('Error while validating username:');
          };

          const invalidUser = _.cloneDeep(user);
          for (let user of userNameList) {
            invalidUser.name = user;
            invalidUser.email = `${user}@${user}.com`;
            await testInvalidUser(invalidUser);
          }
        });

        it('should not create a user with an invalid username format - should test first character', async function registerUser(): Promise<void> {
          // the username first character should not be one of the following
          // !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~ or whitespace
          let userNameList: string[] = [
            'Test User',
          ];

          const listOfCharacters = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ';
          for (let character of listOfCharacters) {
            let userNameStr = character + 'Testuser';
            userNameList.push(userNameStr);
          }

          const testInvalidUser = async (invalidUser: any) => {
            const result = await userService.register(invalidUser);
            should.exist(result);
            should.not.exist(result.payload);
            should.exist(result.status);
            result.status.code.should.equal(400);
            result.status.message.should.startWith('Error while validating username:');
          };

          const invalidUser = _.cloneDeep(user);
          for (let user of userNameList) {
            invalidUser.name = user;
            invalidUser.email = `${user}@${user}.com`;
            await testInvalidUser(invalidUser);
          }
        });

        it('should not create a user with an invalid username format - should test allowed characters', async function registerUser(): Promise<void> {
          // the username should not contain any of the following characters:
          // !"#$%&\'()*+,/:;<=>?[\\]^`{|}~
          let userNameList: string[] = [];

          const listOfCharacters = '!"#$%&\'()*+,/:;<=>?[\\]^`{|}~ ';
          for (let character of listOfCharacters) {
            // character + 'TestUser' condition
            // is checked in the "first char" unit test
            let userNameStr_1 = 'TestUser' + character;
            userNameList.push(userNameStr_1);
            let userNameStr_2 = 'Test' + character + 'User';
            userNameList.push(userNameStr_2);
          }

          const testInvalidUser = async (invalidUser: any) => {
            const result = await userService.register(invalidUser);
            should.exist(result);
            should.not.exist(result.payload);
            should.exist(result.status);
            result.status.code.should.equal(400);
            result.status.message.should.startWith('Error while validating username:');
          };

          const invalidUser = _.cloneDeep(user);
          for (let user of userNameList) {
            invalidUser.name = user;
            invalidUser.email = `${user}@${user}.com`;
            await testInvalidUser(invalidUser);
          }
        });

        it('should not create a user with an invalid username format - should test minimum and maximum characters', async function registerUser(): Promise<void> {
          // the username should contain between 8 and 20 characters
          let userNameList: string[] = ['test', 'TestQQwpnociqzkUyFOaTWPX'];

          const testInvalidUser = async (invalidUser: any) => {
            const result = await userService.register(invalidUser);
            should.exist(result);
            should.not.exist(result.payload);
            should.exist(result.status);
            result.status.code.should.equal(400);
            result.status.message.should.startWith('Error while validating username:');
          };

          const invalidUser = _.cloneDeep(user);
          for (let user of userNameList) {
            invalidUser.name = user;
            invalidUser.email = `${user}@${user}.com`;
            await testInvalidUser(invalidUser);
          }
        });

        it('should not create a user with an invalid username format - should test valid email', async function registerUser(): Promise<void> {
          // providing list of invalid email addresses
          let userNameList: string[] = [
            'invalid:email@example.com',
            '@somewhere.com',
            '@@example.com',
            'a space@example.com',
            'something@ex..ample.com',
            'a\b@c',
            'someone@somewhere.com.',
            '\'\'test\blah\'\'@example.com',
            '\'testblah\'@example.com',
            'test@test.com_',
            'test@test_com',
            'test@some:test.com',
            'F/s/f/a@feo+re.com',
            'some+long+email+address@some+host-weird-/looking.com',
            'a @p.com',
            'a\u0020@p.com',
            'a\u0009@p.com',
            'a\u000B@p.com',
            'a\u000C@p.com',
            'a\u2003@p.com',
            'a\u3000@p.com'
          ];

          const testInvalidUser = async (invalidUser: any) => {
            const result = await userService.register(invalidUser);
            should.exist(result);
            should.not.exist(result.payload);
            should.exist(result.status);
            result.status.code.should.equal(400);
            result.status.message.should.startWith('Error while validating username:');
          };

          const invalidUser = _.cloneDeep(user);
          for (let user of userNameList) {
            invalidUser.name = user;
            invalidUser.email = user;
            await testInvalidUser(invalidUser);
          }
        });

        it('should not create a user with no first or last name', async function registerUser(): Promise<void> {
          const invalidUser = _.cloneDeep(user);
          // change name and email
          invalidUser.name = 'test.user2';
          invalidUser.email = 'test.user2@test.user2.com';
          delete invalidUser.first_name;
          const result = await userService.register(invalidUser);
          should.exist(result);
          should.exist(result.status);
          should.not.exist(result.payload);
          result.status.code.should.equal(400);
          result.status.message.should.equal('User register requires both first and last name');
        });
      });

      describe('calling createUsers', function createUser(): void {
        const testuser2: any = {
          id: 'testuser2',
          // name: 'test.user2',
          first_name: 'test',
          last_name: 'user',
          // password: 'notsecure',
          // email: 'test2@ms.restorecommerce.io',
          role_associations: [{
            role: 'user-r-id',
            attributes: []
          }]
        };

        it('should not create a user with empty password', async function createUser(): Promise<void> {
          const result = await userService.create({ items: [testuser2] });
          should.exist(result);
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('argument password is empty');
        });

        it('should not create a user with empty email', async function createUser(): Promise<void> {
          // append password, but no email
          Object.assign(testuser2, { password: 'notsecure' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('argument email is empty');
        });

        it('should not create a user with empty name', async function createUser(): Promise<void> {
          // append email, but no name
          Object.assign(testuser2, { email: 'test2@ms.restorecommerce.io' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('argument name is empty');
        });

        it('should not create a user with invalid username - username contains "@" but is not valid email', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: 'something@ex..ample.com' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('Error while validating username: something@ex..ample.com, error: InvalidArgument, message:Username something@ex..ample.com is not a valid email!');
        });

        it('should not create a user with invalid username - minimum characters condition not met', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: 'test123' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('Error while validating username: test123, error: InvalidArgument, message:Username test123 is invalid! The username length must be between 8 and 20 characters!');
        });

        it('should not create a user with invalid username - maximum characters condition not met', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: 'TestQQwpnociqzkUyFOaTWPX' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('Error while validating username: TestQQwpnociqzkUyFOaTWPX, error: InvalidArgument, message:Username TestQQwpnociqzkUyFOaTWPX is invalid! The username length must be between 8 and 20 characters!');
        });

        it('should not create a user with invalid username - first character condition not met', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: '_TestTest' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('Error while validating username: _TestTest, error: InvalidArgument, message:Username _TestTest is invalid! The first letter should be one of the allowed characters: a-z A-Z or äöüÄÖÜß');
        });

        it('should not create a user with invalid username - allowed characters condition not met', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: 'Test?Test' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('Error while validating username: Test?Test, error: InvalidArgument, message:Username Test?Test is invalid! Please use only the allowed characters: a-z, A-Z, 0-9, äöüÄÖÜß and @_.- ');
        });

        it('should not create a user with invalid username - character repetition condition not met', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: 'Test--Test' });
          const result = await userService.create({ items: [testuser2] });
          should.not.exist(result.items[0].payload);
          result.items[0].status.code.should.equal(400);
          result.items[0].status.message.should.equal('Error while validating username: Test--Test, error: InvalidArgument, message:Username Test--Test is invalid! Character repetitions like __, .., -- are not allowed.');
        });

        it('should create a user and unregister it', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: 'test_user@n-fuse.co' });
          const result = await userService.create({ items: [testuser2] });
          should.exist(result.items[0].payload);
          result.items[0].payload.id.should.equal('testuser2');
          result.items[0].status.code.should.equal(200);
          result.items[0].status.message.should.equal('success');
          await userService.unregister({ identifier: result.items[0].payload.name });
        });

        it('should invite a user and confirm User Invitation', async function inviteUser(): Promise<void> {
          Object.assign(testuser2, { invite: true });
          const result = await userService.create({ items: [testuser2] });
          const userStatus = result.items[0].payload.active;
          userStatus.should.equal(false);
          // confirm Invitation
          await userService.confirmUserInvitation({
            identifier: testuser2.name,
            password: testuser2.password, activation_code: result.items[0].payload.activation_code
          });
          // read the user and now the status should be true
          const userData = await userService.find({ id: 'testuser2' });
          userData.items[0].payload.active.should.equal(true);
          // unregister
          await userService.unregister({ identifier: result.items[0].payload.name });
        });
      });

     describe('calling find', function findUser(): void {
        it('should return a user', async function findUser(): Promise<void> {
          const result = await (userService.find({
            id: testUserID,
          }));
          should.exist(result);
          should.exist(result.items[0].payload);
          should.exist(result.status);
          should.exist(result.items[0].status);
          result.items[0].status.code.should.equal(200);
          result.items[0].status.message.should.equal('success');
        });
      });

      describe('find by role', function findUserByRole(): void {
        it('should return a user for valid role', async function findUser(): Promise<void> {
          const result = await (userService.findByRole({
            role: 'normal_user',
          }));
          should.exist(result);
          should.exist(result.items[0].payload);
          should.exist(result.status);
          should.exist(result.items[0].status);
          result.items[0].status.code.should.equal(200);
          result.items[0].status.message.should.equal('success');
        });
        it('should not return a user for invalid role', async function findUser(): Promise<void> {
          const result = await (userService.findByRole({
            role: 'invalid_role',
          }));
          result.items.should.be.empty();
          should.exist(result.status);
          result.status.code.should.equal(404);
          result.status.message.should.equal('Role invalid_role does not exist');
        });
      });
      /*
      describe('login', function login(): void {
        it('should return an error for invalid user identifier', async function login(): Promise<void> {
          const result = await (userService.login({
            identifier: 'invalid_id',
            password: 'invalid_pw',
          }));
          should.exist(result);
          should.exist(result.error);
          should.not.exist(result.data);
          should.exist(result.error.message);
          result.error.message.should.containEql('not found');
          result.error.details.should.containEql('user not found');
        });

        it('should return an obfuscated error for invalid user identifier', async function login(): Promise<void> {
          cfg.set('obfuscateAuthNErrorReason', true);
          const result = await (userService.login({
            identifier: 'invalid_id',
            password: 'invalid_pw',
          }));
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('FailedPrecondition');
          should.exist(result.error.details);
          result.error.details.should.equal('9 FAILED_PRECONDITION: Invalid credentials provided, user inactive or account does not exist');
          cfg.set('obfuscateAuthNErrorReason', false);
        });

        it('without activation should throw an error that user is inactive',
          async function login(): Promise<void> {
            const result = await (userService.login({
              identifier: user.name,
              password: user.password,
            }));
            should.exist(result);
            should.not.exist(result.data);
            should.exist(result.error);
            should.exist(result.error.name);
            result.error.name.should.equal('FailedPrecondition');
            should.exist(result.error.details);
            result.error.details.should.equal('9 FAILED_PRECONDITION: user is inactive');
          });

        it('without activation should throw an error that user not authenticated' +
          ' when error message is obfuscated', async function login(): Promise<void> {
            cfg.set('obfuscateAuthNErrorReason', true);
            const result = await (userService.login({
              identifier: user.name,
              password: user.password,
            }));
            should.exist(result);
            should.not.exist(result.data);
            should.exist(result.error);
            should.exist(result.error.name);
            result.error.name.should.equal('FailedPrecondition');
            should.exist(result.error.details);
            result.error.details.should.equal('9 FAILED_PRECONDITION: Invalid credentials provided, user inactive or account does not exist');
            cfg.set('obfuscateAuthNErrorReason', false);
          });

        it('should activate the user', async function activateUser(): Promise<void> {
          const offset = await topic.$offset(-1);
          const listener = function listener(message: any, context: any): void {
            result.data.items[0].id.should.equal(message.id);
          };
          await topic.on('activated', listener);
          let result = await (userService.find({
            id: testUserID,
          }));
          should.exist(result);
          should.exist(result.data);
          should.exist(result.data.items);
          result.data.items.should.be.length(1);

          const u = result.data.items[0];
          await (userService.activate({
            identifier: u.name,
            activation_code: u.activation_code,
          }));

          await topic.$wait(offset);
          result = await (userService.find({
            id: testUserID,
          }));
          should.exist(result);
          should.exist(result.data);
          should.exist(result.data.items);
          result.data.items.should.be.length(1);
          should.exist(result.data.items[0].active);
          result.data.items[0].active.should.be.true();
          result.data.items[0].activation_code.should.be.empty();
          await topic.removeListener('activated', listener);
        });

        it('should return verify password and return the user', async function login(): Promise<void> {
          const result = await (userService.login({
            identifier: user.name,
            password: user.password,
          }));
          should.exist(result);
          should.not.exist(result.error);
          should.exist(result.data);

          const compareResult = await (userService.find({
            id: testUserID,
          }));
          const userDBDoc = compareResult.data.items[0];
          result.data.should.deepEqual(userDBDoc);
        });

        it('should return an obfuscated error in case the passwords don`t match', async function login(): Promise<void> {
          cfg.set('obfuscateAuthNErrorReason', true);
          const result = await (userService.login({
            identifier: user.name,
            password: 'invalid_pw',
          }));
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('FailedPrecondition');
          should.exist(result.error.details);
          result.error.details.should.equal('9 FAILED_PRECONDITION: Invalid credentials provided, user inactive or account does not exist');
          cfg.set('obfuscateAuthNErrorReason', false);
        });

        it('should return concise error in case the passwords don`t match', async function login(): Promise<void> {
          const result = await (userService.login({
            identifier: user.name,
            password: 'invalid_pw',
          }));
          should.exist(result);
          should.exist(result.error);
          should.not.exist(result.data);
          should.exist(result.error.message);
          result.error.message.should.containEql('unauthenticated');
          result.error.details.should.containEql('password does not match');
        });
      });
      /*
      describe('calling changePassword', function changePassword(): void {
        it('should change the password', async function changePassword(): Promise<void> {
          this.timeout(30000);
          const offset = await topic.$offset(-1);
          const listener = function listener(message: any, context: any): void {
            pwHashA.should.not.equal(message.password_hash);
          };
          await topic.on('passwordChanged', listener);
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const pwHashA = result.data.items[0].password_hash;
          result = await (userService.changePassword({
            identifier: testUserName,
            password: 'notsecure',
            new_password: 'newPassword'
          }));
          should.exist(result);
          should.not.exist(result.error);
          await topic.$wait(offset);

          result = await (userService.find({
            id: testUserID,
          }));
          const pwHashB = result.data.items[0].password_hash;
          pwHashB.should.not.be.null();
          pwHashA.should.not.equal(pwHashB);
          await topic.removeListener('passwordChanged', listener);
        });

        it('should generate a UUID when requesting a password change', async function requestPasswordChange(): Promise<void> {
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const activationCode = result.data.items[0].activation_code;
          activationCode.should.be.length(0);

          result = await userService.requestPasswordChange({
            identifier: user.name
          });
          should.exist(result);
          should.not.exist(result.error);

          result = await (userService.find({
            id: testUserID,
          }));
          const upUser = result.data.items[0];
          upUser.activation_code.should.not.be.empty();
        });

        it('should confirm a password change by providing the UUID', async function requestPasswordChange(): Promise<void> {
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const activationCode = result.data.items[0].activation_code;
          activationCode.should.not.be.null();
          const pwHashA = result.data.items[0].password_hash;

          result = await userService.confirmPasswordChange({
            identifier: user.name,
            password: 'newPassword2',
            activation_code: activationCode
          });

          should.exist(result);
          should.not.exist(result.error);

          result = await (userService.find({
            id: testUserID,
          }));
          const upUser = result.data.items[0];
          upUser.activation_code.should.be.empty();
          upUser.password_hash.should.not.equal(pwHashA);
        });
      });

      describe('calling changeEmail', function changeEmailId(): void {
        it('should request the email change and persist it without overriding the old email', async function requestEmailChange(): Promise<void> {
          this.timeout(30000);
          const validate = (user: User) => {
            const new_email = user.new_email;
            const email = user.email;
            const activationCode = user.activation_code;

            new_email.should.not.be.null();
            email_old.should.not.equal(new_email);
            new_email.should.equal('newmail@newmail.com');
            activationCode.should.not.be.null();
          };

          const listener = function listener(message: any, context: any): void {
            validate(message);
          };

          await topic.on('emailChangeRequested', listener);
          const offset = await topic.$offset(-1);
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const email_old = result.data.items[0].email;
          result = await (userService.requestEmailChange({
            identifier: testUserName,
            new_email: 'newmail@newmail.com',
          }));
          should.exist(result);
          should.not.exist(result.error);

          await topic.$wait(offset);
          const filters = [{
            filter: [{
              field: 'id',
              operation: FilterOperation.eq,
              value: testUserID
            }]
          }];
          result = await (userService.read({ filters }));

          const dbUser: User = result.data.items[0];
          validate(dbUser);
          await topic.removeListener('emailChangeRequested', listener);
        });

        it('should change the user email upon confirmation', async function confirmEmailChange(): Promise<void> {
          this.timeout(30000);
          const validate = (user: User) => {
            const email = user.email;
            email.should.equal('newmail@newmail.com');
          };

          const listener = function listener(message: any, context: any): void {
            validate(message);
          };
          await topic.on('emailChangeConfirmed', listener);
          const offset = await topic.$offset(-1);
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const activationCode = result.data.items[0].activation_code;
          result = await (userService.confirmEmailChange({
            activation_code: activationCode,
            identifier: user.name
          }));
          should.exist(result);
          should.not.exist(result.error);

          await topic.$wait(offset);
          const filters = [{
            filter: [{
              field: 'id',
              operation: FilterOperation.eq,
              value: testUserID
            }]
          }];
          result = await (userService.read({ filters }));
          const dbUser: User = result.data.items[0];
          validate(dbUser);
          dbUser.new_email.should.be.empty();
          dbUser.activation_code.should.be.empty();
          await topic.removeListener('emailChangeConfirmed', listener);
        });
      });

      describe('calling update', function changeEmailId(): void {
        it('should update generic fields', async function changeEmailId(): Promise<void> {
          this.timeout(3000);
          const listener = function listener(message: any, context: any): void {
            should.exist(message);

            const newUser = message;
            newUser.first_name.should.equal('John');
            newUser.first_name.should.not.equal(user.first_name);
          };
          await topic.on('userModified', listener);

          const offset = await topic.$offset(-1);
          const result = await userService.update([{
            id: testUserID,
            name: 'test.user1', // existing user
            first_name: 'John',
            meta
          }]);
          await topic.$wait(offset);
          should.exist(result);
          should.not.exist(result.error);
          await topic.removeListener('userModified', listener);
        });

        it(`should allow to update special fields such as 'email' and 'password`, async function changeEmailId(): Promise<void> {
          this.timeout(3000);

          let result = await userService.update([{
            id: testUserID,
            name: 'test.user1', // existing user
            email: 'update@restorecommerce.io',
            password: 'notsecure2',
            first_name: 'John'
          }]);
          should.exist(result.data);
          should.not.exist(result.error);
          should.exist(result.data.items);
          result.data.items[0].email.should.equal('update@restorecommerce.io');
          result.data.items[0].password.should.equal('');
        });

        it(`should not allow to update 'name' field`,
          async function changeEmailId(): Promise<void> {
            this.timeout(3000);

            let result = await userService.update([{
              id: testUserID,
              name: 'new_name'
            }]);
            should.not.exist(result.data);
            should.exist(result.error);
            result.error.name.should.equal('InvalidArgument');
            result.error.details.should.equal('3 INVALID_ARGUMENT: User name field cannot be updated');
          });
      });

      describe('calling unregister', function unregister(): void {
        it('should remove the user', async function unregister(): Promise<void> {
          await userService.unregister({
            identifier: testUserName,
          });

          // this would throw an error since user does not exist
          await userService.delete({
            ids: testUserID
          });

          const result = await userService.find({
            id: testUserID,
          });
          should.not.exist(result.data);
          should.exist(result.error);
          should.equal(result.error.message, 'not found');
        });
      });

      describe('calling sendInvitationEmail', function sendInvitationEmail(): void {
        let sampleUser, invitingUser;
        before(async () => {
          sampleUser = {
            id: '345testuser2id',
            name: 'sampleuser1',
            first_name: 'sampleUser7_first',
            last_name: 'user',
            password: 'notsecure3443',
            email: 'sampleUser3@ms.restorecommerce.io',
            role_associations: [{
              role: 'user-r-id',
              attributes: []
            }]
          };
          invitingUser = {
            id: '123invitingUserId',
            name: 'invitinguser',
            first_name: 'invitingUser_first',
            last_name: 'invitingUser_last',
            password: 'notsecure',
            email: 'invitingUser@ms.restorecommerce.io',
            role_associations: [{
              role: 'user-r-id',
              attributes: []
            }]
          };
          await userService.create({ items: [sampleUser, invitingUser] });
        });

        it('should emit a renderRequest for sending the email', async function sendInvitationEmail(): Promise<void> {

          const listener = function listener(message: any, context: any): void {
            message.id.should.equal(`identity#${sampleUser.email}`);
          };
          await topic.on('renderRequest', listener);
          const result = await (userService.sendInvitationEmail({ identifier: sampleUser.name, invited_by_user_identifier: invitingUser.name }));
          should.exist(result);
          should.not.exist(result.error);
          await topic.removeListener('renderRequest', listener);
        });
      });

      describe('calling upsert', function upsert(): void {
        it('should upsert (create) user', async function upsert(): Promise<void> {
          let result = await userService.upsert([{
            name: 'upsertuser',
            email: 'upsert@restorecommerce.io',
            password: 'testUpsert',
            first_name: 'John',
            last_name: 'upsert'
          }]);
          upserUserID = result.data.items[0].id;
          should.exist(result.data);
          should.not.exist(result.error);
          should.exist(result.data.items);
          result.data.items[0].email.should.equal('upsert@restorecommerce.io');
          result.data.items[0].password.should.equal('');
        });

        it('should upsert (update) user and delete user collection', async function upsert(): Promise<void> {
          let result = await userService.upsert([{
            id: upserUserID,
            name: 'upsertuser',
            email: 'upsert2@restorecommerce.io',
            password: 'testUpsert2',
            first_name: 'John',
            last_name: 'upsert2'
          }]);
          should.exist(result.data);
          should.not.exist(result.error);
          should.exist(result.data.items);
          result.data.items[0].email.should.equal('upsert2@restorecommerce.io');
          result.data.items[0].password.should.equal('');
          // delete user collection
          await userService.delete({
            collection: true
          });
        });
      });

      // HR scoping tests
      describe('testing hierarchical scopes with authroization enabled', function registerUser(): void {
        // mainOrg -> orgA -> orgB -> orgC
        const testUser: any = {
          id: 'testuser',
          name: 'test.user',
          first_name: 'test',
          last_name: 'user',
          password: 'password',
          email: 'test@restorecommerce.io',
          role_associations: [{
            role: 'user-r-id',
            attributes: [{
              id: 'urn:restorecommerce:acs:names:roleScopingEntity',
              value: 'urn:restorecommerce:acs:model:organization.Organization'
            },
            {
              id: 'urn:restorecommerce:acs:names:roleScopingInstance',
              value: 'orgC'
            }]
          }]
        };

        let subject = {
          id: 'admin_user_id',
          scope: 'orgA',
          role_associations: [
            {
              role: 'admin-r-id',
              attributes: [{
                id: 'urn:restorecommerce:acs:names:roleScopingEntity',
                value: 'urn:restorecommerce:acs:model:organization.Organization'
              },
              {
                id: 'urn:restorecommerce:acs:names:roleScopingInstance',
                value: 'mainOrg'
              }]
            }
          ],
          hierarchical_scopes: [
            {
              id: 'mainOrg',
              role: 'admin-r-id',
              children: [{
                id: 'orgA',
                children: [{
                  id: 'orgB',
                  children: [{
                    id: 'orgC'
                  }]
                }]
              }]
            }
          ]
        };

        it('should allow to create a User with valid role and valid valid HR scope', async () => {
          // enable and enforce authorization
          cfg.set('authorization:enabled', true);
          cfg.set('authorization:enforce', true);
          updateConfig(cfg);
          const result = await userService.create({ items: testUser, subject });
          should.exist(result);
          should.exist(result.data);
          should.exist(result.data.items);
          result.data.items[0].id.should.equal('testuser');
        });
        it('should allow to update a User role_associations, first and last name with valid role and valid HR scope', async () => {
          testUser.first_name = 'testFirstName';
          testUser.last_name = 'testLastName';
          // Add OrgB user scope as well
          testUser.role_associations.push({
            role: 'user-r-id',
            attributes: [{
              id: 'urn:restorecommerce:acs:names:roleScopingEntity',
              value: 'urn:restorecommerce:acs:model:organization.Organization'
            },
            {
              id: 'urn:restorecommerce:acs:names:roleScopingInstance',
              value: 'orgB'
            }]
          });
          const result = await userService.update({ items: testUser, subject });
          should.exist(result);
          should.exist(result.data);
          should.exist(result.data.items);
          result.data.items[0].id.should.equal('testuser');
          result.data.items[0].first_name.should.equal('testFirstName');
          result.data.items[0].last_name.should.equal('testLastName');
          result.data.items[0].role_associations[0].attributes[1].value.should.equal('orgC');
          result.data.items[0].role_associations[1].attributes[1].value.should.equal('orgB');
          await userService.unregister({ identifier: result.data.items[0].name });
        });

        it('should not allow to create a User with invalid role existing in system', async () => {
          testUser.role_associations[0].role = 'invalid_role';
          const result = await userService.create({ items: testUser, subject });
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('InvalidArgument');
          should.exist(result.error.details);
          result.error.details.should.equal('3 INVALID_ARGUMENT: The target role invalid_role is invalid and cannot be assigned to user test.user');
        });

        it('should not allow to create a User with role assocation which is not assignable', async () => {
          testUser.role_associations[0].role = 'super-admin-r-id';
          const result = await userService.create({ items: testUser, subject });
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('InvalidArgument');
          should.exist(result.error.details);
          result.error.details.should.equal('3 INVALID_ARGUMENT: The target role super-admin-r-id cannot be assigned to user test.user as user role admin-r-id does not have permissions');
        });

        it('should throw an error when hierarchical do not match creator role', async () => {
          testUser.role_associations[0].role = 'user-r-id';
          // auth_context not containing valid creator role (admin-r-id)
          subject.hierarchical_scopes = [
            {
              id: 'mainOrg',
              role: 'user-r-id',
              children: [{
                id: 'orgA',
                children: [{
                  id: 'orgB',
                  children: [{
                    id: 'orgC'
                  }]
                }]
              }]
            }
          ];
          const result = await userService.create({ items: testUser, subject });
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('InvalidArgument');
          should.exist(result.error.details);
          result.error.details.should.equal('3 INVALID_ARGUMENT: No Hierarchical Scopes could be found');
        });

        it('should not allow to create a User with role assocation with invalid hierarchical_scope', async () => {
          testUser.role_associations[0].role = 'user-r-id';
          // auth_context missing orgC in HR scope
          subject.hierarchical_scopes = [
            {
              id: 'mainOrg',
              role: 'admin-r-id',
              children: [{
                id: 'orgA',
                children: [{
                  id: 'orgB',
                  children: [] // orgC is missing in HR scope
                }]
              }]
            }
          ];
          const result = await userService.create({ items: testUser, subject });
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('InvalidArgument');
          should.exist(result.error.details);
          result.error.details.should.equal('3 INVALID_ARGUMENT: the role user-r-id cannot be assigned to user test.user;do not have permissions to assign target scope orgC for test.user');

          // disable authorization
          cfg.set('authorization:enabled', false);
          cfg.set('authorization:enforce', false);
          updateConfig(cfg);

          // delete user and roles collection
          await userService.delete({
            collection: true
          });
          await roleService.delete({
            collection: true
          });
          // stop mock acs-srv
          stopGrpcMockServer();
        });
      });*/
    });
  });
});
