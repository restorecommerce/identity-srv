'use strict';

import * as mocha from 'mocha';
import * as co from 'co';
import * as should from 'should';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import { Worker } from '../worker';
import * as sconfig from '@restorecommerce/service-config';

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
let roleService, userService;

async function start() {
  cfg = sconfig(process.cwd() + '/test');
  worker = new Worker(cfg);
  await worker.start();
}

async function connect(clientCfg: string, resourceName: string) {
  logger = worker.logger;

  events = new Events(cfg.get('events:kafka'), logger);
  await (events.start());
  topic = events.topic(cfg.get(`events:kafka:topics:${resourceName}:topic`));

  client = new grpcClient.Client(cfg.get(clientCfg), logger);
  const service = await client.connect();
  return service;
}

describe('testing identity-srv', () => {
  before(async function startServer() {
    await start();
  });


  after(async function stopServer() {
    await worker.stop();
  });

  describe('testing Role service', () => {
    describe('with test client', () => {

      before(async function connectRoleService() {
        roleService = await connect('client:service-role', 'roles.resource');
      });

      it('should create roles', async () => {
        const role = {
          name: 'normal_user',
          description: 'Normal user'
        };

        const listener = function listener(message, context) {
          role.name.should.equal(message.name);
          role.description.should.equal(message.description);
        };

        const offset = await topic.$offset(-1);
        await topic.on('rolesCreated', listener);
        const result = await roleService.create({
          items: [
            {
              name: 'normal_user',
              description: 'Normal user'
            }
          ]
        });

        await topic.$wait(offset);

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
      before(async function connectUserService() {
        userService = await connect('client:service-user', 'users.resource');
        user = {
          name: 'testuser',
          password: 'notsecure',
          email: 'test@ms.restorecommerce.io'
        };
      });

      describe('calling register', function registerUser() {
        it('should create a user and person', async function registerUser() {
          user.role_associations = [{
            role: roleID,
            attributes: []
          }];

          const listener = function listener(message, context) {
            user.name.should.equal(message.name);
            user.email.should.equal(message.email);
          };
          await topic.on('registered', listener);
          const result = await (userService.register(user));
          should.exist(result);
          should.exist(result.data);
          should.not.exist(result.error);
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
          const filter = grpcClient.toStruct({
            id: data.id,
          });
          const getResult = await userService.read({
            filter,
          });
          should.exist(getResult);
          should.exist(getResult.data);
          should.not.exist(getResult.error);
          getResult.data.items[0].should.deepEqual(data);

        });
      });
      describe('calling find', function findUser() {
        it('should return a user', async function findUser() {
          const result = await (userService.find({
            id: testUserID,
          }));
          should.exist(result);
          should.not.exist(result.error);
          should.exist(result.data);
          should.exist(result.data.items);
        });
      });
      describe('verifyPassword', function verifyPassword() {
        it('should return true and the user ID for a match', async function verifyPassword() {
          const result = await (userService.verifyPassword({
            user: user.name,
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
      });
      describe('calling activate', function activateUser() {
        it('should activate the user', async function activateUser() {
          const offset = await topic.$offset(-1);
          const listener = function listener(message, context) {
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
            id: u.id,
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
      describe('calling changePassword', function changePassword() {
        it('should change the password', async function changePassword() {
          const offset = await topic.$offset(-1);
          const listener = function listener(message, context) {
            pwHashA.should.not.equal(message.password_hash);
          };
          await topic.on('passwordChanged', listener);
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const pwHashA = result.data.items[0].password_hash;
          await (userService.changePassword({
            id: testUserID,
            password: 'newPassword',
          }));
          await topic.$wait(offset);
          result = await (userService.find({
            id: testUserID,
          }));
          const pwHashB = result.data.items[0].password_hash;
          pwHashB.should.not.be.null();
          pwHashA.should.not.equal(pwHashB);
        });
      });
      describe('calling changeEmailId', function changeEmailId() {
        it('should change the Email ID', async function changeEmailId() {
          this.timeout(3000);
          const listener = function listener(message, context) {
            emailOld.should.not.equal(message.email);
          };
          await topic.on('emailIdChanged', listener);
          const offset = await topic.$offset(-1);
          let result = await userService.find({
            id: testUserID,
          });
          should.exist(result.data);
          should.exist(result.data.items);
          const emailOld = result.data.items[0].email;
          await (userService.changeEmailId({
            id: testUserID,
            email: 'newmail@newmail.com',
          }));
          await topic.$offset(offset);
          result = await (userService.find({
            id: testUserID,
          }));
          const emailNew = result.data.items[0].email;
          emailNew.should.not.be.null();
          emailOld.should.not.equal(emailNew);
        });
      });
      describe('calling unregister', function unregister() {
        it('should remove the user and person', async function unregister() {
          await userService.unregister({
            id: testUserID,
          });

          await roleService.delete({
            ids: user.role_associations[0].role
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
