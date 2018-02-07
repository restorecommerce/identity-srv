import * as util from 'util';
import * as co from 'co';
import * as _ from 'lodash';
import * as uuid from 'uuid';
import * as bcrypt from 'bcryptjs';
import * as chassis from '@restorecommerce/chassis-srv';
const errors = chassis.errors;
import { Server } from '@restorecommerce/chassis-srv';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import * as fetch from 'node-fetch';
import { ServiceBase, ResourcesAPIBase, toStruct } from '@restorecommerce/resource-base-interface';

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
const Events = kafkaClient.Events;
const database = chassis.database;

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
  roles: string[];
}

export interface Role {
  id: string;
  created: number;
  modified: number;
  name: string;
  description: string;
  attributes: Map<string, string>;
}

export class UserService extends ServiceBase {
  db: any;
  topics: any;
  logger: any;
  cfg: any;
  subjectTpl: string;
  layoutTpl: string;
  registerBodyTpl: string;
  changeBodyTpl: string;
  emailData: any;
  emailEnabled: boolean;
  roleService: RoleService;
  constructor(cfg: any, topics: any, db: any, logger: any,
    isEventsEnabled: boolean, roleService: RoleService) {
    super('users', topics['users.resource'], logger, new ResourcesAPIBase(db, 'users'),
      isEventsEnabled);
    this.cfg = cfg;
    this.db = db;
    this.topics = topics;
    this.logger = logger;

    this.emailData = {};

    const serviceCfg = cfg.get('service');
    if (!serviceCfg.register) {
      // disabling register-related operations
      // only raw 'create' operations are allowed in this case
      logger.warn('Register flag is set to false. User registry-related operations are disabled.');
      this.register = null;
      this.unregister = null;
      this.activate = null;
      this.isUserActivationRequired = () => { return false; };
    }

    this.roleService = roleService;
  }

