import * as _ from 'lodash';
import * as bcrypt from 'bcryptjs';
import * as co from 'co';
import * as locale from 'locale-code';
import * as moment from 'moment-timezone';
import * as util from 'util';
import * as uuid from 'uuid';

import * as chassis from '@restorecommerce/chassis-srv';
import { Server } from '@restorecommerce/chassis-srv';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import * as fetch from 'node-fetch';
import { ServiceBase, ResourcesAPIBase, toStruct } from '@restorecommerce/resource-base-interface';

const Events = kafkaClient.Events;
const database = chassis.database;
const errors = chassis.errors;

const password = {
  hash: (pw): string => {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(pw, salt);
    return hash;
  },
  verify: (password_hash, pw) => {
    return bcrypt.compareSync(pw, password_hash);
  }
};

export interface Call {
  request: User;
}

export interface User {
  id: string;
  created: number; /// Date of the user creation
  modified: number; /// Last time the user was modified
  creator: string; /// User ID of the creator
  name: string; // The name of the user, can be used for login
  email: string; /// Email address
  active: boolean; /// If the user was activated via the activation process
  activation_code: string; /// Activation code used in the activation process
  password: string; /// Raw password, not stored
  password_hash: string; /// Encrypted password, stored
  guest: boolean;
  role_associations: RoleAssociation[];
  locale: string;
  timezone: string;
}

export interface RoleAssociation {
  role: string; // role ID
  attributes?: Attribute[];
}

export interface Attribute {
  id: string;
  value: string;
}

export interface Role {
  id: string;
  created: number;
  modified: number;
  name: string;
  description: string;
}

export class UserService extends ServiceBase {
  db: any;
  topics: any;
  logger: any;
  cfg: any;
  registerSubjectTpl: string;
  changeSubjectTpl: string;
  layoutTpl: string;
  registerBodyTpl: string;
  changeBodyTpl: string;
  emailData: any;
  emailEnabled: boolean;
  emailStyle: string;
  roleService: RoleService;
  constructor(cfg: any, topics: any, db: any, logger: any,
    isEventsEnabled: boolean, roleService: RoleService) {
    super('user', topics['user.resource'], logger, new ResourcesAPIBase(db, 'users'),
      isEventsEnabled);
    this.cfg = cfg;
    this.db = db;
    this.topics = topics;
    this.logger = logger;

    this.emailData = {};
    this.roleService = roleService;
  }

  /**
   * Endpoint to search for users containing any of the provided field values.
   * @param {call} call request containing either userid, username or email
   * @return the list of users found
   */
  async find(call: Call, context: any): Promise<any> {
    const request = call.request;
    const logger = context.logger;
    let userID = request.id || '';
    let userName = request.name || '';
    let mailID = request.email || '';
    const filter = toStruct({
      $or: [
        { id: { $eq: userID } },
        { name: { $eq: userName } },
        { email: { $eq: mailID } }
      ]
    });
    const users = await super.read({ request: { filter } }, context);
    if (users.total_count > 0) {
      logger.silly('found user(s)', users);
      return users;
    }
    logger.silly('user(s) could not be found for request', request);
    throw new errors.NotFound('user not found');
  }

  /**
   * Endpoint to check if User activation process is required.
   * @param {call} call request containing either userid, username or email
   * @return true if the user activation process is required.
   */
  isUserActivationRequired(): Boolean {
    const userActivationRequired: boolean = this.cfg.get('service:userActivationRequired');
    if (_.isNil(userActivationRequired)) {
      this.logger.warn('User activation is disabled');
      return false;
    }
    return userActivationRequired;
  }

