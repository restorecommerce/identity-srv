import * as _ from 'lodash';
import * as bcrypt from 'bcryptjs';
import * as util from 'util';
import * as uuid from 'uuid';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as fetch from 'node-fetch';
import { ServiceBase, ResourcesAPIBase, toStruct, toObject } from '@restorecommerce/resource-base-interface';
import { BaseDocument, DocumentMetadata } from '@restorecommerce/resource-base-interface/lib/core/interfaces';
import { Logger } from '@restorecommerce/logger';
import { ACSAuthZ, AuthZAction, Decision, Subject, updateConfig, accessRequest, PolicySetRQ } from '@restorecommerce/acs-client';
import { RedisClient } from 'redis';
import { getSubjectFromRedis, checkAccessRequest, ReadPolicyResponse, AccessResponse } from './utils';
import { errors } from '@restorecommerce/chassis-srv';

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
  email: string; // Email address
  new_email: string; // Email address
  active: boolean; // If the user was activated via the activation process
  activation_code: string; // Activation code used in the activation process
  password: string; // Raw password, not stored
  password_hash: string; // Encrypted password, stored
  guest: boolean;
  role_associations: RoleAssociation[];
  locale_id: string;
  timezone_id: string;
  unauthenticated: boolean;
  default_scope: string;
  invite: boolean; // For user inviation
  invited_by_user_name: string; // user who is inviting
  invited_by_user_first_name: string; // First name of user inviting
  invited_by_user_last_name: string; // Last name of user inviting
}

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface UserInviationReq {
  name: string;
  password: string;
  activation_code: string;
}

export interface FindUser {
  id?: string;
  email?: string;
  name?: string;
  subject?: Subject;
  api_key?: string;
}

export interface ActivateUser {
  name: string;
  activation_code: string;
  subject?: Subject;
  api_key?: string;
}

export interface ConfirmEmailChange {
  name: string;
  activation_code: string;
  subject?: Subject;
  api_key?: string;
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
  subject?: Subject;
  api_key?: string;
}

export interface ChangePassword {
  id: string;
  password: string;
  new_password?: string;
  subject?: Subject;
  api_key?: string;
}

export interface ConfirmPasswordChange {
  name: string;
  password: string;
  activation_code: string;
  subject?: Subject;
  api_key?: string;
}

const marshallProtobufAny = (msg: any): any => {
  return {
    type_url: 'identity.rendering.renderRequest',
    value: Buffer.from(JSON.stringify(msg))
  };
};

const unmarshallProtobufAny = (msg: any): any => JSON.parse(msg.value.toString());

export class UserService extends ServiceBase {
  db: any;
  topics: any;
  logger: Logger;
  cfg: any;
  registerSubjectTpl: string;
  changeSubjectTpl: string;
  layoutTpl: string;
  registerBodyTpl: string;
  changeBodyTpl: string;
  invitationSubjectTpl: string;
  invitationBodyTpl: string;
  emailEnabled: boolean;
  emailStyle: string;
  roleService: RoleService;
  authZ: ACSAuthZ;
  redisClient: RedisClient;
  authZCheck: boolean;
  constructor(cfg: any, topics: any, db: any, logger: Logger,
    isEventsEnabled: boolean, roleService: RoleService, authZ: ACSAuthZ,
    redisClient: RedisClient) {
    super('user', topics['user.resource'], logger, new ResourcesAPIBase(db, 'users'),
      isEventsEnabled);
    this.cfg = cfg;
    this.db = db;
    this.topics = topics;
    this.logger = logger;
    this.roleService = roleService;
    this.authZ = authZ;
    this.redisClient = redisClient;
    this.authZCheck = this.cfg.get('authorization:enabled');
  }