  idGen(): string {
    return uuid.v4().replace(/-/g, '');
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
      this.logger.warn('service:userActivationRequired config does not exist');
      return false;
    }
    return userActivationRequired;
  }

  /**
   * converts a user to a guest
   * @param  {User} user
   * @return {object} user
   */
  makeGuest(user: User): Object {
    const id: string = this.idGen();
    return {
      id: this.makeID('users', id),
      name: id,
      guest: true,
    };
  }

  /**
   * Returns an ID based on collection name and document name.
   * @param  {string} collectionName
   * @param  {string} documentName
   * @return {string} id based on collection and document name.
   */
  makeID(collectionName: string, documentName: string): string {
    return util.format('/%s/%s', collectionName, documentName);
  }

  /**
   * Endpoint createUsers, register a list of users or guest users.
   * @param  {any} call request containing a list of Users
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async createUsers(call: any, context: any): Promise<any> {
    const userListReturn = [];
    const that = this;
    const usersList = call.request.items;
    _.forEach(usersList, async function (user: User): Promise<any> {
      const callReq: any = { request: user };
      userListReturn.push(await that.register(callReq, context));
    });
    return userListReturn;
  }

  /**
   * Endpoint register, register a user or guest user.
   * @param  {any} call request containing a  User
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async register(call: Call, context: any): Promise<any> {
    const request = call.request;
    let dataArray = [];
    const user: User = request;
    const logger = context.logger;
    // Guest creation
    if (user.guest) {
      logger.silly('request to register a guest');
      const guest = this.makeGuest(user);
      dataArray.push(user);
      let serviceCall = {
        request: {
          items: dataArray
        }
      };
      await super.create(serviceCall, context);
      logger.info('guest user registered', guest);
      await (this.topics['users.resource'].emit('registered', guest));
      return guest;
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
    // Check if user does already exist
    if (_.isNil(user.id)) {
      user.id = util.format('/%s/%s', 'users', user.name);
    }
    logger.silly(
      util.format('register is checking id:%s name:%s and email:%s',
        user.id, user.name, user.email));
    const filter = toStruct({
      $or: [
        { id: user.id },
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

    // Set User created and modified date as same initially
    // date is stored in seconds in arangoDB i.e. numeric time stamp
    user.created = (new Date()).getTime();
    user.modified = (new Date()).getTime();

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

    // converting the userID to idGen() to eliminate dependency from changing
    // usernames
    user.id = this.idGen();

    // Check if user has any roles if not register as normal_user
    // if (user.roles.length === 0) {
    //   const defaultRole = [{ type: 'normal_user' }];
    //   user.roles = defaultRole;
    // }

    // checking if user roles are valid
    for (let roleID of user.roles) {
      const result = await this.roleService.read({
        request: {
          id: roleID
        }
      }, {});

      if (!result || !result.items || result.total_count == 0) {
        throw new errors.InvalidArgument(`Invalid role ID ${roleID}`);
      }
    }

    dataArray.push(user);
    const serviceCall = {
      request: {
        items: dataArray
      }
    };
    await super.create(serviceCall, context);
    logger.info('user registered', user);
    await this.topics['users.resource'].emit('registered', user);

    if (this.emailEnabled) {
      // Contextual Data for template rendering
      const contextualData = {
        email: user.email, name: user.name, id: user.id,
        activation_code: user.activation_code
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
        service_name: 'identity-srv',
        payload: [{
          templates: JSON.stringify({
            body: { body: this.registerBodyTpl, layout: this.layoutTpl },
            subject: { body: this.subjectTpl }
          }),
          data: JSON.stringify(contextualData),
          options: JSON.stringify({ texts: {} })
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
    const response = renderResponse.response[0];
    const data = this.emailData[emailAddress];
    if (!data) {
      this.logger.error('No email data for rendering response', JSON.stringify(renderResponse));
    }
    const emailData = data.data;
    const responseObj = JSON.parse(response.content);
    emailData.body = responseObj.body;
    emailData.subject = responseObj.subject;
    await this.topics.notification.emit('sendEmail', emailData);
    delete this.emailData[renderResponse.id];
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
    const userID = request.id;
    const activation_code = request.activation_code;
    if (!userID) {
      throw new errors.InvalidArgument('argument id is empty');
    }
    if (!activation_code) {
      throw new errors.InvalidArgument('argument activation_code is empty');
    }
    const filter = toStruct({
      id: userID
    });
    const users = await super.read({ request: { filter } }, context);
    if (!users || users.total_count === 0) {
      throw new errors.NotFound('user not found');
    }
    const user = users.items[0];
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
    await this.topics['users.resource'].emit('activated', { id: userID });
    return {};
  }

  /**
   * Endpoint to change user password.
   * @param  {Call} call request containing user details
   * @param {any} context
   * @return {User} returns user details
   */
  async changePassword(call: Call, context: any): Promise<any> {
    const request = call.request;
    const logger = context.logger;
    const userID = request.id;
    const pw = request.password;
    const filter = toStruct({
      id: userID
    });
    const users = await super.read({ request: { filter } }, context);
    if (_.size(users) === 0) {
      logger.debug('user does not exist', userID);
      throw new errors.NotFound('user does not exist');
    }
    const password_hash = password.hash(pw);
    let dataArray = [];
    const user = users.items[0];
    user.password_hash = password_hash;
    dataArray.push(user);
    const serviceCall = {
      request: {
        items: dataArray
      }
    };
    await super.update(serviceCall, context);
    logger.info('password changed for user', userID);
    await this.topics['users.resource'].emit('passwordChanged', user);
    return users.items[0];
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
    await this.topics['users.resource'].emit('emailIdChanged', user);

    // Contextual Data for rendering on Notification-srv before sending mail
    const usersUpdated = await super.read({ request: { filter } }, context);
    const userUpdated = usersUpdated.items[0];

    if (this.emailEnabled) {
      const contextualData = {
        email: userUpdated.email, name: userUpdated.name, id: userUpdated.id,
        activation_code: userUpdated.activation_code
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
        service_name: 'identity-srv',
        payload: [{
          templates: JSON.stringify({
            body: { body: this.changeBodyTpl, layout: this.layoutTpl },
            subject: { body: this.subjectTpl }
          }),
          data: JSON.stringify(contextualData),
          options: JSON.stringify({ texts: {} })
        }]
      };
      await this.topics.rendering.emit('renderRequest', renderRequest);
    }
    // Response
    return user;
  }

  /**
   * Endpoint verifyPassword, checks if the provided password and user matches
   * the one found in the database.
   * @param  {Call} call request containing user details
   * @param {any} context
   * @return {User} returns user details
   */
  async verifyPassword(call: any, context: any): Promise<any> {
    const filter = toStruct({
      name: call.request.user
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
    await this.topics['users.resource'].emit('unregistered', userID);
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
      response = await fetch(prefix + templates['subject']);
      this.subjectTpl = await response.text();

      response = await fetch(prefix + templates['layout']);
      this.layoutTpl = await response.text();

      response = await fetch(prefix + templates['body_register']);
      this.registerBodyTpl = await response.text();

      response = await fetch(prefix + templates['body_change']);
      this.changeBodyTpl = await response.text();
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
    super('roles', roleTopic, logger, new ResourcesAPIBase(db, 'roles'), isEventsEnabled);
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
}
