import * as _ from 'lodash';
import * as bcrypt from 'bcryptjs';
import * as moment from 'moment-timezone';
import * as util from 'util';
import * as uuid from 'uuid';

import * as chassis from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as fetch from 'node-fetch';
import { ServiceBase, ResourcesAPIBase, toStruct } from '@restorecommerce/resource-base-interface';
import { BaseDocument, DocumentMetadata } from '@restorecommerce/resource-base-interface/lib/core/interfaces';

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

export type TUser = User | FindUser | ActivateUser;
export interface Call<TUser> {
  request?: TUser;
  [key: string]: any;
}

export interface User extends BaseDocument {
  name: string; // The name of the user, can be used for login
  first_name: string;
  last_name: string;
  email: string; /// Email address
  emailNew: string; /// Email address
  active: boolean; /// If the user was activated via the activation process
  activation_code: string; /// Activation code used in the activation process
  password: string; /// Raw password, not stored
  password_hash: string; /// Encrypted password, stored
  guest: boolean;
  role_associations: RoleAssociation[];
  locale_id: string;
  timezone_id: string;
  unauthenticated: boolean;
  default_scope: string;
}

export interface FindUser {
  id?: string;
  email?: string;
  name?: string;
}

export interface ActivateUser {
  name: string;
  activation_code: string;
}

export interface RoleAssociation {
  role: string; // role ID
  attributes?: Attribute[];
}

export interface Attribute {
  id: string;
  value: string;
}

export interface EmailChange {
  email: string;
  id: string;
}

export interface Role extends BaseDocument {
  name: string;
  description: string;
}

export interface ForgotPassword {
  name?: string; // username
  password?: string;
}

export interface ChangePassword {
  id: string;
  password: string;
  new_password?: string;
}

