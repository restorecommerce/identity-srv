import * as mocha from 'mocha';
import * as should from 'should';
import * as _ from 'lodash';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import { Worker } from '../lib/worker';
import * as sconfig from '@restorecommerce/service-config';
import { User } from '../lib/service';
import { Topic } from '@restorecommerce/kafka-client/lib/events/provider/kafka';
import { createMockServer } from 'grpc-mock';

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
  cfg = sconfig(process.cwd() + '/test');
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
    value: 'urn:restorecommerce:acs:model:user.User'
  },
  {
    id: 'urn:restorecommerce:acs:names:ownerInstance',
    value: 'UserID'
  }]
};

interface serverRule {
  method: string,
  input: any,
  output: any
};

const permitRule = {
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

let policySetRQ = {
  policy_sets:
    [{
      combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
      id: 'test_policy_set_id',
      policies: [
        {
          combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
          id: 'test_policy_id',
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

  describe('testing User service', () => {
    describe('with test client', () => {
      let userService;
      let testUserID;
      let upserUserID;
      let user;
      before(async function connectUserService(): Promise<void> {
        userService = await connect('client:service-user', 'user.resource');
        user = {
          name: 'test.user1',
          first_name: 'test',
          last_name: 'user',
          password: 'notsecure',
          email: 'test@ms.restorecommerce.io',
          role_associations: [{
            role: 'user-r-id',
            attributes: []
          }]
        };
      });

      describe('calling register', function registerUser(): void {
        it('should create a user', async function registerUser(): Promise<void> {
          const listener = function listener(message: any, context: any): void {
            user.name.should.equal(message.name);
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
          should.exist(data.name);
          data.name.should.equal(user.name);
          should.exist(data.password_hash);
          should.exist(data.email);
          data.email.should.equal(user.email);
          data.active.should.be.false();
          data.activation_code.should.not.be.empty();
          const getResult = await userService.read({
            filter: grpcClient.toStruct({
              id: data.id
            })
          });
          should.exist(getResult);
          should.exist(getResult.data);
          should.not.exist(getResult.error);
          getResult.data.items[0].should.deepEqual(data);
          await topic.removeListener('registered', listener);
        });
        it('should create guest User', async function registerUserAgain(): Promise<void> {
          const guest_user = {
            id: 'guest_id',
            name: 'guest_user',
            first_name: 'guest_first_name',
            last_name: 'guest_last_name',
            password: 'notsecure',
            email: 'guest@guest.com',
            guest: true,
            role_associations: [{
              role: 'user-r-id',
              attributes: []
            }]
          };
          const result = await (userService.register(guest_user));
          should.exist(result);
          should.exist(result.data);
          result.data.id.should.equal('guest_id');
          result.data.guest.should.equal(true);
          await userService.unregister({ id: 'guest_id' });
        });
        it('should throw an error when registering same user', async function registerUserAgain(): Promise<void> {
          const result = await (userService.register(user));
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('AlreadyExists');
        });
        it('should not create a user with an invalid username format', async function registerUser(): Promise<void> {
          const invalidUser = _.cloneDeep(user);
          invalidUser.name = 'Test User';
          const result = await userService.register(invalidUser);
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
        });
        it('should not create a user with no first or last name', async function registerUser(): Promise<void> {
          const invalidUser = _.cloneDeep(user);
          delete invalidUser.first_name;
          const result = await userService.register(invalidUser);
          should.exist(result);
          should.not.exist(result.data);
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
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
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal('3 INVALID_ARGUMENT: argument password is empty');
        });
        it('should not create a user with empty email', async function createUser(): Promise<void> {
          // append password, but no email
          Object.assign(testuser2, { password: 'notsecure' });
          const result = await userService.create({ items: [testuser2] });
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal('3 INVALID_ARGUMENT: argument email is empty');
        });
        it('should not create a user with empty name', async function createUser(): Promise<void> {
          // append email, but no name
          Object.assign(testuser2, { email: 'test2@ms.restorecommerce.io' });
          const result = await userService.create({ items: [testuser2] });
          should.exist(result.error);
          result.error.name.should.equal('InvalidArgument');
          result.error.details.should.equal('3 INVALID_ARGUMENT: argument name is empty');
        });
        it('should create a user and unregister it', async function createUser(): Promise<void> {
          // append name
          Object.assign(testuser2, { name: 'test.user2' });
          const result = await userService.create({ items: [testuser2] });
          should.exist(result);
          should.exist(result.data);
          should.exist(result.data.items);
          result.data.items[0].id.should.equal('testuser2');
          await userService.unregister({ id: 'testuser2' });
        });
        it('should invite a user and confirm User Invitation', async function inviteUser(): Promise<void> {
          Object.assign(testuser2, { invite: true });
          const result = await userService.create({ items: [testuser2] });
          const userStatus = result.data.items[0].active;
          userStatus.should.equal(false);
          // confirm Invitation
          await userService.confirmUserInvitation({
            name: testuser2.name,
            password: testuser2.password, activation_code: result.data.items[0].activation_code
          }, null);
          // read the user and now the status should be true
          const userData = await userService.find({ id: 'testuser2' });
          userData.data.items[0].active.should.equal(true);
          // unregister
          await userService.unregister({ id: 'testuser2' });
        });
      });
      describe('calling find', function findUser(): void {
        it('should return a user', async function findUser(): Promise<void> {
          const result = await (userService.find({
            id: testUserID,
          }));
          should.exist(result);
          should.not.exist(result.error);
          should.exist(result.data);
          should.exist(result.data.items);
        });
      });
      describe('find by role', function findUserByRole(): void {
        it('should return a user', async function findUser(): Promise<void> {
          const result = await (userService.findByRole({
            role: 'normal_user',
          }));
          should.exist(result);
          should.not.exist(result.error);
          should.exist(result.data);
          should.exist(result.data.items);
        });
      });

      describe('login', function login(): void {
        it('without activation should throw an error that user not activated',
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
            result.error.details.should.equal('9 FAILED_PRECONDITION: user not activated');
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
            name: u.name,
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
        it('should return an error in case the passwords don`t match', async function login(): Promise<void> {
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
      describe('calling changePassword', function changePassword(): void {
        it('should change the password', async function changePassword(): Promise<void> {
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
            id: testUserID,
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
        });

        it('should generate a UUID when requesting a password change', async function requestPasswordChange(): Promise<void> {
          const offset = await topic.$offset(-1);
          // const listener = function listener(message: any, context: any): void {
          //   // pwHashA.should.not.equal(message.password_hash);
          // };
          await topic.on('passwordChangeRequested', () => { });
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const activationCode = result.data.items[0].activation_code;
          activationCode.should.be.length(0);

          result = await userService.requestPasswordChange({
            name: user.name
          });
          should.exist(result);
          should.not.exist(result.error);
          await topic.$wait(offset);

          result = await (userService.find({
            id: testUserID,
          }));
          const upUser = result.data.items[0];
          upUser.activation_code.should.not.be.empty();
        });

        it('should confirm a password change by providing the UUID', async function requestPasswordChange(): Promise<void> {
          const offset = await topic.$offset(-1);
          // const listener = function listener(message: any, context: any): void {
          //   // pwHashA.should.not.equal(message.password_hash);
          // };
          await topic.on('passwordChanged', () => { });
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const activationCode = result.data.items[0].activation_code;
          activationCode.should.not.be.null();
          const pwHashA = result.data.items[0].password_hash;

          result = await userService.confirmPasswordChange({
            name: user.name,
            password: 'newPassword2',
            activation_code: activationCode
          });

          should.exist(result);
          should.not.exist(result.error);

          await topic.$wait(offset);

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
          this.timeout(3000);
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
            id: testUserID,
            email: 'newmail@newmail.com',
          }));
          should.exist(result);
          should.not.exist(result.error);

          await topic.$wait(offset);

          result = await (userService.read({
            filter: grpcClient.toStruct({
              id: testUserID
            })
          }));

          const dbUser: User = result.data.items[0];
          validate(dbUser);
        });

        it('should change the user email upon confirmation', async function confirmEmailChange(): Promise<void> {
          this.timeout(3000);
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
            name: user.name
          }));
          should.exist(result);
          should.not.exist(result.error);

          await topic.$wait(offset);
          result = await (userService.read({
            filter: grpcClient.toStruct({
              id: testUserID
            })
          }));
          const dbUser: User = result.data.items[0];
          validate(dbUser);
          dbUser.new_email.should.be.empty();
          dbUser.activation_code.should.be.empty();
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
            name: 'test.user1', // existing user name
            first_name: 'John',
            meta
          }]);
          await topic.$wait(offset);
          should.exist(result);
          should.not.exist(result.error);
        });

        it(`should allow to update special fields such as 'email' and 'password`, async function changeEmailId(): Promise<void> {
          this.timeout(3000);

          let result = await userService.update([{
            id: testUserID,
            name: 'test.user1',
            email: 'update@restorecommerce.io',
            password: 'notsecure2',
            first_name: 'John',
            meta
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
              name: 'new_name',
              meta
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
            id: testUserID,
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
            last_name: 'upsert2',
            meta
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

        let auth_context = {
          id: 'admin_user_id',
          scope: 'orgC',
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
          policySetRQ.policy_sets[0].policies[0].rules[0] = permitRule;
          // start mock acs-srv
          startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: policySetRQ },
          { method: 'IsAllowed', input: '.*', output: {} }]);
          const result = await userService.create({ items: testUser, auth_context });
          should.exist(result);
          should.exist(result.data);
          should.exist(result.data.items);
          result.data.items[0].id.should.equal('testuser');
          await userService.unregister({ id: 'testuser' });
        });
        it('should not allow to create a User with invalid role existing in system', async () => {
          testUser.role_associations[0].role = 'invalid_role';
          const result = await userService.create({ items: testUser, auth_context });
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('InvalidArgument');
          should.exist(result.error.details);
          result.error.details.should.equal('3 INVALID_ARGUMENT: One or more of the target role IDs are invalid invalid_role, no such role exist in system');
        });
        it('should not allow to create a User with role assocation which is not assignable', async () => {
          testUser.role_associations[0].role = 'super-admin-r-id';
          const result = await userService.create({ items: testUser, auth_context });
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('InvalidArgument');
          should.exist(result.error.details);
          result.error.details.should.equal('3 INVALID_ARGUMENT: The target role super-admin-r-id cannot be assigned to user test.user as user role admin-r-id does not have permissions');
        });
        it('should not allow to create a User with role assocation with invalid hierarchical_scope', async () => {
          testUser.role_associations[0].role = 'user-r-id';
          // auth_context missing orgC in HR scope
          auth_context.hierarchical_scopes = [
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
          const result = await userService.create({ items: testUser, auth_context });
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.name);
          result.error.name.should.equal('PermissionDenied');
          should.exist(result.error.details);
          result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for a request from user admin_user_id for resource user; the response was DENY');
          // stop mock acs-srv
          stopGrpcMockServer();
          // delete user and roles collection
          await userService.delete({
            collection: true
          });
          await roleService.delete({
            collection: true
          });
        });
      });
    });
  });
});