  /**
   * Endpoint to search for users containing any of the provided field values.
   * @param {call} call request containing either userid, username or email
   * @return the list of users found
   */
  async find(call: Call<FindUser>, context?: any): Promise<any> {
    let { id, name, email } = call.request;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id, name, email },
        AuthZAction.READ, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }
    if (acsResponse.decision === Decision.PERMIT) {
      const logger = this.logger;
      const filter = toStruct({
        $or: [
          { id: { $eq: id } },
          { name: { $eq: name } },
          { email: { $eq: email } }
        ]
      });
      const users = await super.read({ request: { filter } }, context);
      if (users.total_count > 0) {
        logger.silly('found user(s)', { users });
        return users;
      }
      logger.silly('user(s) could not be found for request', call.request);
      throw new errors.NotFound('user not found');
    }
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
   * Extends ServiceBase.read()
   * @param  {any} call request contains read request
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async read(call: any, context?: any): Promise<any> {
    const readRequest = call.request;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      return await super.read({ request: readRequest });
    }
  }

  /**
   * Extends ServiceBase.create()
   * @param  {any} call request containing a list of Users
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async create(call: any, context?: any): Promise<any> {
    const usersList: User[] = call.request.items;
    const insertedUsers = [];
    // verify the assigned role_associations with the HR scope data before creating
    // extract details from auth_context of request and update the context Object
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, usersList, AuthZAction.CREATE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }
    if (this.cfg.get('authorization:enabled')) {
      try {
        await this.verifyUserRoleAssociations(usersList, subject);
      } catch (err) {
        // for unhandled promise rejection
        throw err;
      }
    }
    if (acsResponse.decision === Decision.PERMIT) {
      for (let i = 0; i < usersList.length; i++) {
        let user: User = usersList[i];
        user.activation_code = '';
        user.active = true;
        user.unauthenticated = false;
        if (user.invite) {
          user.active = false;
          user.activation_code = this.idGen();
          user.unauthenticated = true;
        }
        insertedUsers.push(await this.createUser(user, context));
        if (this.emailEnabled && user.invite) {
          // send render request for user Invitation
          const renderRequest = this.makeInvitationEmailData(user);
          await this.topics.rendering.emit('renderRequest', renderRequest);
        }
      }
      return insertedUsers;
    }
  }

  private async verifyUserRoleAssociations(usersList: User[], subject: any): Promise<void> {
    let validateRoleScope = false;
    let hierarchical_scopes = subject.hierarchical_scopes;
    let createAccessRole = [];
    try {
      // Make whatIsAllowedACS request to retreive the set of applicable
      // policies and check for role scoping entity, if it exists then validate
      // the user role associations if not skip validation
      let policySetRQ: PolicySetRQ = await accessRequest(subject, {
        entity: 'user',
        args: { filter: [] }
      }, AuthZAction.CREATE, this.authZ) as PolicySetRQ;
      const policiesList = policySetRQ.policies;
      for (let policy of policiesList) {
        for (let rule of policy.rules) {
          if (rule.effect === 'PERMIT' && rule.target && rule.target.subject) {
            // check if the rule subject has any scoping Entity
            const ruleSubjectAttrs = rule.target.subject;
            for (let ruleAttr of ruleSubjectAttrs) {
              if (ruleAttr.id === this.cfg.get('authorization:urns:role')) {
                // rule's role which give's user the acess to create User
                createAccessRole.push(ruleAttr.value);
              }
              if (ruleAttr.id === this.cfg.get('authorization:urns:roleScopingEntity')) {
                validateRoleScope = true;
              }
            }
          }
        }
      }
    } catch (err) {
      this.logger.error('Error caught calling ACS:', { err });
      throw err;
    }
    // check if the assignable_by_roles contain createAccessRole
    for (let user of usersList) {
      let userRoleAssocs = user.role_associations;
      let targetUserRoleIds = [];
      for (let roleAssoc of userRoleAssocs) {
        targetUserRoleIds.push(roleAssoc.role);
      }
      // read all target roles at once and check for each role's assign_by_role
      // contains createAccessRole
      const filter = toStruct({
        id: {
          $in: targetUserRoleIds
        }
      });
      let rolesData = await this.roleService.read({
        request: {
          filter,
          subject
        }
      });
      if (rolesData.items.length === 0) {
        let message = `One or more of the target role IDs are invalid ${targetUserRoleIds},` +
          ` no such role exist in system`;
        this.logger.verbose(message);
        throw new errors.InvalidArgument(message);
      }
      for (let targetRole of rolesData.items) {
        if (!targetRole.assignable_by_roles ||
          !createAccessRole.some((role) => targetRole.assignable_by_roles.includes(role))) {
          let message = `The target role ${targetRole.id} cannot be assigned to` +
            ` user ${user.name} as user role ${createAccessRole} does not have permissions`;
          this.logger.verbose(message);
          throw new errors.InvalidArgument(message);
        }
      }
    }

    if (validateRoleScope) {
      this.logger.debug('Validating assigned user role associations');
      // find the HR scopes which gives user the create access
      // it's an array `hrScopes` since an user can be Admin for multiple orgs
      let hrScopes: HierarchicalScope[] = [];
      for (let hrScope of hierarchical_scopes) {
        for (let accessRole of createAccessRole) {
          if (hrScope.role === accessRole) {
            hrScopes.push(hrScope);
          }
        }
      }
      // if there are no valid HR scopes matching the createAccessRole which
      // gives the subject to create users, then no need to further
      // validate the role associations
      if (_.isEmpty(hrScopes)) {
        throw new errors.InvalidArgument('No Hierarchical Scopes could be found');
      }
      for (let user of usersList) {
        this.validateUserRoleAssociations(user.role_associations, hrScopes, user.name, subject);
      }
    }
  }

  /**
   * Validates assigned role associations for the new user to be cretaed
   * with the HR scope and roles of the creating user
   * @param user
   */
  private validateUserRoleAssociations(userRoleAssocs: RoleAssociation[],
    hrScopes: HierarchicalScope[], userName: string, subject: Subject) {
    if (userRoleAssocs && !_.isEmpty(userRoleAssocs)) {
      for (let userRoleAssoc of userRoleAssocs) {
        let validUserRoleAssoc = false;
        let userRole = userRoleAssoc.role;
        if (userRole) {
          let userRoleAttr = userRoleAssoc.attributes;
          let userScope;
          if (userRoleAttr && userRoleAttr[1] && userRoleAttr[1].value) {
            userScope = userRoleAttr[1].value;
          }
          // validate the userRole and userScope with hrScopes
          if (userRole && hrScopes && !_.isEmpty(hrScopes)) {
            for (let hrScope of hrScopes) {
              if (userScope && this.checkTargetScopeExists(hrScope, userScope)) {
                // check if userScope is valid in hrScope
                validUserRoleAssoc = true;
                break;
              } else if (!userScope) {
                // if targetscope for role is not defined and since its already
                // verified this user role is assignable by cretor its considered a valid role association
                validUserRoleAssoc = true;
                break;
              }
            }
          }
          if (!validUserRoleAssoc) {
            // check the context role assoc - scope matches with requested scope
            if (subject.role_associations) {
              const creatorRoleAssocs = subject.role_associations;
              for (let role of creatorRoleAssocs) {
                if (role.role === userRole) {
                  // check if the target scope matches
                  let creatorScope;
                  let creatorRoleAttr = role.attributes;
                  if (creatorRoleAttr && creatorRoleAttr[1] && creatorRoleAttr[1].value) {
                    creatorScope = creatorRoleAttr[1].value;
                  }
                  if (creatorScope && creatorScope === userScope) {
                    validUserRoleAssoc = true;
                    break;
                  }
                }
              }
            }
          }
          if (!validUserRoleAssoc) {
            let details = '';
            if (userScope) {
              details = `do not have permissions to assign target scope ${userScope} for ${userName}`;
            }
            let message = `the role ${userRole} cannot be assigned to user ${userName};${details}`;
            this.logger.verbose(message);
            throw new errors.InvalidArgument(message);
          }
        }
      }
    }
  }

  private checkTargetScopeExists(hrScope: HierarchicalScope, targetScope: string): boolean {
    if (hrScope.id === targetScope) {
      // found the target scope object, iterate and put the orgs in reducedUserScope array
      this.logger.debug(`Valid target scope:`, targetScope);
      return true;
    } else if (hrScope.children) {
      for (let childNode of hrScope.children) {
        if (this.checkTargetScopeExists(childNode, targetScope)) {
          return true;
        }
      }
    }
    return false;
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
    if ((!user.password && !user.invite)) {
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
        and no capital characters, it can contain alphanumeric characters or any character of the following: ?!.*-_`);
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
        { name: { $eq: user.name } },
        { email: { $eq: user.email } },
      ]
    });
    let users = await super.read({ request: { filter } }, context);
    if (users.total_count > 0) {
      let guest = false;
      users = users.items;
      for (let user of users) {
        if (user.guest) {
          guest = true;
        } else {
          logger.debug('user does already exist', users);
          throw new errors.AlreadyExists('user does already exist');
        }
      }
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
    const register = this.cfg.get('service:register');
    if (!register) {
      this.logger.info('Endpoint register has been disabled');
      throw new errors.FailedPrecondition('Endpoint register has been disabled');
    }
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

    // TODO: verify captcha_code before deleting
    delete user['captcha_code'];
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

  async confirmUserInvitation(call: any, context: any): Promise<any> {
    const userInviteReq: UserInviationReq = call.request || call;
    // find the actual user object from DB using the UserInvitationReq username
    // activate user and update password
    this.disableAC();
    let user: User = (await this.find({ request: { name: userInviteReq.name } })).items[0];
    this.enableAC();

    if ((!userInviteReq.activation_code) || userInviteReq.activation_code !== user.activation_code) {
      this.logger.debug('wrong activation code', { user });
      throw new errors.FailedPrecondition('wrong activation code');
    }

    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, {
        name: userInviteReq.name,
        password_hash: password.hash(userInviteReq.password),
        activation_code: userInviteReq.activation_code
      }, AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      user.active = true;
      user.unauthenticated = false;
      user.activation_code = '';

      const password_hash = password.hash(userInviteReq.password);
      user.password_hash = password_hash;
      const serviceCall = {
        request: {
          items: [user]
        }
      };
      await super.update(serviceCall, context);
      this.logger.info('password updated for invited user', { name: userInviteReq.name });
      return {};
    }
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
          email: { $eq: emailAddress }
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
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { name: userName, activation_code: activationCode },
        AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const filter = toStruct({
        name: { $eq: userName }
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
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id: userID, password: pw, new_password: newPw },
        AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const filter = toStruct({
        id: { $eq: userID }
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
    this.disableAC();
    const user: User = (await this.find({
      request: call.request
    })).items[0]; // NotFound exception is thrown when length is 0
    this.enableAC();

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
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, {
        activation_code,
        password_hash: password.hash(newPassword)
      }, AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      this.disableAC();
      const user: User = (await this.find({
        request: {
          name
        }
      })).items[0];
      this.enableAC();

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
      id: { $eq: userID }
    });
    const users = await super.read({ request: { filter } }, context);
    if (users.total_count === 0) {
      logger.debug('user does not exist', userID);
      throw new errors.NotFound('user does not exist');
    }
    const user: User = users.items[0];

    user.new_email = email;
    user.activation_code = this.idGen();
    const serviceCall = {
      request: {
        items: [user]
      }
    };
    await super.update(serviceCall, context);
    logger.info('Email change requested for user', userID);
    await this.topics['user.resource'].emit('emailChangeRequested', user);

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
  async confirmEmailChange(call: Call<ConfirmEmailChange>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    const name = request.name;
    const activationCode = request.activation_code;

    this.disableAC();
    const users = await this.find({
      request: {
        name
      }
    });
    this.enableAC();
    if (users.total_count === 0) {
      logger.debug('user does not exist', name);
      throw new errors.NotFound('user does not exist');
    }

    const user: User = users.items[0];
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, {
        activation_code: activationCode,
        email: user.new_email
      }, AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (user.activation_code !== activationCode) {
        logger.debug('wrong activation code upon email confirmation for user', user);
        throw new errors.FailedPrecondition('wrong activation code');
      }
      user.email = user.new_email;
      user.new_email = '';
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
  }

  /**
   * Extends the generic update operation in order to update any fields
   * depending on the rules configured for the User scope
   * @param call
   * @param context
   */
  async update(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for update');
    }
    const items = call.request.items;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, items, AuthZAction.MODIFY,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      for (let i = 0; i < items.length; i += 1) {
        // read the user from DB and update the special fields from DB
        // for user modification
        const user = items[i];
        const filter = toStruct({
          id: { $eq: user.id }
        });
        const users = await super.read({ request: { filter } }, context);
        if (users.total_count === 0) {
          throw new errors.NotFound('user not found');
        }
        let dbUser = users.items[0];
        if (dbUser.name != user.name) {
          throw new errors.InvalidArgument('User name field cannot be updated');
        }
        // Update password if it contains that field by updating hash
        if (user.password) {
          user.password_hash = password.hash(user.password);
          delete user.password;
        } else {
          // set the existing hash password field
          user.password_hash = dbUser.password_hash;
        }
      }
      return super.update(call, context);
    }
  }

  /**
   * Extends the generic upsert operation in order to upsert any fields
   * @param call
   * @param context
   */
  async upsert(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for upsert');
    }

    const usersList = call.request.items;
    let subject = await getSubjectFromRedis(call, this);

    let acsResponse;
    try {
      acsResponse = await checkAccessRequest(subject, usersList, AuthZAction.CREATE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (this.cfg.get('authorization:enabled')) {
      try {
        await this.verifyUserRoleAssociations(usersList, subject);
      } catch (err) {
        // for unhandled promise rejection
        throw err;
      }
    }
    if (acsResponse.decision === Decision.PERMIT) {
      let result = [];
      const items = call.request.items;
      for (let i = 0; i < items.length; i += 1) {
        // read the user from DB and update the special fields from DB
        // for user modification
        const user = items[i];
        const filter = toStruct({
          $or: [
            {
              name: {
                $eq: user.name
              }
            },
            {
              email: {
                $eq: user.email
              }
            }
          ]
        });
        const users = await super.read({ request: { filter } }, context);
        if (users.total_count === 0) {
          // call the create method, checks all conditions before inserting
          result.push(await this.createUser(user));
        } else {
          let updateResponse = await this.update({ request: { items: [user], subject } });
          result.push(updateResponse.items[0]);
        }
      }
      return { items: result };
    }
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
      (_.isEmpty(call.request.identifier) || (_.isEmpty(call.request.password)))) {
      throw new errors.InvalidArgument('Missing credentials');
    }
    const identifier = call.request.identifier;
    const obfuscateAuthNErrorReason = this.cfg.get('obfuscateAuthNErrorReason') ?
      this.cfg.get('obfuscateAuthNErrorReason') : false;
    // check for the identifier against name or email in DB
    const filter = toStruct({
      $or: [
        {
          name: {
            $eq: identifier
          }
        },
        {
          email: {
            $eq: identifier
          }
        }
      ]
    });

    const users = await super.read({ request: { filter } }, context);
    if (users.total_count === 0) {
      if (obfuscateAuthNErrorReason) {
        throw new errors.FailedPrecondition('Invalid credentials provided, user inactive or account does not exist');
      } else {
        throw new errors.NotFound('user not found');
      }
    }
    const user = users.items[0];
    if (!user.active) {
      if (obfuscateAuthNErrorReason) {
        throw new errors.FailedPrecondition('Invalid credentials provided, user inactive or account does not exist');
      } else {
        throw new errors.FailedPrecondition('user is inactive');
      }
    }
    const match = password.verify(user.password_hash, call.request.password);
    if (!match) {
      if (obfuscateAuthNErrorReason) {
        throw new errors.FailedPrecondition('Invalid credentials provided, user inactive or account does not exist');
      } else {
        throw new errors.Unauthenticated('password does not match');
      }
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

    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id: userID }, AuthZAction.DELETE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const filter = toStruct({
        id: { $eq: userID }
      });
      const users = await super.read({ request: { filter } }, context);
      if (users.total_count === 0) {
        logger.debug('user does not exist', userID);
        throw new errors.NotFound(`user with ${userID} does not exist for unregistering`);
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
  }

  /**
   * Endpoint delete, to delete a user or list of users
   * @param  {any} call request containing list of userIds or collection name
   * @param {any} context
   * @return {} returns empty response
   */
  async delete(call: any, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    let userIDs = request.ids;

    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id: userIDs }, AuthZAction.DELETE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const serviceCall = {
          request: {
            collection: request.collection
          }
        };
        await super.delete(serviceCall, context);
        logger.info('Users collection deleted:');
        return {};
      }
      if (!_.isArray(userIDs)) {
        userIDs = [userIDs];
      }
      logger.silly('Deleting User IDs:', { userIDs });
      // Check each user exist if one of the user does not exist throw an error
      for (let userID of userIDs) {
        const filter = toStruct({
          id: { $eq: userID }
        });
        const users = await super.read({ request: { filter } }, context);
        if (users.total_count === 0) {
          logger.debug('User does not exist for deleting:', { userID });
          throw new errors.NotFound(`User with ${userID} does not exist for deleting`);
        }
      }

      // delete users
      const serviceCall = {
        request: {
          ids: userIDs
        }
      };
      await super.delete(serviceCall, context);
      logger.info('Users deleted:', userIDs);
      return {};
    }
  }

  async deleteUsersByOrg(call: any, context?: any): Promise<any> {
    const orgIDs = call.request.org_ids;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id: orgIDs }, AuthZAction.DELETE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const deletedUserIDs = await this.modifyUsers(orgIDs, false, context, subject);
      return { user_ids: deletedUserIDs.map((user) => { return user.id; }) };
    }
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
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { role }, AuthZAction.READ,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const result = await this.roleService.read({
        request: {
          filter: toStruct({
            name: { $eq: role }
          }),
          field: [{
            name: 'id',
            include: true
          }],
          subject
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
  }

  /**
   * Initializes useful data for rendering requests
   * before sending emails (user registration / change).
   * @param {kafkaClient.Topic} renderingTopic Kafka topic with
   * rendering-srv events.
   * @param {any } tplConfig Templates prefix and URLs.
   */
  async setRenderRequestConfigs(tplConfig: any): Promise<any> {
    let response: any;
    try {
      response = await fetch(tplConfig.registerSubjectURL);
      this.registerSubjectTpl = await response.text();

      response = await fetch(tplConfig.registerBodyURL);
      this.registerBodyTpl = await response.text();

      response = await fetch(tplConfig.changeSubjectURL);
      this.changeSubjectTpl = await response.text();

      response = await fetch(tplConfig.changeBodyURL);
      this.changeBodyTpl = await response.text();

      response = await fetch(tplConfig.invitationSubjectURL);
      this.invitationSubjectTpl = await response.text();

      response = await fetch(tplConfig.invitationBodyURL);
      this.invitationBodyTpl = await response.text();

      response = await fetch(tplConfig.layoutURL);
      this.layoutTpl = await response.text();

      response = await fetch(tplConfig.resourcesURL, {});
      if (response.status == 200) {
        const externalRrc = JSON.parse(await response.text());
        this.emailStyle = externalRrc.styleURL;
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
    let activationURL: string = this.cfg.get('service:activationURL');
    if (!activationURL.endsWith('/')) {
      activationURL += '/';
    }

    activationURL = `${activationURL}${user.name}/${user.activation_code}`;

    const dataBody = {
      firstName: user.first_name,
      lastName: user.last_name,
      activationURL
    };
    // since there are no place holders in subject
    const dataSubject = { userName: user.name };

    const emailBody = this.registerBodyTpl;
    const emailSubject = this.registerSubjectTpl;
    return this.makeRenderRequestMsg(user, emailSubject, emailBody,
      dataBody, dataSubject);
  }

  private makeInvitationEmailData(user: User): any {
    let invitationURL: string = this.cfg.get('service:invitationURL');
    if (!invitationURL.endsWith('/')) {
      invitationURL += '/';
    }

    invitationURL = `${invitationURL}${user.name}/${user.activation_code}`;

    const dataBody = {
      firstName: user.first_name,
      lastName: user.last_name,
      invitedByUserName: user.invited_by_user_name,
      invitedByUserFirstName: user.invited_by_user_first_name,
      invitedByUserLastName: user.invited_by_user_last_name,
      invitationURL
    };

    const dataSubject = {
      invitedByUserName: user.invited_by_user_name,
      invitedByUserFirstName: user.invited_by_user_first_name,
      invitedByUserLastName: user.invited_by_user_last_name
    };

    const emailBody = this.invitationBodyTpl;
    const emailSubject = this.invitationSubjectTpl;
    return this.makeRenderRequestMsg(user, emailSubject, emailBody,
      dataBody, dataSubject);
  }

  private makeConfirmationData(user: User, passwordChange: boolean): any {
    const emailBody = this.changeBodyTpl;
    const emailSubject = this.changeSubjectTpl;

    let URL: string = passwordChange ? this.cfg.get('service:passwordChangeConfirmationURL')
      : this.cfg.get('service:emailConfirmationURL'); // prefix

    if (!URL.endsWith('/')) {
      URL += '/';
    }

    URL = `${URL}${user.name}/${user.activation_code}`; // actual email

    const dataBody = {
      firstName: user.first_name,
      lastName: user.last_name,
      confirmationURL: URL,
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
        style_url: this.emailStyle, // URL to a style
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

  disableAC() {
    try {
      this.cfg.set('authorization:enabled', false);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught disabling authorization:', err);
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  enableAC() {
    try {
      this.cfg.set('authorization:enabled', this.authZCheck);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught enabling authorization:', err);
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  private async modifyUsers(orgIds: string[], deactivate: boolean,
    context?: any, subject?: any): Promise<User[]> {
    const ROLE_SCOPING_ENTITY = this.cfg.get('urns:roleScopingEntity');
    const ORGANIZATION_URN = this.cfg.get('urns:organization');
    const ROLE_SCOPING_INSTANCE = this.cfg.get('urns:roleScopingInstance');

    const eligibleUsers = [];

    const roleID = await this.getNormalUserRoleID(context, subject);
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
  private async getNormalUserRoleID(context: any, subject: Subject): Promise<any> {
    let roleID;
    const roleName = this.cfg.get('roles:normalUser');
    const filter = toStruct(
      { name: { $eq: roleName } },
    );
    const role: any = await this.roleService.read({ request: { filter, subject } }, context);
    if (role) {
      roleID = role.items[0].id;
    }
    return roleID;
  }

  private makeNotificationData(emailAddress: string, responseBody: any,
    responseSubject: any): any {
    return {
      email: {
        to: emailAddress.split(',')
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

  private async createOwnerAttributes(subject: Subject) {
    const urns = this.cfg.get('authorization:urns');
    let ownUser = false;
    let foundEntity = false;
    for (let attribute of ownerAttributes) {
      if (attribute.id == urns.ownerIndicatoryEntity && attribute.value == urns.user) {
        foundEntity = true;
      } else if (attribute.id == urns.ownerInstance && attribute.value == subject.id && foundEntity) {
        ownUser = true;
        break;
      }
    }

    // if no owner attributes specified then by default add the subject scope and user as default owner
    if (!ownUser && subject && ownerAttributes.length === 0) {
      // subject owner
      ownerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization
        },
        {
          id: urns.ownerInstance,
          value: subject.scope
        });
      // user owner
      ownerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.user
        },
        {
          id: urns.ownerInstance,
          value: subject.id
        });
    }
  }

  /**
 * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
 * @param reaources list of resources
 * @param entity entity name
 * @param action resource action
 */
  private async createMetadata(resources: any, action: string, subject?: Subject): Promise<any> {
    let ownerAttributes = [];
    let ids = [];
    if (!_.isArray(resources)) {
      resources = [resources];
    }
    for (let resource of resources) {
      // if (resource) {
      //   ids.push(resource.id);
      // }
      if (!resource.id && action === AuthZAction.CREATE) {
        if (resource)
      }
    }
    // need to add resource meta for all if it does not exist
    for (let resource of resources) {
      if (!resource.meta) {
        resource.meta = {};
      }
      if (resource.meta && resource.meta.owner) {
        ownerAttributes = resource.meta.owner;
      }

      // read the entity to use owner information from exising value in DB for
      // UPDATE and DELETE actions
      if (resource.id && action != AuthZAction.CREATE) {
        let result = await super.read({
          request: {
            filter: toStruct({
              id: {
                $in: ids
              }
            })
          }
        });
        // update owner info
        if (result.items.length === 1) {
          let item = result.items[0];
          if (!resource.meta) {
            resource.meta = {};
          }
          resource.meta.owner = item.meta.owner;
        }
      } else {
        resource.meta.owner = ownerAttributes;
      }
    }
    return resources;
  }
}



export class RoleService extends ServiceBase {
  logger: Logger;
  redisClient: RedisClient;
  cfg: any;
  authZ: ACSAuthZ;
  authZCheck: boolean;
  constructor(cfg: any, db: any, roleTopic: kafkaClient.Topic, logger: any,
    isEventsEnabled: boolean, authZ: ACSAuthZ, redisClient?: RedisClient) {
    super('role', roleTopic, logger, new ResourcesAPIBase(db, 'roles'), isEventsEnabled);
    this.logger = logger;
    this.redisClient = redisClient;
    this.authZ = authZ;
    this.cfg = cfg;
    this.authZCheck = this.cfg.get('authorization:enabled');
  }

  async create(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.items || call.request.items.length == 0) {
      throw new errors.InvalidArgument('No role was provided for creation');
    }

    const items = call.request.items;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, items, AuthZAction.CREATE,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      for (let role of items) {
        // check unique constraint for role name
        if (!role.name) {
          throw new errors.InvalidArgument('argument role name is empty');
        }
        const result = await super.read({
          request: {
            filter: toStruct({
              name: { $eq: role.name }
            })
          }
        }, context);
        if (result && result.items && result.items.length > 0) {
          throw new errors.AlreadyExists(`Role ${role.name} already exists`);
        }
      }
      return super.create(call, context);
    }
  }

  /**
   * Extends ServiceBase.read()
   * @param  {any} call request contains read request
   * @param {context}
   * @return type is any since it can be guest or user type
   */
  async read(call: any, context?: any): Promise<any> {
    const readRequest = call.request;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      return await super.read({ request: readRequest });
    }
  }

  /**
   * Extends the generic update operation in order to update any fields
   * @param call
   * @param context
   */
  async update(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for update');
    }

    const items = call.request.items;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, items, AuthZAction.MODIFY,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      for (let i = 0; i < items.length; i += 1) {
        // read the role from DB and check if it exists
        const role = items[i];
        const filter = toStruct({
          id: { $eq: role.id }
        });
        const roles = await super.read({ request: { filter } }, context);
        if (roles.total_count === 0) {
          throw new errors.NotFound('roles not found for updating');
        }
      }
      return super.update(call, context);
    }
  }

  /**
   * Extends the generic upsert operation in order to upsert any fields
   * @param call
   * @param context
   */
  async upsert(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)
      || _.isEmpty(call.request.items)) {
      throw new errors.InvalidArgument('No items were provided for upsert');
    }

    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request.items, AuthZAction.CREATE,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      return super.upsert(call, context);
    }
  }

  /**
   * Endpoint delete, to delete a role or list of roles
   * @param  {any} call request containing list of userIds or collection name
   * @param {any} context
   * @return {} returns empty response
   */
  async delete(call: any, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    let roleIDs = request.ids;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request.items, AuthZAction.DELETE,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new errors.PermissionDenied(acsResponse.response.status.message);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const serviceCall = {
          request: {
            collection: request.collection
          }
        };
        await super.delete(serviceCall, context);
        logger.info('Role collection deleted:');
        return {};
      }
      if (!_.isArray(roleIDs)) {
        roleIDs = [roleIDs];
      }
      logger.silly('deleting Role IDs:', { roleIDs });
      // Check each user exist if one of the user does not exist throw an error
      for (let roleID of roleIDs) {
        const filter = toStruct({
          id: { $eq: roleID }
        });
        const roles = await super.read({ request: { filter } }, context);
        if (roles.total_count === 0) {
          logger.debug('Role does not exist for deleting:', { roleID });
          throw new errors.NotFound(`Role with ${roleID} does not exist for deleting`);
        }
      }
      // delete users
      const serviceCall = {
        request: {
          ids: roleIDs
        }
      };
      await super.delete(serviceCall, context);
      logger.info('Roles deleted:', roleIDs);
      return {};
    }
  }

  async verifyRoles(roleAssociations: RoleAssociation[]): Promise<boolean> {
    // checking if user roles are valid
    for (let roleAssociation of roleAssociations) {
      const roleID = roleAssociation.role;
      const result = await super.read({
        request: {
          filter: toStruct({
            id: { $eq: roleID }
          })
        }
      }, {});

      if (!result || !result.items || result.total_count == 0) {
        return false;
      }
    }

    return true;
  }

  disableAC() {
    try {
      this.cfg.set('authorization:enabled', false);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught disabling authorization:', err);
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  enableAC() {
    try {
      this.cfg.set('authorization:enabled', this.authZCheck);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught enabling authorization:', err);
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }
}
