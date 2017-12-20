'use strict';

import * as mocha from 'mocha';
import * as coMocha from 'co-mocha';
import * as co from 'co';

coMocha(mocha);

import * as should from 'should';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import { Worker } from '../worker';
const Events = kafkaClient.Events;
const sconfig = require('@restorecommerce/service-config');
import * as service from './../service';

/* global describe before after it*/
let cfg;
describe('restore-user-srv blackbox testing', () => {
  let worker;

  before(async function startServer() {
    cfg = sconfig(process.cwd() + '/test');
    worker = new Worker({}, cfg);
    await worker.start();
  });

  after(async function stopServer() {
    await worker.end();
  });
  describe('with test client', () => {
    let client;
    let logger;
    let userService;
    // For event listeners
    let buff = [];
    let events;
    let topic;

    before(async function connect() {
      logger = Logger(cfg.get('logger'));
      client = new grpcClient.Client(cfg.get('client:blackbox'), logger);
      userService = await client.connect();

      events = new Events(cfg.get('events:kafka'), logger);
      await (events.start());
      topic = events.topic('io.restorecommerce.users.resource');
    });
    after(async function disconnect() {
      await client.end();
      await events.stop();
    });
    const user = {
      name: 'testuser',
      password: 'notsecure',
      email: 'test@ms.restorecommerce.io',
    };
    let testUserID = '/users/testuser';
    describe('calling register', () => {
      it('should create a user and person', async function registerUser() {
        const listener = function listener(message, context) {
          user.name.should.equal(message.name);
          user.email.should.equal(message.email);
        };
        await topic.on('registered', listener);
        const result = await (userService.register(user));
        testUserID = result.data.id;
        should.exist(result);
        should.exist(result.data);
        should.not.exist(result.error);
        const data = result.data;
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
    describe('calling find', () => {
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
    describe('verifyPassword', () => {
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
    describe('calling activate', () => {
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
    describe('calling changePassword', () => {
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
    describe('calling changeEmailId', () => {
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
    describe('calling unregister', () => {
      it('should remove the user and person', async function unregister() {
        await userService.unregister({
          id: testUserID,
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