export interface ConfirmPasswordChange {
  name: string;
  password: string;
  activation_code: string;
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
    this.roleService = roleService;
  }

  /**
   * Endpoint to search for users containing any of the provided field values.
   * @param {call} call request containing either userid, username or email
   * @return the list of users found
   */
  async find(call: Call<FindUser>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
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
  async create(call: any, context?: any): Promise<any> {
    const usersList = call.request.items;
    const insertedUsers = [];
    for (let i = 0; i < usersList.length; i++) {
      let user: User = usersList[i];
      user.activation_code = '';
      user.active = true;
      insertedUsers.push(await this.createUser(user, context));
    }

    return insertedUsers;
  }

  /**
   * Validates User and creates it in DB,
   * @param user
   */
  private async createUser(user: User, context?: any): Promise<User> {
    const logger = this.logger;

    // User creation
    logger.silly('request to register a user');

    this.setUserDefaults(user);
    if (!user.password) {
      throw new errors.InvalidArgument('argument password is empty');
    }
    if (!user.email) {
      throw new errors.InvalidArgument('argument email is empty');
    }
    if (!user.name) {
      throw new errors.InvalidArgument('argument name is empty');
    }

    const serviceCfg = this.cfg.get('service');

    const minLength = serviceCfg.minUsernameLength;
    const maxLength = serviceCfg.maxUsernameLength;

    if (!this.validUsername(user.name, minLength, maxLength)) {
      throw new errors.InvalidArgument(`the user name is invalid - it should have a length between ${minLength} and ${maxLength}
        and it can contain alphanumeric characters or any character of the following: ?!.*-_`);
    }

    if (_.isEmpty(user.first_name) || _.isEmpty(user.last_name)) {
      throw new errors.InvalidArgument('User register requires both first and last name');
    }

    // Since for guestUser he should be able to register with same email ID multiple times
    // so we are creating user and not making the unique emailID or user name check
    // Guest creation
    if (user.guest) {
      logger.silly('request to register a guest');

      let serviceCall = {
        request: {
          items: [user]
        }
      };
      await super.create(serviceCall, context);
      logger.info('guest user registered', user);
      await (this.topics['user.resource'].emit('registered', user));
      return user;
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

    // Hash password
    user.password_hash = password.hash(user.password);
    delete user.password;

    if (!this.roleService.verifyRoles(user.role_associations)) {
      throw new errors.InvalidArgument(`Invalid role ID in role associations`);
    }

    const serviceCall = {
      request: {
        items: [user]
      }
    };

    const result = await super.create(serviceCall, context);
    return result.items[0];
  }

  /**
   * Endpoint register, register a user or guest user.
   * @param  {any} call request containing a  User
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async register(call: any, context?: any): Promise<any> {
    const user: User = call.request || call;
    // Create User
    const userActivationRequired: Boolean = this.isUserActivationRequired();
    this.logger.silly('user activation required', userActivationRequired);
    if (userActivationRequired) {
      // New users must be activated
      user.active = false;
      user.activation_code = this.idGen();
      user.unauthenticated = true;
    } else {
      user.active = true;
      user.unauthenticated = false;
    }

    const createdUser = await this.createUser(user, context);

    this.logger.info('user registered', user);
    await this.topics['user.resource'].emit('registered', user);

    // For guest user email should not be sent out
    if (this.emailEnabled && !user.guest) {
      const renderRequest = this.makeActivationEmailData(user);
      await this.topics.rendering.emit('renderRequest', renderRequest);
    }

    return user;
  }

  /**
   * Endpoint sendEmail to trigger sending mail notification.
   * @param  {any} renderResponse
   */
  async sendEmail(renderResponse: any): Promise<void> {
    const responseID: string = renderResponse.id;
    if (!responseID.startsWith('identity')) {
      this.logger.verbose(`Discarding render response ${responseID}`);
      return;
    }

    const split = responseID.split('#');
    if (split.length != 2) {
      this.logger.verbose(`Unknown render response ID format: ${responseID}`);
      return;
    }

    const emailAddress = split[1];
    const user = await super.read({
      request: {
        filter: toStruct({
          email: emailAddress
        })
      }
    });

    if (_.isEmpty(user.items)) {
      this.logger.silly(`Received rendering response from unknown email address ${emailAddress}; discarding`);
      return;
    }

    const responseBody = unmarshallProtobufAny(renderResponse.response[0]);
    const responseSubject = unmarshallProtobufAny(renderResponse.response[1]);
    const emailData = this.makeNotificationData(emailAddress, responseBody, responseSubject);
    await this.topics.notification.emit('sendEmail', emailData);
  }

  private idGen(): string {
    return uuid.v4().replace(/-/g, '');
  }

  private validUsername(username: string, minLength: number, maxLength: number): boolean {
    const regex = `^(?!.*\\.\\.)[a-z0-9_.-]{${minLength},${maxLength}}$`;
    const match = username.match(new RegExp(regex));
    return !!match && match.length > 0;
  }

  /**
   * Endpoint to activate a User
   *  @param  {Call} call request containing user details
   *  @param {any} context
   *  @return empty response
   */
  async activate(call: Call<ActivateUser>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    const userName = request.name;
    const activationCode = request.activation_code;
    if (!userName) {
      throw new errors.InvalidArgument('argument id is empty');
    }
    if (!activationCode) {
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
    if ((!user.activation_code) || user.activation_code !== activationCode) {
      logger.debug('wrong activation code', user);
      throw new errors.FailedPrecondition('wrong activation code');
    }

    user.active = true;
    user.unauthenticated = false;

    user.activation_code = '';
    const serviceCall = {
      request: {
        items: [user]
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
  async changePassword(call: Call<ChangePassword>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
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
    user.password_hash = password_hash;
    const serviceCall = {
      request: {
        items: [user]
      }
    };
    await super.update(serviceCall, context);
    logger.info('password changed for user', userID);
    await this.topics['user.resource'].emit('passwordChanged', user);
    return {};
  }

  /**
   * Endpoint to request password change.
   * A UUID is generated and a confirmation email is
   * sent out to the user's defined email address.
   *
   * @param call
   * @param context
   */
  async requestPasswordChange(call: Call<ForgotPassword>, context?: any): Promise<any> {
    const logger = this.logger;

    const user: User = (await this.find({
      request: call.request
    })).items[0]; // NotFound exception is thrown when length is 0

    logger.verbose('Received a password change request for user', user.id);

    // generating activation code
    user.activation_code = this.idGen();
    await super.update({
      request: {
        items: [user]
      }
    });
    await this.topics['user.resource'].emit('passwordChangeRequested', user);

    // sending activation code via email
    if (this.emailEnabled) {
      const renderRequest = this.makeConfirmationData(user, true);
      await this.topics.rendering.emit('renderRequest', renderRequest);
    }
    return {};
  }

  /**
   * Endpoint which is called after the user confirms a password change request.
   *
   * @param call Activation code, new password, user name
   * @param context
   */
  async confirmPasswordChange(call: Call<ConfirmPasswordChange>, context?: any): Promise<any> {
    const logger = this.logger;
    const { name, activation_code } = call.request;
    const newPassword = call.request.password;

    const user: User = (await this.find({
      request: {
        name
      }
    })).items[0];

    if (!user.activation_code || user.activation_code !== activation_code) {
      logger.debug('wrong activation code upon password change confirmation for user', user.name);
      throw new errors.FailedPrecondition('wrong activation code');
    }

    user.activation_code = '';
    user.password_hash = password.hash(newPassword);
    await super.update({
      request: {
        items: [user]
      }
    });
    logger.info('password changed for user', user.id);
    await this.topics['user.resource'].emit('passwordChanged', user);
    return {};
  }

  /**
   * Endpoint to change email Id.
   * @param  {Call} call request containing new email Id of User
   * @param {any} context
   * @return {User} returns user details
   */
  async requestEmailChange(call: Call<EmailChange>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
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
    const user: User = users.items[0];

    user.emailNew = email;
    user.activation_code = this.idGen();
    const serviceCall = {
      request: {
        items: [user]
      }
    };
    await super.update(serviceCall, context);
    logger.info('Email change requested for user', userID);
    await this.topics['user.resource'].emit('emailChangeRequested', user);

    // Contextual Data for rendering on Notification-srv before sending mail
    const usersUpdated = await super.read({ request: { filter } }, context);

    if (this.emailEnabled) {
      const renderRequest = this.makeConfirmationData(user, false);
      await this.topics.rendering.emit('renderRequest', renderRequest);
    }
    return {};
  }

  /**
   * Endpoint to confirm email change.
   * @param  {Call} call request containing new email Id of User
   * @param {any} context
   * @return {User} returns user details
   */
  async confirmEmailChange(call: Call<ActivateUser>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    const name = request.name;
    const activationCode = request.activation_code;


    const users = await this.find({
      request: {
        name
      }
    });
    if (users.total_count === 0) {
      logger.debug('user does not exist', name);
      throw new errors.NotFound('user does not exist');
    }

    const user: User = users.items[0];

    if (user.activation_code !== activationCode) {
      logger.debug('wrong activation code upon email confirmation for user', user);
      throw new errors.FailedPrecondition('wrong activation code');
    }

    user.email = user.emailNew;
    user.emailNew = '';
    user.activation_code = '';

    const serviceCall = {
      request: {
        items: [user]
      }
    };

    await super.update(serviceCall, context);
    logger.info('Email address changed for user', user.id);

    await this.topics['user.resource'].emit('emailChangeConfirmed', user);
    return {};
  }

  /**
   * Extends the generic update operation in order to update any fields except
   * "special handling" fields, like email, password, etc
   * @param call
   * @param context
   */
  async update(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for update');
    }

    const items = call.request.items;
    const invalidFields = ['name', 'email', 'password', 'active', 'activation_code',
      'password_hash', 'guest'];
    for (let i = 0; i < items.length; i += 1) {
      // read the user from DB and update the special fields from DB
      // for user modification
      const user = items[i];
      const filter = toStruct({
        id: user.id
      });
      const users = await super.read({ request: { filter } }, context);
      if (users.total_count === 0) {
        throw new errors.NotFound('user not found');
      }
      _.forEach(invalidFields, async (field) => {
        if (!_.isNil(user[field]) && !_.isEmpty(user[field])) {
          new Promise((resolve, reject) => {
            reject(`Generic update operation is not allowed for field ${field}`);
          });
        } else {
          user[field] = users.items[0][field];
        }
      });
    }
    return super.update(call, context);
  }
  /**
   * Endpoint verifyPassword, checks if the provided password and user matches
   * the one found in the database.
   * @param  {Call} call request containing user details
   * @param {any} context
   * @return {User} returns user details
   */
  async login(call: any, context?: any): Promise<any> {
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
  async unregister(call: any, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
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

  async deleteUsersByOrg(call: any, context?: any): Promise<any> {
    const orgIDs = call.request.org_ids;
    const deletedUserIDs = await this.modifyUsers(orgIDs, false, context);
    return { user_ids: deletedUserIDs.map((user) => { return user.id; }) };
  }

  /**
   *
   * @param call
   * @param context
   */
  async findByRole(call: any, context?: any): Promise<any> {
    const role: string = call.role || call.request.role || undefined;
    if (!role) {
      throw new errors.InvalidArgument('missing role name');
    }

    const reqAttributes: any[] = call.attributes || call.request.attributes || [];

    const result = await this.roleService.read({
      request: {
        filter: toStruct({
          name: role
        }),
        field: [{
          name: 'id',
          include: true
        }]
      }
    });

    if (_.isEmpty(result) || _.isEmpty(result.items) || result.items.total_count == 0) {
      throw new errors.NotFound(`Role ${role} does not exist`);
    }

    const roleObj = result.items[0];
    const id = roleObj.id;

    // note: inefficient, a custom AQL query should be the final solution
    const userResult = await super.read({
      request: {}
    }, {});
    if (_.isEmpty(userResult) || _.isEmpty(userResult.items) || userResult.items.total_count == 0) {
      throw new errors.NotFound('No users were found in the system');
    }

    const users: User[] = userResult.items;

    let usersWithRole = [];

    for (let user of users) {
      let found = false;
      if (user.role_associations) {
        for (let roleAssoc of user.role_associations) {
          if (roleAssoc.role == id) {
            found = true;
            if (roleAssoc.attributes && reqAttributes) {
              for (let attribute of reqAttributes) {
                if (!_.find(roleAssoc.attributes, attribute)) {
                  found = false;
                  break;
                }
              }
            }

            if (found) {
              usersWithRole.push(user);
              break;
            }
          }
        }
      }
    }

    return usersWithRole;
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
      if (response.status == 200) {
        const externalRrc = JSON.parse(await response.text());
        this.emailStyle = prefix + externalRrc.style;
      }

      this.emailEnabled = true;
    } catch (err) {
      this.emailEnabled = false;
      this.sendEmail = null;
      if (err.code == 'ECONNREFUSED' || err.message == 'ECONNREFUSED') {
        this.logger.warn('An error occurred while attempting to load email templates from'
          + ' remote server. Email operations will be disabled.');
      } else {
        this.logger.error('Unexpected error occurred while loading email templates', err.message);
      }
    }
  }

  private makeActivationEmailData(user: User): any {
    let activationLink: string = this.cfg.get('service:activationLink');
    if (!activationLink.endsWith('/')) {
      activationLink += '/';
    }

    activationLink = `${activationLink}${user.name}/${user.activation_code}`;

    const dataBody = {
      firstName: user.first_name,
      lastName: user.last_name,
      activationLink
    };
    // since there are no place holders in subject
    const dataSubject = { userName: user.name };

    const emailBody = this.registerBodyTpl;
    const emailSubject = this.registerSubjectTpl;
    return this.makeRenderRequestMsg(user, emailSubject, emailBody,
      dataBody, dataSubject);
  }

  private makeConfirmationData(user: User, passwordChange: boolean): any {
    const emailBody = this.changeBodyTpl;
    const emailSubject = this.changeSubjectTpl;

    let link: string = passwordChange ? this.cfg.get('service:passwordChangeConfirmationLink')
      : this.cfg.get('service:emailConfirmationLink'); // prefix

    if (!link.endsWith('/')) {
      link += '/';
    }

    link = `${link}${user.name}/${user.activation_code}`; // actual email

    const dataBody = {
      firstName: user.first_name,
      lastName: user.last_name,
      confirmationLink: link,
      passwordChange
    };
    const dataSubject = { passwordChange };
    return this.makeRenderRequestMsg(user, emailSubject, emailBody,
      dataBody, dataSubject);
  }

  private makeRenderRequestMsg(user: User, subject: any, body: any,
    dataBody: any, dataSubject: any): any {
    return {
      id: `identity#${user.email}`,
      payload: [{
        templates: marshallProtobufAny({
          body: { body, layout: this.layoutTpl },
        }),
        data: marshallProtobufAny(dataBody),
        style: this.emailStyle, // URL to a style
        options: marshallProtobufAny({ texts: {} }),
        content_type: 'application/html'
      },
      {
        templates: marshallProtobufAny({
          subject: { body: subject }
        }),
        data: marshallProtobufAny(dataSubject),
        options: marshallProtobufAny({ texts: {} }),
        content_type: 'application/text'
      }]
    };
  }

  async disableUsers(orgIDs: string[]): Promise<void> {
    await this.modifyUsers(orgIDs, true);
  }

  private async modifyUsers(orgIds: string[], deactivate: boolean,
    context?: any): Promise<User[]> {
    const ROLE_SCOPING_ENTITY = this.cfg.get('urns:roleScopingEntity');
    const ORGANIZATION_URN = this.cfg.get('urns:organization');
    const ROLE_SCOPING_INSTANCE = this.cfg.get('urns:roleScopingInstance');

    const eligibleUsers = [];

    const roleID = await this.getNormalUserRoleID(context);
    for (let org of orgIds) {
      const result = await super.read({
        request: {
          custom_queries: ['filterByRoleAssociation'],
          custom_arguments: {
            value: Buffer.from(JSON.stringify({
              userRole: roleID,
              scopingEntity: this.cfg.get('urns:organization'),
              scopingInstances: [org]
            }))
          }
        }
      });
      // The above custom query is to avoid to retreive all the users in DB
      // and get only those belong to orgIds and then check below to see if
      // that org is the only one present before actually deleting the user
      const users = result.items || [];
      for (let i = 0; i < users.length; i += 1) {
        const user: User = _.cloneDeep(users[i]);
        const associations = _.cloneDeep(user.role_associations);
        for (let k = associations.length - 1; k >= 0; k -= 1) {
          const attributes = associations[k].attributes;
          const attributesExist = attributes.length > 0;
          if (attributesExist) {
            for (let j = attributes.length - 1; j >= 0; j -= 1) {
              const attribute = attributes[j];
              if (attribute && attribute.id == ROLE_SCOPING_INSTANCE
                && orgIds.indexOf(attribute.value) > -1) {
                const prevAttribute = attributes[j - 1];
                if (prevAttribute.id == ROLE_SCOPING_ENTITY
                  && prevAttribute.value == ORGANIZATION_URN) {
                  attributes.splice(j - 1, 2);
                }
              }
            }
            if (attributesExist && attributes.length == 0) {
              user.role_associations.splice(k, 1);
            }
          }
        }
        if (user.role_associations.length == 0) {
          user.active = false;
          eligibleUsers.push(user);
        }
      }
    }

    if (deactivate) {
      await super.update({ request: { items: eligibleUsers } });
    } else {
      const ids = eligibleUsers.map((user) => { return user.id; });
      this.logger.info('Deleting users:', { ids });
      await super.delete({ request: { ids } });
    }

    return eligibleUsers;
  }

  /**
   * Get normal users role identifier, since every user is a normal user.
   * before sending emails (user registration / change).
   * @param {ctx} User context
   * @return {roleID}
   */
  private async getNormalUserRoleID(context: any): Promise<any> {
    let roleID;
    const roleName = this.cfg.get('reoles:normalUser');
    const filter = toStruct(
      { name: { $eq: roleName } },
    );
    const role: any = this.roleService.read({ request: { filter } }, context);
    if (role) {
      roleID = role.id;
    }
    return roleID;
  }

  private makeNotificationData(emailAddress: string, responseBody: any,
    responseSubject: any): any {
    return {
      email: {
        to: emailAddress
      },
      body: responseBody.body,
      subject: responseSubject.subject,
      transport: 'email'
    };
  }

  private setUserDefaults(user: User): User {
    const userID = user.id || this.idGen();
    const OWNER_INDICATOR_ENTITY = this.cfg.get('urns:ownerEntity');
    const USER_URN = this.cfg.get('urns:user');
    const OWNER_SCOPING_INSTANCE = this.cfg.get('urns:ownerInstance');

    const meta: DocumentMetadata = {
      owner: !!user.meta && !_.isEmpty(user.meta.owner) ? user.meta.owner : [
        {
          id: OWNER_INDICATOR_ENTITY,
          value: USER_URN
        },
        {
          id: OWNER_SCOPING_INSTANCE,
          value: userID
        }
      ],
      modified_by: !!user.meta && !_.isEmpty(user.meta.modified_by) ? user.meta.modified_by : user.id
    };

    user.id = userID;
    user.meta = meta;
    return user;
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

    return super.create(call, context);
  }

  async verifyRoles(roleAssociations: RoleAssociation[]): Promise<boolean> {
    // checking if user roles are valid
    for (let roleAssociation of roleAssociations) {
      const roleID = roleAssociation.role;
      const result = await super.read({
        request: {
          filter: {
            id: roleID
          }
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