  /**
   * Extends ServiceBase.create()
   * @param  {any} call request containing a list of Users
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async create(call: any, context: any): Promise<any> {
    const userListReturn = [];
    const that = this;
    const usersList = call.request.items;
    for (let i = 0; i < usersList.length; i++) {
      const user = usersList[i];
      await this.register(user, context);
      user.active = true;
    }

    return userListReturn;
  }

  /**
   * Endpoint register, register a user or guest user.
   * @param  {any} call request containing a  User
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async register(call: any, context: any): Promise<any> {
    let dataArray = [];
    const user: User = call.request || call;
    const logger = context.logger;
    // Guest creation
    if (user.guest) {
      logger.silly('request to register a guest');

      dataArray.push(user);
      let serviceCall = {
        request: {
          items: dataArray
        }
      };
      await super.create(serviceCall, context);
      logger.info('guest user registered', user);
      await (this.topics['user.resource'].emit('registered', user));
      return user;
    }
    // User creation
    logger.silly('request to register a user');
    if (!user.password) {
      throw new errors.InvalidArgument('argument password is empty');
    }
    if (!user.email) {
      throw new errors.InvalidArgument('argument email is empty');
    }
    if (!user.name) {
      throw new errors.InvalidArgument('argument name is empty');
    }

    logger.silly(
      util.format('register is checking id:%s name:%s and email:%s',
        user.name, user.email));
    const filter = toStruct({
      $or: [
        { name: user.name },
        { email: user.email },
      ]
    });
    const users = await super.read({ request: { filter } }, context);
    if (users.total_count > 0) {
      logger.debug('user does already exist', users);
      throw new errors.AlreadyExists('user does already exist');
    }
    logger.silly('user does not exist');

    // Create User
    const userActivationRequired: Boolean = this.isUserActivationRequired();
    logger.silly('user activation required', userActivationRequired);
    if (userActivationRequired) {
      // New users must be activated
      user.active = false;
      user.activation_code = this.idGen();
    } else {
      user.active = true;
    }

    // Hash password
    user.password_hash = password.hash(user.password);
    delete user.password;

    if (!this.roleService.verifyRoles(user.role_associations)) {
      throw new errors.InvalidArgument(`Invalid role ID in role associations`);
    }

    dataArray.push(user);
    if (!user.timezone || !moment.tz.zone(user.timezone)) {
      user.timezone = 'Europe/Berlin';  // fallback
    }

    if (!user.locale || !locale.validate(user.locale)) {
      user.locale = 'de-DE';  // fallback
    }

    const serviceCall = {
      request: {
        items: dataArray
      }
    };

    await super.create(serviceCall, context);
    logger.info('user registered', user);
    await this.topics['user.resource'].emit('registered', user);

    if (this.emailEnabled) {
      // Contextual Data for template rendering
      const contextualData = {
        userName: user.name,
        activationCode: user.activation_code
      };

      this.emailData[user.email] = {
        data: {
          notifyee: user.email,
          body: '',
          subject: '',
          transport: 'email',
          target: user.email
        }
      };

      const renderRequest = {
        id: user.email,
        payload: [{
          templates: marshallProtobufAny({
            body: { body: this.registerBodyTpl, layout: this.layoutTpl },
            subject: { body: this.registerSubjectTpl }
          }),
          data: marshallProtobufAny(contextualData),
          style: this.emailStyle,
          options: marshallProtobufAny({ texts: {} })
        }]
      };
      await this.topics.rendering.emit('renderRequest', renderRequest);
    }
    // Response
    return user;
  }

  /**
   * Endpoint sendEmail to trigger sending mail notification.
   * @param  {any} renderResponse
   */
  async sendEmail(renderResponse: any): Promise<any> {
    const emailAddress = renderResponse.id;
    if (!this.emailData[emailAddress]) {
      this.logger.silly('Unknown rendering response with ID', emailAddress, '; discarding message.');
      return;
    }

    const response = unmarshallProtobufAny(renderResponse.response[0]);
    const data = this.emailData[emailAddress];
    const emailData = data.data;

    emailData.body = response.body;
    emailData.subject = response.subject;
    await this.topics.notification.emit('sendEmail', emailData);
    delete this.emailData[renderResponse.id];
  }

  idGen(): string {
    return uuid.v4().replace(/-/g, '');
  }

  /**
   * Endpoint to activate a User
   *  @param  {Call} call request containing user details
   *  @param {any} context
   *  @return empty response
   */
  async activate(call: Call, context: any): Promise<any> {
    const request = call.request;
    const logger = context.logger;
    const userName = request.name;
    const activation_code = request.activation_code;
    if (!userName) {
      throw new errors.InvalidArgument('argument id is empty');
    }
    if (!activation_code) {
      throw new errors.InvalidArgument('argument activation_code is empty');
    }
    const filter = toStruct({
      name: userName
    });
    const users = await super.read({ request: { filter } }, context);
    if (!users || users.total_count === 0) {
      throw new errors.NotFound('user not found');
    }
    const user: User = users.items[0];
    if (user.active) {
      logger.debug('activation request to an active user' +
        ' which still has the activation code', user);
      throw new errors.FailedPrecondition('activation request to an active user' +
        ' which still has the activation code');
    }
    if ((!user.activation_code) || user.activation_code !== activation_code) {
      logger.debug('wrong activation code', user);
      throw new errors.FailedPrecondition('wrong activation code');
    }
    let dataArray = [];
    user.active = true;
    user.activation_code = '';
    dataArray.push(user);
    const serviceCall = {
      request: {
        items: dataArray
      }
    };
    await super.update(serviceCall, context);
    logger.info('user activated', user);
    await this.topics['user.resource'].emit('activated', { id: user.id });
    return {};
  }

