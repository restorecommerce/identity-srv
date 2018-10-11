import * as mocha from 'mocha';
import * as should from 'should';
import * as _ from 'lodash';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import { Worker } from '../worker';
import * as sconfig from '@restorecommerce/service-config';
import { equal } from 'assert';
import { UserService, RoleService, User } from '../service';

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
let topic;
let roleID;
let roleService: any, userService: any;

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

describe('testing identity-srv', () => {
  before(async function startServer(): Promise<void> {
    await start();
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
        const role = {
          name: 'normal_user',
          description: 'Normal user',
          meta
        };

        const result = await roleService.create({
          items: [role]
        });

        should.not.exist(result.error);
        should.exist(result);
        should.exist(result.data);
        should.exist(result.data.items);
        result.data.items.should.have.length(1);
        roleID = result.data.items[0].id;
      });
    });

  });

  describe('testing User service', () => {
    describe('with test client', () => {
      let userService;
      let testUserID;
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
            role: roleID,
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
        it('should return verify password and return the user', async function login(): Promise<void> {
          const result = await (userService.login({
            name: user.name,
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
            name: user.name,
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
      describe('calling activate', function activateUser(): void {
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
          await topic.on('passwordChangeRequested', () => {});
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
          await topic.on('passwordChanged', () => {});
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
            const emailNew = user.emailNew;
            const email = user.email;
            const activationCode = user.activation_code;

            emailNew.should.not.be.null();
            emailOld.should.not.equal(emailNew);
            emailNew.should.equal('newmail@newmail.com');
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
          const emailOld = result.data.items[0].email;
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
          dbUser.emailNew.should.be.empty();
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
            first_name: 'John',
            meta
          }]);
          await topic.$wait(offset);
          should.exist(result);
          should.not.exist(result.error);
        });

        it('should not allow to update "special" fields', async function changeEmailId(): Promise<void> {
          this.timeout(3000);

          let result = await userService.update([{
            id: testUserID,
            password: 'notsecure2'
          }]);
          should.not.exist(result.data);
          should.exist(result.error);
          should.exist(result.error.message);
          result.error.message.should.equal('invalid argument');
          result.error.details.should.containEql('Generic update operation is not allowed for field password');
        });
      });
      describe('calling unregister', function unregister(): void {
        it('should remove the user and person', async function unregister(): Promise<void> {
          await userService.unregister({
            id: testUserID,
          });

          await roleService.delete({
            collection: true
          });

          const result = await userService.find({
            id: testUserID,
          });
          should.not.exist(result.data);
          should.exist(result.error);
          should.equal(result.error.message, 'not found');
        });
      });
    });
  });
});