  /**
   * Endpoint to change user password.
   * @param  {Call} call request containing user details
   * @param {any} context
   * @return {User} returns user details
   */
  async changePassword(call: any, context: any): Promise<any> {
    const request = call.request;
    const logger = context.logger;
    const userID = request.id;

    const pw = request.password;
    const newPw = request.new_password;

    const filter = toStruct({
      id: userID
    });
    const users = await super.read({ request: { filter } }, context);
    if (_.size(users) === 0) {
      logger.debug('user does not exist', userID);
      throw new errors.NotFound('user does not exist');
    }
    const user: User = users.items[0];
    const userPWhash = user.password_hash;
    if (!password.verify(userPWhash, pw)) {
      throw new errors.Unauthenticated('password does not match');
    }

    const password_hash = password.hash(newPw);
    let dataArray = [];
    user.password_hash = password_hash;
    dataArray.push(user);
    const serviceCall = {
      request: {
        items: dataArray
      }
    };
    await super.update(serviceCall, context);
    logger.info('password changed for user', userID);
    await this.topics['user.resource'].emit('passwordChanged', user);
    return {};
  }

  /**
   * Endpoint to change email Id.
   * @param  {Call} call request containing new email Id of User
   * @param {any} context
   * @return {User} returns user details
   */
  async changeEmailId(call: Call, context: any): Promise<any> {
    const request = call.request;
    const logger = context.logger;
    const userID = request.id;
    const email = request.email;
    const filter = toStruct({
      id: userID
    });
    const users = await super.read({ request: { filter } }, context);
    if (users.total_count === 0) {
      logger.debug('user does not exist', userID);
      throw new errors.NotFound('user does not exist');
    }
    const user = users.items[0];
    // Deactivate the user since mailID has changed
    const userActivationRequired: Boolean = this.isUserActivationRequired();
    logger.silly('user activation required', userActivationRequired);
    if (userActivationRequired) {
      user.active = false;
      user.activation_code = this.idGen();
    } else {
      user.active = true;
    }
    let dataArray = [];
    user.email = email;
    dataArray.push(user);
    const serviceCall = {
      request: {
        items: dataArray
      }
    };
    await super.update(serviceCall, context);
    logger.info('EmailID changed for user', userID);
    await this.topics['user.resource'].emit('emailIdChanged', user);

    // Contextual Data for rendering on Notification-srv before sending mail
    const usersUpdated = await super.read({ request: { filter } }, context);
    const userUpdated = usersUpdated.items[0];

    if (this.emailEnabled) {
      const contextualData = {
        userName: userUpdated.name,
        activationCode: userUpdated.activation_code
      };

      this.emailData[user.email] = {
        data: {
          notifyee: user.email,
          body: '',
          subject: '',
          transport: 'email',
          target: user.email
        }
      };

      const renderRequest = {
        id: user.email,
        payload: [{
          templates: marshallProtobufAny({
            body: { body: this.changeBodyTpl, layout: this.layoutTpl },
            subject: { body: this.changeSubjectTpl }
          }),
          data: marshallProtobufAny(contextualData),
          style: this.emailStyle,
          options: marshallProtobufAny({ texts: {} })
        }]
      };
      await this.topics.rendering.emit('renderRequest', renderRequest);
    }
    return {};
  }

  /**
   * Extends the generic update operation in order to update any fields except
   * "special handling" fields, like email, password, etc
   * @param call
   * @param context
   */
  async update(call: any, context: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for update');
    }

    const items = call.request.items;
    const invalidFields = ['name', 'email', 'password', 'active', 'activation_code', 'creator',
      'password_hash', 'guest'];

    _.forEach(items, (user) => {
      _.forEach(invalidFields, (field) => {
        if (!_.isNil(user[field]) && !_.isEmpty(user[field])) {
          throw new errors.InvalidArgument(`Generic update operation is not allowed for field ${field}`);
        }
      });
    });

    return super.update(call, context);
  }
  /**
   * Endpoint verifyPassword, checks if the provided password and user matches
   * the one found in the database.
   * @param  {Call} call request containing user details
   * @param {any} context
   * @return {User} returns user details
   */
  async login(call: any, context: any): Promise<any> {
    if (_.isEmpty(call) || _.isEmpty(call.request) ||
      (_.isEmpty(call.request.name) && _.isEmpty(call.request.email))) {
      throw new errors.InvalidArgument('Missing credentials');
    }
    const field = call.request.name ? 'name' : 'email';
    const value = call.request.name ? call.request.name : call.request.email;

    const filter = toStruct({
      [field]: value
    });

    const users = await super.read({ request: { filter } }, context);
    if (users.total_count === 0) {
      throw new errors.NotFound('user not found');
    }
    const user = users.items[0];
    const match = password.verify(user.password_hash, call.request.password);
    if (!match) {
      throw new errors.Unauthenticated('password does not match');
    }
    return user;
  }

  /**
   * Endpoint unregister, delete a user
   * belonging to the user.
   * @param  {any} call request containing list of userIds
   * @param {any} context
   * @return {} returns empty response
   */
  async unregister(call: any, context: any): Promise<any> {
    const request = call.request;
    const logger = context.logger;
    const userID = request.id;
    logger.silly('unregister', userID);
    const filter = toStruct({
      id: userID
    });
    const users = await super.read({ request: { filter } }, context);
    if (users.total_count === 0) {
      logger.debug('user does not exist', userID);
      throw new errors.NotFound('user not found');
    }
    const user = users.items[0];

    // delete user
    const serviceCall = {
      request: {
        ids: [userID]
      }
    };
    await super.delete(serviceCall, context);

    logger.info('user deleted', userID);
    await this.topics['user.resource'].emit('unregistered', userID);
    return {};
  }

  /**
   * Initializes useful data for rendering requests
   * before sending emails (user registration / change).
   * @param {kafkaClient.Topic} renderingTopic Kafka topic with
   * rendering-srv events.
   * @param {any } tplConfig Templates prefix and URLs.
   */
  async setRenderRequestConfigs(tplConfig: any): Promise<any> {
    const templates = tplConfig.templates;
    const prefix = tplConfig.prefix;

    let response: any;
    try {
      response = await fetch(prefix + templates['subject_register']);
      this.registerSubjectTpl = await response.text();

      response = await fetch(prefix + templates['subject_change']);
      this.changeSubjectTpl = await response.text();

      response = await fetch(prefix + templates['layout']);
      this.layoutTpl = await response.text();

      response = await fetch(prefix + templates['body_register']);
      this.registerBodyTpl = await response.text();

      response = await fetch(prefix + templates['body_change']);
      this.changeBodyTpl = await response.text();

      response = await fetch(prefix + templates['resources'], {});
      const externalRrc = JSON.parse(await response.text());
      this.emailStyle = prefix + externalRrc.style;

      this.emailEnabled = true;
    } catch (err) {
      if (err.code == 'ECONNREFUSED' || err.message == 'ECONNREFUSED') {
        this.emailEnabled = false;
        this.sendEmail = null;
        this.logger.warn('An error occurred while attempting to load email templates from'
          + ' remote server. Email operations will be disabled.');
      } else {
        throw err;
      }
    }
  }
}


export class RoleService extends ServiceBase {
  constructor(db: any, roleTopic: kafkaClient.Topic, logger: any, isEventsEnabled: boolean) {
    super('role', roleTopic, logger, new ResourcesAPIBase(db, 'roles'), isEventsEnabled);
  }

  async create(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.items || call.request.items.length == 0) {
      throw new errors.InvalidArgument('No role was provided for creation');
    }

    for (let role of call.request.items) {
      // check unique constraint for role name
      const result = await super.read({
        request: {
          filter: {
            name: role.name
          }
        }
      }, context);

      if (result && result.items && result.items.length > 0) {
        throw new errors.AlreadyExists(`Role ${role.name} already exists`);
      }
    }

    return await super.create(call, context);
  }

  async verifyRoles(roleAssociations: RoleAssociation[]): Promise<boolean> {
    // checking if user roles are valid
    for (let roleAssociation of roleAssociations) {
      const roleID = roleAssociation.role;
      const result = await super.read({
        request: {
          id: roleID
        }
      }, {});

      if (!result || !result.items || result.total_count == 0) {
        return false;
      }
    }

    return true;
  }
}

function marshallProtobufAny(msg: any): any {
  return {
    type_url: 'identity.rendering.renderRequest',
    value: Buffer.from(JSON.stringify(msg))
  };
}

function unmarshallProtobufAny(msg: any): any {
  return JSON.parse(msg.value.toString());
}
