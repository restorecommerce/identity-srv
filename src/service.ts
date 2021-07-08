import * as _ from 'lodash';
import * as uuid from 'uuid';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as fetch from 'node-fetch';
import { ServiceBase, ResourcesAPIBase, FilterOperation } from '@restorecommerce/resource-base-interface';
import { DocumentMetadata, OperatorType } from '@restorecommerce/resource-base-interface/lib/core/interfaces';
import { Logger } from 'winston';
import {
  ACSAuthZ, AuthZAction, Decision, Subject, updateConfig, accessRequest,
  HierarchicalScope, RoleAssociation, PolicySetRQResponse, DecisionResponse
} from '@restorecommerce/acs-client';
import Redis from 'ioredis';
import { checkAccessRequest, password, unmarshallProtobufAny, marshallProtobufAny, getDefaultFilter, getNameFilter, returnOperationStatus, returnStatusArray, returnCodeMessage, returnStatus } from './utils';
import { errors } from '@restorecommerce/chassis-srv';
import { query } from '@restorecommerce/chassis-srv/lib/database/provider/arango/common';
import {
  validateFirstChar, validateSymbolRepeat, validateAllChar,
  validateStrLen, validateAtSymbol, validateEmail
} from './validation';
import { TokenService } from './token_service';
import { Arango } from '@restorecommerce/chassis-srv/lib/database/provider/arango/base';
import {
  FindUser, AccessResponse, FindUserByToken, Call, ReadPolicyResponse,
  User, UserInviationReq, ActivateUser, ChangePassword, ForgotPassword,
  ConfirmPasswordChange, EmailChange, ConfirmEmailChange, UnregisterRequest,
  SendActivationEmailRequest, SendInvitationEmailRequest, UserPayload
} from './interface';

const TECHNICAL_USER = 'TECHNICAL_USER';

export class UserService extends ServiceBase {
  db: Arango;
  topics: any;
  logger: Logger;
  cfg: any;
  registrationSubjectTpl: string;
  changePWEmailSubjectTpl: string;
  layoutTpl: string;
  registrationBodyTpl: string;
  changePWEmailBodyTpl: string;
  invitationSubjectTpl: string;
  invitationBodyTpl: string;
  emailEnabled: boolean;
  emailStyle: string;
  roleService: RoleService;
  authZ: ACSAuthZ;
  redisClient: Redis;
  authZCheck: boolean;
  tokenService: TokenService;
  tokenRedisClient: Redis;
  uniqueEmailConstraint: boolean;
  constructor(cfg: any, topics: any, db: any, logger: Logger,
    isEventsEnabled: boolean, roleService: RoleService, authZ: ACSAuthZ) {
    super('user', topics['user.resource'], logger, new ResourcesAPIBase(db, 'users'),
      isEventsEnabled);
    this.cfg = cfg;
    this.db = db;
    this.topics = topics;
    this.logger = logger;
    this.roleService = roleService;
    this.authZ = authZ;
    const redisConfig = cfg.get('redis');
    redisConfig.db = cfg.get('redis:db-indexes:db-subject');
    this.redisClient = new Redis(redisConfig);
    this.authZCheck = this.cfg.get('authorization:enabled');
    redisConfig.db = this.cfg.get('redis:db-indexes:db-findByToken') || 0;
    this.tokenRedisClient = new Redis(redisConfig);
    this.tokenService = new TokenService(cfg, logger, authZ, this);
    this.emailEnabled = this.cfg.get('service:enableEmail');
    const isConfigSet = this.cfg.get('service:uniqueEmailConstraint');
    if (isConfigSet === undefined || isConfigSet) {
      // by default if config is missing or set to true, email constraint is enabled
      this.uniqueEmailConstraint = true;
    } else if (isConfigSet === false) {
      // if config is set to false in config
      this.uniqueEmailConstraint = false;
    }
  }

  async stop(): Promise<void> {
    await this.redisClient.quit();
    await this.tokenRedisClient.quit();
  }

  /**
   * Endpoint to search for users containing any of the provided field values.
   * @param {Call<FindUser>} call request containing either userid, username or email
   * @return the list of users found
   */
  async find(call: Call<FindUser>, context?: any): Promise<any> {
    let { id, name, email, subject } = call.request;
    const readRequest = call.request;
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest,
        AuthZAction.READ, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (acsResponse.decision === Decision.PERMIT) {
      const logger = this.logger;
      const filterStructure: any = {
        filters: [{
          filter: []
        }]
      };
      if (id) {
        // Object.assign(filterStructure, { id: { $eq: id } });
        filterStructure.filters[0].filter.push({
          field: 'id',
          operation: FilterOperation.eq,
          value: id
        });
      }
      if (name) {
        // Object.assign(filterStructure, { name: { $eq: name } });
        filterStructure.filters[0].filter.push({
          field: 'name',
          operation: FilterOperation.eq,
          value: name
        });
      }
      if (email) {
        // Object.assign(filterStructure, { email: { $eq: email } });
        filterStructure.filters[0].filter.push({
          field: 'email',
          operation: FilterOperation.eq,
          value: email
        });
      }
      if (filterStructure.filters[0].filter.length > 1) {
        filterStructure.filters[0].operator = OperatorType.or;
      }

      // add ACS filters if subject is not tech user
      let acsFilterObj, techUser;
      const techUsersCfg = this.cfg.get('techUsers');
      if (techUsersCfg && techUsersCfg.length > 0) {
        techUser = _.find(techUsersCfg, { id: subject.id });
      }
      if (!techUser && readRequest.filters) {
        acsFilterObj = readRequest.filters;
      }
      if (!_.isEmpty(acsFilterObj)) {
        _.merge(filterStructure, acsFilterObj);
      }
      readRequest.filters = filterStructure;
      const users = await super.read({ request: readRequest }, context);
      if (users.total_count > 0) {
        logger.silly('found user(s)', { users });
        return users;
      }
      logger.silly('user(s) could not be found for request', call.request);
      return returnOperationStatus(404, 'user not found');
    }
  }

  async updateUserTokens(id, token) {
    // temporary hack to update tokens on user(to fix issue when same user login multiple times simultaneously)
    // tokens get overwritten with update operation on simultaneours req
    if (token && token.interactive) {
      // insert token to tokens array
      const aql_token = `FOR doc in users FILTER doc.id == @docID UPDATE doc WITH
      { tokens: PUSH(doc.tokens, @token)} IN users return doc`;
      const bindVars = Object.assign({
        docID: id,
        token
      });
      const res = await query(this.db.db, 'users', aql_token, bindVars);
      await res.all();
      // update last_access
      const aql_last_accesss = `FOR doc in users FILTER doc.id == @docID UPDATE doc WITH
      { last_access: @last_access} IN users return doc`;
      const bindVars_last_access = Object.assign({
        docID: id,
        last_access: new Date().getTime()
      });
      const res_last_access = await query(this.db.db, 'users', aql_last_accesss, bindVars_last_access);
      await res_last_access.all();
      this.logger.debug('Tokens updated successuflly for subject', { id });
    }
  }

  /**
   * Endpoint to search for user by token.
   * @param {call} call request containing token
   * @return user found
   */
  async findByToken(call: Call<FindUserByToken>, context?: any): Promise<UserPayload> {
    const { token } = call.request;
    let userData;
    const logger = this.logger;
    if (token) {
      userData = await new Promise((resolve: any, reject) => {
        this.tokenRedisClient.get(token, async (err, response) => {
          if (!err && response) {
            // user data
            logger.debug('Found user data in redis cache', { token });
            const redisResp = JSON.parse(response);
            // validate token expiry date and delete it if expired
            if (redisResp && redisResp.tokens) {
              const dbToken = _.find(redisResp.tokens, { token });
              if ((dbToken && dbToken.expires_in === 0) || (dbToken && dbToken.expires_in >= Math.round(new Date().getTime() / 1000))) {
                return resolve({ payload: redisResp, status: returnCodeMessage(200, 'success') });
              } else {
                // delete token from redis and update user entity
                this.tokenRedisClient.del(token, async (err, numberOfDeletedKeys) => {
                  if (err) {
                    this.logger.error('Error deleting cached findByTOken data from redis', { err });
                    resolve({ status: returnCodeMessage(500, 'Error deleting cached findByTOken data from redis') });
                  } else {
                    this.logger.info('Redis cached data for findByToken deleted successfully', { noOfKeys: numberOfDeletedKeys });
                  }
                  resolve({ status: returnCodeMessage(401, 'Redis cached data for findByToken deleted successfully') });
                });
              }
            }
          }
          // when not set in redis
          // regex filter search field for token array
          const filters = [{
            filter: [{
              field: 'tokens[*].token',
              operation: FilterOperation.in,
              value: token
            }]
          }];
          let users = await super.read({ request: { filters } }, context);
          if (users.total_count === 0) {
            logger.debug('No user found for provided token value', { token });
            return resolve({ status: { code: 401, message: 'No user found for provided token value' } });
          }
          if (users.total_count === 1) {
            logger.debug('found user from token', { users });
            if (users.items && users.items[0] && users.items[0].payload) {
              // validate token expiry and delete if expired
              const dbToken = _.find(users.items[0].payload.tokens, { token });
              let tokenTechUser: any = {};
              const techUsersCfg = this.cfg.get('techUsers');
              if (techUsersCfg && techUsersCfg.length > 0) {
                tokenTechUser = _.find(techUsersCfg, { id: 'upsert_user_tokens' });
              }

              if ((dbToken && dbToken.expires_in === 0) || (dbToken && dbToken.expires_in >= Math.round(new Date().getTime() / 1000))) {
                this.tokenRedisClient.set(token, JSON.stringify(users.items[0].payload));
                logger.debug('Stored user data to redis cache successfully');
                // update token last_login
                let user = users.items[0].payload;
                if (user && user && user.tokens && user.tokens.length > 0) {
                  for (let user_token of user.tokens) {
                    if (user_token.token === token) {
                      user_token.last_login = new Date().getTime();
                    }
                  }
                }
                await this.update({ request: { items: [user], subject: tokenTechUser } });
                return resolve({ payload: user, status: { code: 200, message: 'success' } });
              } else if (dbToken && dbToken.expires_in < Math.round(new Date().getTime() / 1000)) {
                logger.debug('Token expired');
                resolve({ status: { code: 401, message: 'Token ${token} expired' } });
              }
            }
          }
          logger.silly('multiple user found for request', call.request);
          resolve({ status: { code: 400, message: 'multiple users found for token' } });
        });
      });
    }
    return userData;
  }

  /**
   * Endpoint to check if User activation process is required.
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
    let subject = call.request.subject;
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
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
    const insertedUsers = { items: [], operation_status: { code: 0, message: '' } };
    // verify the assigned role_associations with the HR scope data before creating
    // extract details from auth_context of request and update the context Object
    let subject = call.request.subject;
    // update meta data for owner information
    const acsResources = await this.createMetadata(usersList, AuthZAction.CREATE, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.CREATE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (acsResponse.decision === Decision.PERMIT) {
      if (this.cfg.get('authorization:enabled')) {
        try {
          await this.verifyUserRoleAssociations(usersList, subject);
        } catch (err) {
          this.logger.error('Error caught verifying user role associations', { message: err.message });
          const errMessage = err.details ? err.details : err.message;
          // for unhandled promise rejection
          return returnOperationStatus(400, errMessage);
        }
      }
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
        insertedUsers.items.push(await this.createUser(user, context));

        if (this.emailEnabled && user.invite) {
          await this.fetchHbsTemplates();
          // send render request for user Invitation
          const renderRequest = this.makeInvitationEmailData(user);
          await this.topics.rendering.emit('renderRequest', renderRequest);
        }
      }
      insertedUsers.operation_status = returnCodeMessage(200, 'success');
      return insertedUsers;
    }
  }

  private async verifyUserRoleAssociations(usersList: User[], subject: any): Promise<void> {
    let validateRoleScope = false;
    let token, redisHRScopesKey, user;
    let hierarchical_scopes = [];
    if (subject) {
      token = subject.token;
    }
    if (token) {
      user = await this.findByToken({ request: { token } });
      if (user) {
        const tokenFound = _.find(user.tokens, { token });
        if (tokenFound && tokenFound.interactive) {
          redisHRScopesKey = `cache:${user.id}:hrScopes`;
        } else if (tokenFound && !tokenFound.interactive) {
          redisHRScopesKey = `cache:${user.id}:${token}:hrScopes`;
        }
        subject.role_associations = user.role_associations;
      }
    }

    if (redisHRScopesKey) {
      hierarchical_scopes = await new Promise((resolve, reject) => {
        this.redisClient.get(redisHRScopesKey, async (err, response) => {
          if (!err && response) {
            // update user HR scope and role_associations from redis
            const redisResp = JSON.parse(response);
            resolve(redisResp);
          }
          // when not set in redis
          if (err || (!err && !response)) {
            resolve(subject.hierarchical_scopes);
            return subject.hierarchical_scopes;
          }
        });
      });
    } else if (subject && subject.hierarchical_scopes) {
      hierarchical_scopes = subject.hierarchical_scopes;
    }

    subject.hierarchical_scopes = hierarchical_scopes;
    let createAccessRole = [];
    let skipValidatingScopingInstance = false;
    try {
      // Make whatIsAllowedACS request to retreive the set of applicable
      // policies and check for role scoping entity, if it exists then validate
      // the user role associations if not skip validation
      let acsResponse: DecisionResponse | PolicySetRQResponse;
      try {
        acsResponse = await accessRequest(subject, {
          entity: 'user',
          args: { filter: [] }
        }, AuthZAction.MODIFY, this.authZ);
      } catch (err) {
        this.logger.error('Error making wahtIsAllowedACS request for verifying role associations', { message: err.message });
        throw err;
      }
      // for apiKey no need to verifyUserRoleAssociations
      const configuredApiKey = this.cfg.get('authentication:apiKey');
      if (acsResponse.decision === Decision.PERMIT && (configuredApiKey === subject.token)) {
        return;
      }
      if (acsResponse && (acsResponse as PolicySetRQResponse).policy_sets && (acsResponse as PolicySetRQResponse).policy_sets.length > 0) {
        const policiesList = (acsResponse as PolicySetRQResponse).policy_sets[0].policies;
        if (policiesList && policiesList.length > 0) {
          for (let policy of policiesList) {
            for (let rule of policy.rules) {
              if (rule.effect === 'PERMIT' && rule.target && rule.target.subject) {
                // check if the rule subject has any scoping Entity
                const ruleSubjectAttrs = rule.target.subject;
                for (let ruleAttr of ruleSubjectAttrs) {
                  if (ruleAttr.id === this.cfg.get('authorization:urns:role')) {
                    // rule's role which give's user the acess to create User
                    createAccessRole.push(ruleAttr.value);
                    // check if there is no scoping then skip comparing / validating role scope instance
                    // ex: superAdmin who does not have role scoping instance
                    if (ruleSubjectAttrs.length === 1) {
                      skipValidatingScopingInstance = true;
                    }
                  }
                  if (ruleAttr.id === this.cfg.get('authorization:urns:roleScopingEntity')) {
                    validateRoleScope = true;
                  }
                }
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
      let userRoleAssocs = user.role_associations ? user.role_associations : [];
      let targetUserRoleIds = [];
      if (_.isEmpty(userRoleAssocs)) {
        continue;
      }
      for (let roleAssoc of userRoleAssocs) {
        targetUserRoleIds.push(roleAssoc.role);
      }
      // read all target roles at once and check for each role's assign_by_role
      // contains createAccessRole
      const filters = [{
        filter: [{
          field: 'id',
          operation: FilterOperation.in,
          value: targetUserRoleIds
        }]
      }];
      let rolesData = await this.roleService.read({
        request: {
          filters,
          subject
        }
      });
      if (rolesData && rolesData.total_count === 0) {
        let message = `One or more of the target role IDs are invalid ${targetUserRoleIds},` +
          ` no such role exist in system`;
        this.logger.verbose(message);
        throw new errors.InvalidArgument(message);
      }
      let dbTargetRoles = [];
      for (let targetRole of rolesData.items) {
        if (targetRole.payload) {
          dbTargetRoles.push(targetRole.payload.id);
          if (!targetRole.payload.assignable_by_roles ||
            !createAccessRole.some((role) => targetRole.payload.assignable_by_roles.includes(role))) {
            const userName = user && user.name ? user.name : undefined;
            let message = `The target role ${targetRole.payload.id} cannot be assigned to` +
              ` user ${userName} as user role ${createAccessRole} does not have permissions`;
            this.logger.verbose(message);
            throw new errors.InvalidArgument(message);
          }
        }
      }

      // validate target roles is a valid role in DB
      for (let targetUserRoleId of targetUserRoleIds) {
        if (!dbTargetRoles.includes(targetUserRoleId)) {
          const userName = user && user.name ? user.name : undefined;
          let message = `The target role ${targetUserRoleId} is invalid and cannot be assigned to` +
            ` user ${userName}`;
          this.logger.verbose(message);
          throw new errors.InvalidArgument(message);
        }
      }
    }

    if (skipValidatingScopingInstance) {
      this.logger.debug('Skipping validation of role scoping instance', { role: createAccessRole });
      return;
    }

    if (validateRoleScope) {
      this.logger.debug('Validating assigned user role associations');
      // find the HR scopes which gives user the create access
      // it's an array `hrScopes` since an user can be Admin for multiple orgs
      let hrScopes: HierarchicalScope[] = [];
      hierarchical_scopes = subject.hierarchical_scopes;
      if (!_.isEmpty(hierarchical_scopes)) {
        for (let hrScope of hierarchical_scopes) {
          for (let accessRole of createAccessRole) {
            if (hrScope.role === accessRole) {
              hrScopes.push(hrScope);
            }
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
        if (user.role_associations && user.role_associations.length > 0) {
          this.validateUserRoleAssociations(user.role_associations, hrScopes, user.name, subject);
          if (!_.isEmpty(user.tokens)) {
            for (let token of user.tokens) {
              if (!token.interactive && !_.isEmpty(token.scopes)) {
                for (let scope of token.scopes) {
                  // if scope is not found in role assoc invalid scope assignemnt in token
                  if (!_.find(user.role_associations, { id: scope })) {
                    let message = `Invalid token scope ${scope} found for Subject ${user.id}`;
                    this.logger.verbose(message);
                    throw new errors.InvalidArgument(message);
                  }
                }
              }
            }
          }
        }
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
  private async createUser(user: User, context?: any): Promise<UserPayload> {
    const logger = this.logger;

    // User creation
    logger.silly('request to register a user');

    this.setUserDefaults(user);
    if ((!user.password && !user.invite && (user.user_type != TECHNICAL_USER))) {
      return returnStatus(400, 'argument password is empty', user.id);
    }
    if (!user.email) {
      return returnStatus(400, 'argument email is empty', user.id);
    }
    if (!user.name) {
      return returnStatus(400, 'argument name is empty', user.id);
    }
    if (user.user_type && user.user_type === TECHNICAL_USER && user.password) {
      return returnStatus(400, 'argument password should be empty for technical user', user.id);
    }

    const serviceCfg = this.cfg.get('service');

    const minLength = serviceCfg.minUsernameLength;
    const maxLength = serviceCfg.maxUsernameLength;

    try {
      this.validUsername(user.name, minLength, maxLength, logger);
    } catch (err) {
      const errorMessage = `Error while validating username: ${user.name}, ` +
        `error: ${err.name}, message:${err.details}`;
      logger.error(errorMessage);
      return returnStatus(400, errorMessage, user.id);
    }

    if (_.isEmpty(user.first_name) || _.isEmpty(user.last_name)) {
      return returnStatus(400, 'User register requires both first and last name', user.id);
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
      const createStatus = await super.create(serviceCall, context);
      logger.info('guest user registered', user);
      await (this.topics['user.resource'].emit('registered', user));
      return createStatus.items[0];
    }

    logger.silly('register is checking id, name and email', { id: user.id, name: user.name, email: user.email });
    let filters;
    if (this.uniqueEmailConstraint) {
      filters = [{
        filter: [{
          field: 'name',
          operation: FilterOperation.eq,
          value: user.name
        },
        {
          field: 'email',
          operation: FilterOperation.eq,
          value: user.email
        }],
        operator: OperatorType.or
      }];
    } else {
      filters = getNameFilter(user.name);
    }
    let users = await super.read({ request: { filters } }, context);
    if (users.total_count > 0) {
      let guest = false;
      users = users.items;
      for (let user of users) {
        if (user.payload.guest) {
          guest = true;
          logger.debug('Guest user', { name: user.name });
        } else {
          logger.debug('user does already exist', users);
          return returnStatus(409, 'user does already exist', user?.payload?.id);
        }
      }
    }
    logger.silly('user does not exist');

    // Hash password
    if (user.password) {
      user.password_hash = password.hash(user.password);
      delete user.password;
    }

    if (!this.roleService.verifyRoles(user.role_associations)) {
      return returnStatus(400, 'Invalid role ID in role associations', user.id);
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
  async register(call: any, context?: any): Promise<UserPayload> {
    const user: User = call.request || call;
    const register = this.cfg.get('service:register');
    if (!register) {
      this.logger.info('Endpoint register has been disabled');
      return returnStatus(412, 'Endpoint register has been disabled');
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
    // set default role_associations from configuration
    if (this.cfg.get('defaultRegisterUserRoles')) {
      user.role_associations = this.cfg.get('defaultRegisterUserRoles');
    }
    const createdUser = await this.createUser(user, context);
    if (createdUser?.status?.message === 'success') {
      this.logger.info('user registered', user);
      await this.topics['user.resource'].emit('registered', user);

      // For guest user email should not be sent out
      if (this.emailEnabled && !user.guest) {
        await this.fetchHbsTemplates();
        const renderRequest = this.makeActivationEmailData(user);
        await this.topics.rendering.emit('renderRequest', renderRequest);
      }
    }

    return createdUser;
  }

  async confirmUserInvitation(call: any, context: any): Promise<any> {
    const userInviteReq: UserInviationReq = call.request || call;
    let subject = call.request.subject;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, {
        active: true,
        activation_code: userInviteReq.activation_code,
        password_hash: password.hash(userInviteReq.password),
        unauthenticated: true
      }, AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      // find the actual user object from DB using the UserInvitationReq identifier
      // activate user and update password
      const identifier = userInviteReq.identifier;
      const filters = getDefaultFilter(identifier);
      let user;
      const users = await super.read({ request: { filters } });
      if (users && users.total_count === 1) {
        user = users.items[0].payload;
      } else if (users.total_count === 0) {
        return returnOperationStatus(404, `user not found for identifier ${identifier}`);
      } else if (users.total_count > 1) {
        return returnOperationStatus(400, `Invalid identifier provided for user invitation confirmation, multiple users found for identifier ${identifier}`);
      }

      if ((!userInviteReq.activation_code) || userInviteReq.activation_code !== user.activation_code) {
        this.logger.debug('wrong activation code', { user });
        return returnOperationStatus(412, 'wrong activation code');
      }
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
      const updateStatus = await super.update(serviceCall, context);
      this.logger.info('password updated for invited user', { identifier });
      return { operation_status: updateStatus?.items[0]?.status };
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

    const filters = [{
      filter: [{
        field: 'email',
        operation: FilterOperation.eq,
        value: emailAddress
      },
      {
        field: 'new_email',
        operation: FilterOperation.eq,
        value: emailAddress
      }],
      operator: OperatorType.or
    }];

    const user = await super.read({ request: { filters } });
    if (_.isEmpty(user.items)) {
      this.logger.silly(`Received rendering response from unknown email address ${emailAddress}; discarding`);
      return;
    }

    const responseBody = unmarshallProtobufAny(renderResponse.response[0]);
    const responseSubject = unmarshallProtobufAny(renderResponse.response[1]);
    const emailData = this.makeNotificationData(emailAddress, responseBody, responseSubject);
    await this.topics.notificationReq.emit('sendEmail', emailData);
  }

  private idGen(): string {
    return uuid.v4().replace(/-/g, '');
  }

  // validUsername validates user names using regular expressions
  private validUsername(username: string, minLength: number, maxLength: number, logger: Logger) {
    if (validateAtSymbol(username) == false) {
      // false means that the username contains "@"
      validateEmail(username, logger);
    }
    validateStrLen(username, minLength, maxLength, logger);
    validateFirstChar(username, logger);
    validateAllChar(username, logger);
    validateSymbolRepeat(username, logger);
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
    const identifier = request.identifier;
    const activationCode = request.activation_code;
    let subject = call.request.subject;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { active: true, activation_code: activationCode },
        AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (!identifier) {
        return returnOperationStatus(400, 'argument id is empty');
      }
      if (!activationCode) {
        return returnOperationStatus(400, 'argument activation_code is empty');
      }
      // check for the identifier against name or email in DB
      const filters = getDefaultFilter(identifier);
      const users = await super.read({ request: { filters } }, context);
      if (!users || users.total_count === 0) {
        return returnOperationStatus(404, 'user not found');
      } else if (users.total_count > 1) {
        return returnOperationStatus(400, `Invalid identifier provided for user activation, multiple users found for identifier ${identifier}`);
      }
      const user: User = users.items[0].payload;
      if (user.active) {
        logger.debug('activation request to an active user' +
          ' which still has the activation code', user);
        return returnOperationStatus(412, 'activation request to an active user' +
          ' which still has the activation code');
      }
      if ((!user.activation_code) || user.activation_code !== activationCode) {
        logger.debug('wrong activation code', user);
        return returnOperationStatus(412, 'wrong activation code');
      }

      user.active = true;
      user.unauthenticated = false;

      user.activation_code = '';
      const serviceCall = {
        request: {
          items: [user]
        }
      };
      const updateStatus = await super.update(serviceCall, context);
      if (updateStatus?.items[0].status?.message === 'success') {
        logger.info('user activated', user);
        await this.topics['user.resource'].emit('activated', { id: user.id });
      }
      return { operation_status: updateStatus?.items[0]?.status };
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
    const identifier = request.identifier;

    const pw = request.password;
    const newPw = request.new_password;
    let subject = call.request.subject;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read({ request: { filters } }, context);
    if (!users || users.total_count === 0) {
      logger.debug('user does not exist', { identifier });
      return returnOperationStatus(404, 'user does not exist');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for change password, multiple users found for identifier ${identifier}`);
    }
    const user: User = users.items[0].payload;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id: user.id, password: pw, new_password: newPw, meta: user.meta },
        AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const userPWhash = user.password_hash;
      if (!password.verify(userPWhash, pw)) {
        return returnOperationStatus(401, 'password does not match');
      }

      const password_hash = password.hash(newPw);
      user.password_hash = password_hash;
      const serviceCall = {
        request: {
          items: [user]
        }
      };
      const updateStatus = await super.update(serviceCall, context);
      if (updateStatus?.items[0]?.status?.message === 'success') {
        logger.info('password changed for user', { identifier });
        await this.topics['user.resource'].emit('passwordChanged', user);
      }
      return { operation_status: updateStatus?.items[0]?.status };
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
    const identifier = call.request.identifier;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    let user;
    const users = await super.read({ request: { filters } });
    if (users.total_count === 1) {
      user = users.items[0].payload;
    } else if (!users || users.total_count === 0) {
      return returnOperationStatus(404, 'user not found');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for request password change, multiple users found for identifier ${identifier}`);
    }

    logger.verbose('Received a password change request for user', { id: user.id });

    // generating activation code
    user.activation_code = this.idGen();
    const updateStatus = await super.update({
      request: {
        items: [user]
      }
    });
    if (updateStatus?.items[0]?.status?.message === 'success') {
      await this.topics['user.resource'].emit('passwordChangeRequested', user);

      // sending activation code via email
      if (this.emailEnabled) {
        await this.fetchHbsTemplates();
        const renderRequest = this.makeConfirmationData(user, true, identifier);
        await this.topics.rendering.emit('renderRequest', renderRequest);
      }
    }
    return { operation_status: updateStatus?.items[0]?.status };
  }

  /**
   * Endpoint which is called after the user confirms a password change request.
   *
   * @param call Activation code, new password, user name
   * @param context
   */
  async confirmPasswordChange(call: Call<ConfirmPasswordChange>, context?: any): Promise<any> {
    const logger = this.logger;
    const { identifier, activation_code } = call.request;
    const newPassword = call.request.password;
    let subject = call.request.subject;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, {
        activation_code,
        password_hash: password.hash(newPassword)
      }, AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      // check for the identifier against name or email in DB
      const filters = getDefaultFilter(identifier);
      let user;
      const users = await super.read({ request: { filters } });
      if (!users || users.total_count === 0) {
        return returnOperationStatus(404, 'user not found');
      } else if (users.total_count === 1) {
        user = users.items[0].payload;
      } else if (users.total_count > 1) {
        return returnOperationStatus(400, `Invalid identifier provided for confirm password change, multiple users found for identifier ${identifier}`);
      }

      if (!user.activation_code || user.activation_code !== activation_code) {
        logger.debug('wrong activation code upon password change confirmation for user', user.name);
        return returnOperationStatus(412, 'wrong activation code');
      }

      user.activation_code = '';
      user.password_hash = password.hash(newPassword);
      const updateStatus = await super.update({
        request: {
          items: [user]
        }
      });
      if (updateStatus?.items[0]?.status?.message === 'success') {
        logger.info('password changed for user', user.id);
        await this.topics['user.resource'].emit('passwordChanged', user);
      }
      return { operation_status: updateStatus?.items[0]?.status };
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
    const identifier = request.identifier;
    const new_email = request.new_email;
    const subject = call.request.subject;
    let acsResponse: DecisionResponse;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read({ request: { filters } }, context);
    if (!users || users.total_count === 0) {
      logger.debug('user does not exist', { identifier });
      return returnOperationStatus(404, 'user does not exist');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for request email change, multiple users found for identifier ${identifier}`);
    }
    const user: User = users.items[0].payload;
    try {
      acsResponse = await checkAccessRequest(subject, { id: user.id, identifier, new_email, meta: user.meta },
        AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      user.new_email = new_email;
      user.activation_code = this.idGen();
      const serviceCall = {
        request: {
          items: [user]
        }
      };
      const updateStatus = await super.update(serviceCall, context);
      if (updateStatus?.items[0]?.status?.message === 'success') {
        logger.info('Email change requested for user', { email: new_email });
        await this.topics['user.resource'].emit('emailChangeRequested', user);

        if (this.emailEnabled) {
          await this.fetchHbsTemplates();
          const renderRequest = this.makeConfirmationData(user, false, identifier, new_email);
          await this.topics.rendering.emit('renderRequest', renderRequest);
        }
      }
      return { operation_status: updateStatus?.items[0]?.status };
    }
  }

  /**
   * Endpoint to confirm email change.
   * @param  {Call<ConfirmEmailChange>} call request containing new email Id of User
   * @param {any} context
   * @return {User} returns user details
   */
  async confirmEmailChange(call: Call<ConfirmEmailChange>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    const identifier = request.identifier;
    const activationCode = request.activation_code;

    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read({ request: { filters } });
    if (users && users.total_count === 0) {
      logger.debug('user does not exist', identifier);
      return returnOperationStatus(404, 'user does not exist');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for confirm email change, multiple users found for identifier ${identifier}`);
    }

    const user: User = users.items[0].payload;
    let subject = call.request.subject;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, {
        activation_code: activationCode,
        email: user.new_email
      }, AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (user.activation_code !== activationCode) {
        logger.debug('wrong activation code upon email confirmation for user', user);
        return returnOperationStatus(412, 'wrong activation code');
      }
      user.email = user.new_email;
      user.new_email = '';
      user.activation_code = '';
      const serviceCall = {
        request: {
          items: [user]
        }
      };
      const updateStatus = await super.update(serviceCall, context);
      if (updateStatus?.items[0]?.status?.message === 'success') {
        logger.info('Email address changed for user', user.id);
        await this.topics['user.resource'].emit('emailChangeConfirmed', user);
      }
      return { operation_status: updateStatus?.items[0]?.status };
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
      return returnOperationStatus(400, 'No items were provided for update');
    }
    let items = call.request.items;
    let subject = call.request.subject;
    // update meta data for owner information
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.MODIFY,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (this.cfg.get('authorization:enabled')) {
        try {
          const roleAssocsModified = await this.roleAssocsModified(items, context);
          if (roleAssocsModified) {
            await this.verifyUserRoleAssociations(items, subject);
          }
        } catch (err) {
          const errMessage = err.details ? err.details : err.message;
          // for unhandled promise rejection
          return returnOperationStatus(400, errMessage);
        }
      }
      // each item includes payload and status in turn
      let updateWithStatus = { items: [], operation_status: {} };
      for (let i = 0; i < items.length; i += 1) {
        // read the user from DB and update the special fields from DB
        // for user modification
        const user = items[i];
        if (!user.id) {
          // return returnStatus(400, 'Subject identifier missing for update operation');
          updateWithStatus.items.push(returnStatus(400, 'Subject identifier missing for update operation'));
          items = _.filter(items, (item) => item.id);
          continue;
        }
        const filters = [{
          filter: [{
            field: 'id',
            operation: FilterOperation.eq,
            value: user.id
          }]
        }];
        const users = await super.read({ request: { filters } }, context);
        if (users.total_count === 0) {
          // return returnStatus(404, 'user not found');
          updateWithStatus.items.push(returnStatus(404, 'user not found for update', user.id));
          items = _.filter(items, (item) => item.id !== user.id);
          continue;
        }
        let dbUser = users.items[0].payload;
        if (dbUser.name != user.name) {
          // return returnStatus(400, 'User name field cannot be updated');
          updateWithStatus.items.push(returnStatus(400, 'User name field cannot be updated', user.id));
          call.request.items = _.filter(items, (item) => item.name !== user.name);
          continue;
        }
        // update meta information from existing Object in case if its
        // not provided in request
        if (!user.meta) {
          user.meta = dbUser.meta;
        } else if (user.meta && _.isEmpty(user.meta.owner)) {
          user.meta.owner = dbUser.meta.owner;
        }
        // check for ACS if owner information is changed
        if (!_.isEqual(user.meta.owner, dbUser.meta.owner)) {
          let acsResponse: AccessResponse;
          try {
            acsResponse = await checkAccessRequest(subject, [user], AuthZAction.MODIFY,
              'user', this, undefined, false);
          } catch (err) {
            this.logger.error('Error occurred requesting access-control-srv:', err);
            // return returnStatus(err.code, err.message);
            updateWithStatus.items.push(returnStatus(err.code, err.message, user.id));
            items = _.filter(items, (item) => item.id !== user.id);
            continue;
          }
          if (acsResponse.decision != Decision.PERMIT) {
            // return returnStatus(acsResponse.response.status.code, acsResponse.response.status.message);
            updateWithStatus.items.push(returnStatus(acsResponse.operation_status.code, acsResponse.operation_status.message, user.id));
            items = _.filter(items, (item) => item.id !== user.id);
            continue;
          }
        }

        // Flush findByToken redis data
        if (user && user.tokens && user.tokens.length > 0) {
          for (let token of user.tokens) {
            const tokenValue = token.token;
            await new Promise((resolve, reject) => {
              this.tokenRedisClient.get(tokenValue, async (err, response) => {
                if (!err && response) {
                  const redisResp = JSON.parse(response);
                  const redisRoleAssocs = redisResp.role_associations;
                  const redisTokens = redisResp.tokens;
                  const redisID = redisResp.id;
                  let roleAssocEqual;
                  let tokensEqual;
                  let updatedRoleAssocs = user.role_associations;
                  let updatedTokens = user.tokens;
                  if (redisID === user.id) {
                    for (let userRoleAssoc of updatedRoleAssocs) {
                      let found = false;
                      for (let redisRoleAssoc of redisRoleAssocs) {
                        if (redisRoleAssoc.role === userRoleAssoc.role) {
                          let i = 0;
                          const attrLenght = userRoleAssoc.attributes.length;
                          for (let redisAttribute of redisRoleAssoc.attributes) {
                            for (let userAttribute of userRoleAssoc.attributes) {
                              if (userAttribute.id === redisAttribute.id && userAttribute.value === redisAttribute.value) {
                                i++;
                              }
                            }
                          }
                          if (attrLenght === i) {
                            found = true;
                            roleAssocEqual = true;
                            break;
                          }
                        }
                      }
                      if (!found) {
                        this.logger.debug('Subject Role assocation has been updated', { userRoleAssoc });
                        roleAssocEqual = false;
                        break;
                      }
                    }
                  }
                  if (redisID === user.id) {
                    for (let token of updatedTokens) {
                      // compare only token scopes (since it now contains last_login as well)
                      for (let redisToken of redisTokens) {
                        if (redisToken.token === token.token) {
                          if (!redisToken.scopes) {
                            redisToken.scopes = [];
                          }
                          if (!token.scopes) {
                            token.scopes = [];
                          }
                          tokensEqual = _.isEqual(redisToken.scopes.sort(), token.scopes.sort());
                        }
                      }
                      if (!tokensEqual) {
                        this.logger.debug('Subject Token scope has been updated', token);
                        break;
                      }
                    }
                  }
                  if (!roleAssocEqual || !tokensEqual || (updatedRoleAssocs.length != redisRoleAssocs.length)) {
                    // flush token subject cache
                    this.tokenRedisClient.del(tokenValue, async (err, numberOfDeletedKeys) => {
                      if (err) {
                        this.logger.error('Error deleting cached findByTOken data from redis', { err });
                        reject(err);
                      } else {
                        this.logger.info('Redis cached data for findByToken deleted successfully', { token: tokenValue });
                      }
                      resolve(numberOfDeletedKeys);
                    });
                  }
                  return resolve(redisResp);
                }
                resolve(undefined);
              });
            });
          }
        }

        // Update password if it contains that field by updating hash
        if (user.password) {
          user.password_hash = password.hash(user.password);
          delete user.password;
        } else {
          // set the existing hash password field
          user.password_hash = dbUser.password_hash;
        }

        // self kill token
        const dbUserTokens = user.tokens;
        if (dbUserTokens && dbUserTokens.length > 0) {
          for (let dbToken of dbUserTokens) {
            let tokenExists = _.find(user.tokens, { token: dbToken.token });
            if (!tokenExists) {
              await this.tokenService.destroy({
                request: {
                  id: dbToken.token, subject: {
                    id: dbToken.id, token: dbToken.token
                  }
                }
              });
            }
          }
        }
      }
      let updateStatus = await super.update(call, context);
      const updateStatusObj = _.merge(updateWithStatus, updateStatus);
      return updateStatusObj;
    }
  }

  private async roleAssocsModified(usersList: User[], context?: any) {
    this.logger.debug('Checking for changes in role-associations');
    let roleAssocsModified = false;
    for (let user of usersList) {
      const userID = user.id;
      const filters = [{
        filter: [{
          field: 'id',
          operation: FilterOperation.eq,
          value: user.id
        }]
      }];
      const userRoleAssocs = user.role_associations;
      const users = await super.read({ request: { filters } }, context);
      if (users && users.items && users.items.length > 0) {
        let dbRoleAssocs = users.items[0].payload.role_associations;
        if (userRoleAssocs.length != dbRoleAssocs.length) {
          roleAssocsModified = true;
          this.logger.debug('Role associations length are not equal', { id: userID });
          break;
        } else {
          // compare each role and its association
          for (let userRoleAssoc of userRoleAssocs) {
            let found = false;
            for (let dbRoleAssoc of dbRoleAssocs) {
              if (dbRoleAssoc.role === userRoleAssoc.role) {
                let i = 0;
                let attrLength;
                if (userRoleAssoc.attributes) {
                  attrLength = userRoleAssoc.attributes.length;
                } else {
                  attrLength = 0;
                }
                if (dbRoleAssoc.attributes && dbRoleAssoc.attributes.length > 0) {
                  for (let dbAttribute of dbRoleAssoc.attributes) {
                    for (let userAttribute of userRoleAssoc.attributes) {
                      if (userAttribute.id === dbAttribute.id && userAttribute.value === dbAttribute.value) {
                        i++;
                      }
                    }
                  }
                }
                if (attrLength === i) {
                  found = true;
                  break;
                }
              }
            }
            if (!found) {
              roleAssocsModified = true;
            }
            if (roleAssocsModified) {
              this.logger.debug('Role associations objects are not equal', { id: userID });
              break;
            } else {
              this.logger.debug('Role assocations not changed for user', { id: userID });
            }
          }
        }
      } else {
        this.logger.debug('User does not exist in DB and hence role associations should be validated');
        roleAssocsModified = true;
        break;
      }
      return roleAssocsModified;
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
      return returnOperationStatus(400, 'No items were provided for upsert');
    }

    const usersList = call.request.items;
    let subject = call.request.subject;
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.MODIFY,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (this.cfg.get('authorization:enabled')) {
        try {
          const roleAssocsModified = await this.roleAssocsModified(usersList, context);
          if (roleAssocsModified) {
            await this.verifyUserRoleAssociations(usersList, subject);
          }
        } catch (err) {
          const errMessage = err.details ? err.details : err.message;
          // for unhandled promise rejection
          return returnOperationStatus(400, errMessage);
        }
      }
      let result = [];
      const items = call.request.items;
      for (let i = 0; i < items.length; i += 1) {
        // read the user from DB and update the special fields from DB
        // for user modification
        const user = items[i];
        let filters;
        if (this.uniqueEmailConstraint) {

          filters = [{
            filter: [{
              field: 'name',
              operation: FilterOperation.eq,
              value: user.name
            },
            {
              field: 'email',
              operation: FilterOperation.eq,
              value: user.email
            }],
            operator: OperatorType.or
          }];
        } else {
          filters = getNameFilter(user.name);
        }

        const users = await super.read({ request: { filters } }, context);
        if (users.total_count === 0) {
          // call the create method, checks all conditions before inserting
          result.push(await this.createUser(user));
        } else if (users.total_count === 1) {
          let updateResponse = await this.update({ request: { items: [user], subject } });
          result.push(updateResponse.items[0]);
        } else if (users.total_count > 1) {
          return returnOperationStatus(400, `Invalid identifier provided user upsert, multiple users found for identifier ${user.name}`);
        }
      }
      const operation_status = { code: 200, message: 'success' };
      return { items: result, operation_status };
    }
  }

  /**
   * Endpoint verifyPassword, checks if the provided password and user matches
   * the one found in the database.
   * @param  {Call} call request containing user details
   * @param {any} context
   * @return {User} returns user details
   */
  async login(call: any, context?: any): Promise<UserPayload> {
    if (_.isEmpty(call) || _.isEmpty(call.request) ||
      (_.isEmpty(call.request.identifier) || (_.isEmpty(call.request.password) &&
        _.isEmpty(call.request.token)))) {
      return returnStatus(400, 'Missing credentials');
    }
    const identifier = call.request.identifier;
    const obfuscateAuthNErrorReason = this.cfg.get('obfuscateAuthNErrorReason') ?
      this.cfg.get('obfuscateAuthNErrorReason') : false;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);

    const users = await super.read({ request: { filters } }, context);
    if (users.total_count === 0) {
      if (obfuscateAuthNErrorReason) {
        return returnStatus(412, 'Invalid credentials provided, user inactive or account does not exist');
      } else {
        return returnStatus(404, 'user not found');
      }
    } else if (users.total_count > 1) {
      return returnStatus(400, `Invalid identifier provided for login, multiple users found for identifier ${identifier}`);
    }
    const user: User = users.items[0].payload;
    if (!user.active) {
      if (obfuscateAuthNErrorReason) {
        return returnStatus(412, 'Invalid credentials provided, user inactive or account does not exist', user.id);
      } else {
        return returnStatus(412, 'user is inactive', user.id);
      }
    }

    if (user.user_type && user.user_type === TECHNICAL_USER) {
      const tokens = user.tokens;
      for (let eachToken of tokens) {
        if (call.request.token === eachToken.token) {
          return { payload: user, status: { code: 200, message: 'success' } };
        }
      }
      if (obfuscateAuthNErrorReason) {
        return returnStatus(412, 'Invalid credentials provided, user inactive or account does not exist', user.id);
      } else {
        return returnStatus(401, 'password does not match', user.id);
      }
    } else if (!user.user_type || user.user_type != TECHNICAL_USER) {
      const match = password.verify(user.password_hash, call.request.password);
      if (!match) {
        if (obfuscateAuthNErrorReason) {
          return returnStatus(412, 'Invalid credentials provided, user inactive or account does not exist', user.id);
        } else {
          return returnStatus(401, 'password does not match', user.id);
        }
      }
      return { payload: user, status: { code: 200, message: 'success' } };
    } else {
      return returnStatus(404, 'user not found');
    }
  }

  /**
   * Endpoint unregister, delete a user
   * belonging to the user.
   * @param  {Call<UnregisterRequest>} call request containing list of userIds
   * @param {any} context
   * @return {} returns empty response
   */
  async unregister(call: Call<UnregisterRequest>, context?: any): Promise<any> {
    const request = call.request;
    const logger = this.logger;
    const identifier = request.identifier;
    logger.silly('unregister', identifier);
    let subject = call.request.subject;

    const filters = getDefaultFilter(identifier);
    const users = await super.read({ request: { filters } }, context);

    if (users && users.total_count === 0) {
      logger.debug('user does not exist', { identifier });
      return returnOperationStatus(404, `user with identifier ${identifier} does not exist for unregistering`);
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for unregistering, multiple users found for identifier ${identifier}`);
    }

    const acsResources = await this.createMetadata(users.items, AuthZAction.DELETE, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.DELETE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      // delete user
      let userID = users.items[0].payload.id;
      const serviceCall = {
        request: {
          ids: [userID]
        }
      };
      const unregisterStatus = await super.delete(serviceCall, context);
      if (unregisterStatus?.status[0]?.message === 'success') {
        logger.info('user with identifier deleted', { identifier });
        await this.topics['user.resource'].emit('unregistered', userID);
      }
      return { operation_status: unregisterStatus?.status[0] };
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
    let resources = [];
    let acsResources = [];
    let subject = call.request.subject;
    let action;
    if (userIDs) {
      action = AuthZAction.DELETE;
      if (_.isArray(userIDs)) {
        for (let id of userIDs) {
          resources.push({ id });
        }
      } else {
        resources = [{ id: userIDs }];
      }
      Object.assign(resources, { id: userIDs });
      acsResources = await this.createMetadata(resources, action, subject);
    }
    if (call.request.collection) {
      action = AuthZAction.DROP;
      acsResources = [{ collection: call.request.collection }];
    }
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, action,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const serviceCall = {
          request: {
            collection: request.collection
          }
        };
        const deleteResponse = await super.delete(serviceCall, context);
        logger.info('Users collection deleted');
        return deleteResponse;
      }
      if (!_.isArray(userIDs)) {
        userIDs = [userIDs];
      }
      logger.silly('Deleting User IDs', { userIDs });

      // delete users
      const serviceCall = {
        request: {
          ids: userIDs
        }
      };
      const deleteStatusArr = await super.delete(serviceCall, context);
      logger.info('Users deleted:', userIDs);
      return deleteStatusArr;
    }
  }

  async deleteUsersByOrg(call: any, context?: any): Promise<any> {
    const orgIDs = call.request.org_ids;
    let subject = call.request.subject;
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id: orgIDs }, AuthZAction.DELETE,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const deletedUserIDs = await this.modifyUsers(orgIDs, false, context, subject);
      const operation_status = returnCodeMessage(200, 'success');
      return { user_ids: deletedUserIDs.map((user) => { return user.id; }), operation_status };
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
      return returnStatus(400, 'missing role name');
    }

    const reqAttributes: any[] = call.attributes || call.request.attributes || [];
    const findByRoleRequest = { role, filters: {} };
    let subject = call.request.subject;
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, findByRoleRequest, AuthZAction.READ,
        'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const filters = [{
        filter: [{
          field: 'name',
          operation: FilterOperation.eq,
          value: role
        }]
      }];
      const result = await this.roleService.read({
        request: {
          filters,
          field: [{
            name: 'id',
            include: true
          }],
          subject
        }
      });

      if (_.isEmpty(result) || _.isEmpty(result.items) || result.items.total_count == 0) {
        return returnOperationStatus(404, `Role ${role} does not exist`);
      }

      const roleObj = result.items[0].payload;
      const id = roleObj.id;

      // note: inefficient, a custom AQL query should be the final solution
      let roleRequestFiltersWithACS: any = findByRoleRequest.filters;
      const userResult = await super.read({
        request: { filters: roleRequestFiltersWithACS }
      }, {});
      if (_.isEmpty(userResult) || _.isEmpty(userResult.items) || userResult.items.total_count == 0) {
        return returnOperationStatus(404, 'No users were found in the system');
      }

      const users = userResult.items;

      let usersWithRole: any = { items: [], operation_status: {} };

      for (let user of users) {
        let found = false;
        if (user && user.payload && user.payload.role_associations) {
          for (let roleAssoc of user.payload.role_associations) {
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
                usersWithRole.items.push(user);
                break;
              }
            }
          }
        }
      }
      usersWithRole.operation_status.code = 200;
      usersWithRole.operation_status.message = 'success';
      return usersWithRole;
    }
  }

  private setAuthenticationHeaders(token) {
    return {
      Authorization: `Bearer ${token}`
    };
  }

  // Initializes useful data for rendering requests
  // before sending emails (user registration / change).
  async fetchHbsTemplates(): Promise<any> {
    const hbsTemplates = this.cfg.get('service:hbs_templates');
    const enableEmail = this.cfg.get('service:enableEmail');

    if (!_.isEmpty(hbsTemplates) && enableEmail) {
      let response: any;
      try {
        const techUsersCfg = this.cfg.get('techUsers');
        let headers;
        if (techUsersCfg && techUsersCfg.length > 0) {
          const hbsUser = _.find(techUsersCfg, { id: 'hbs_user' });
          if (hbsUser) {
            headers = this.setAuthenticationHeaders(hbsUser.token);
          }
        }

        response = await fetch(hbsTemplates.registrationSubjectTpl, { headers });
        this.registrationSubjectTpl = await response.text();

        response = await fetch(hbsTemplates.registrationBodyTpl, { headers });
        this.registrationBodyTpl = await response.text();

        response = await fetch(hbsTemplates.changePWEmailSubjectTpl, { headers });
        this.changePWEmailSubjectTpl = await response.text();

        response = await fetch(hbsTemplates.changePWEmailBodyTpl, { headers });
        this.changePWEmailBodyTpl = await response.text();

        response = await fetch(hbsTemplates.invitationSubjectTpl, { headers });
        this.invitationSubjectTpl = await response.text();

        response = await fetch(hbsTemplates.invitationBodyTpl, { headers });
        this.invitationBodyTpl = await response.text();

        response = await fetch(hbsTemplates.layoutTpl, { headers });
        this.layoutTpl = await response.text();

        response = await fetch(hbsTemplates.resourcesTpl, { headers });
        if (response.status == 200) {
          const externalRrc = JSON.parse(await response.text());
          this.emailStyle = externalRrc.styleURL;
        }

        this.emailEnabled = true;
      } catch (err) {
        this.emailEnabled = false;
        if (err.code == 'ECONNREFUSED' || err.message == 'ECONNREFUSED') {
          this.logger.error('An error occurred while attempting to load email templates from'
            + ' remote server. Email operations will be disabled.');
        } else {
          this.logger.error('Unexpected error occurred while loading email templates', err.message);
        }
      }
    } else {
      this.logger.info('Email sending is disabled');
    }
  }

  private makeActivationEmailData(user: User): any {
    let activationURL: string = this.cfg.get('service:activationURL');
    activationURL = `${activationURL}?identifier=${user.name}&activation_code=${user.activation_code}`;

    const dataBody = {
      firstName: user.first_name,
      lastName: user.last_name,
      activationURL
    };
    // since there are no place holders in subject
    const dataSubject = { userName: user.name };

    const emailBody = this.registrationBodyTpl;
    const emailSubject = this.registrationSubjectTpl;
    return this.makeRenderRequestMsg(user, emailSubject, emailBody,
      dataBody, dataSubject);
  }

  private makeInvitationEmailData(user: User): any {
    let invitationURL: string = this.cfg.get('service:invitationURL');
    invitationURL = `${invitationURL}?identifier=${user.name}&activation_code=${user.activation_code}`;

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

  private makeConfirmationData(user: User, passwordChange: boolean, identifier: string, email?: string): any {
    const emailBody = this.changePWEmailBodyTpl;
    const emailSubject = this.changePWEmailSubjectTpl;

    let URL: string = passwordChange ? this.cfg.get('service:passwordChangeConfirmationURL')
      : this.cfg.get('service:emailConfirmationURL'); // prefix
    URL = `${URL}?identifier=${identifier}&activation_code=${user.activation_code}`; // actual email

    const dataBody = {
      firstName: user.first_name,
      lastName: user.last_name,
      confirmationURL: URL,
      passwordChange
    };
    const dataSubject = { passwordChange };
    return this.makeRenderRequestMsg(user, emailSubject, emailBody,
      dataBody, dataSubject, email);
  }

  private makeRenderRequestMsg(user: User, subject: any, body: any,
    dataBody: any, dataSubject: any, email?: string): any {
    let userEmail = email ? email : user.email;

    // add optional data if it is provided in the configuration
    // in the field "data"
    const data = this.cfg.get('service:data');
    if (data && !_.isEmpty(data)) {
      dataBody.data = data;
      dataSubject.data = data;
    }
    return {
      id: `identity#${userEmail}`,
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
        const user: User = _.cloneDeep(users[i].payload);
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
    const filters = [{
      filter: [{
        field: 'name',
        operation: FilterOperation.eq,
        value: roleName
      }]
    }];
    const role: any = await this.roleService.read({ request: { filters, subject } }, context);
    if (role) {
      roleID = role.items[0].payload.id;
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

  /**
   * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
   */
  async createMetadata(res: any, action: string, subject?: Subject): Promise<any> {
    let resources = _.cloneDeep(res);
    let orgOwnerAttributes = [];
    if (resources && !_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    if (subject && subject.scope && (action === AuthZAction.CREATE || action === AuthZAction.MODIFY)) {
      // add user and subject scope as default owner
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization
        },
        {
          id: urns.ownerInstance,
          value: subject.scope
        });
    }

    if (resources) {
      for (let resource of resources) {
        if (!resource.meta) {
          resource.meta = {};
        }
        if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
          const filters = [{
            filter: [{
              field: 'id',
              operation: FilterOperation.eq,
              value: resource.id
            }]
          }];
          let result = await super.read({ request: { filters } });
          // update owner info
          if (result.items.length === 1) {
            let item = result.items[0].payload;
            resource.meta.owner = item.meta.owner;
          } else if (result.items.length === 0 && !resource.meta.owner) {
            let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user
              },
              {
                id: urns.ownerInstance,
                value: resource.id
              });
            resource.meta.owner = ownerAttributes;
          }
        } else if (action === AuthZAction.CREATE && !resource.meta.owner) {
          let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          ownerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user
            },
            {
              id: urns.ownerInstance,
              value: resource.id
            });
          resource.meta.owner = ownerAttributes;
        }
      }
    }
    return resources;
  }

  private async makeUserForInvitationData(user, invited_by_user_identifier): Promise<any> {
    let invitedByUser;
    const filters = [{
      filter: [
        {
          field: 'name',
          operation: FilterOperation.eq,
          value: invited_by_user_identifier
        },
        {
          field: 'email',
          operation: FilterOperation.eq,
          value: invited_by_user_identifier
        }
      ],
      operator: OperatorType.or
    }];
    const invitedByUsers = await super.read({ request: { filters } });
    if (invitedByUsers.total_count === 1) {
      invitedByUser = invitedByUsers.items[0];
    } else {
      return returnOperationStatus(404, `user with identifier ${invited_by_user_identifier} not found`);
    }

    return {
      name: user.name,
      email: user.email,
      last_name: user.last_name,
      first_name: user.first_name,
      activation_code: user.activation_code,
      invited_by_user_name: invitedByUser.name,
      invited_by_user_first_name: invitedByUser.first_name,
      invited_by_user_last_name: invitedByUser.last_name
    };
  }

  async sendActivationEmail(call: Call<SendActivationEmailRequest>, context?: any): Promise<any> {
    const { identifier, subject } = call.request;
    let user;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read({ request: { filters } });
    if (users.total_count === 1) {
      user = users.items[0].payload;
      if (user.active) {
        return returnOperationStatus(412, `activation request to an active user ${identifier}`);
      }
      if (this.emailEnabled && !user.guest) {
        await this.fetchHbsTemplates();
        const renderRequest = this.makeActivationEmailData(user);
        await this.topics.rendering.emit('renderRequest', renderRequest);
      }
      return returnOperationStatus(200, 'success');
    } else if (users.total_count === 0) {
      return returnOperationStatus(404, `user with identifier ${identifier} not found`);
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for send activation email, multiple users found for identifier ${identifier}`);
    }
  }

  async sendInvitationEmail(call: Call<SendInvitationEmailRequest>, context?: any): Promise<any> {
    const { identifier, invited_by_user_identifier, subject } = call.request;
    let user;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read({ request: { filters } });
    if (users.total_count === 1) {
      user = users.items[0].payload;
    } else if (users.total_count === 0) {
      return returnOperationStatus(404, `user with identifier ${identifier} not found`);
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for send invitation email, multiple users found for identifier ${identifier}`);
    }

    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, { id: user.id, identifier, invited_by_user_identifier, meta: user.meta },
        AuthZAction.MODIFY, 'user', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (this.emailEnabled && user.invite) {
        const userForInvitation = await this.makeUserForInvitationData(user, invited_by_user_identifier);
        // error
        if (userForInvitation && userForInvitation.operation_status && userForInvitation.operation_status.code) {
          return userForInvitation;
        }
        await this.fetchHbsTemplates();
        const renderRequest = this.makeInvitationEmailData(userForInvitation);
        await this.topics.rendering.emit('renderRequest', renderRequest);
      } else {
        this.logger.info('User invite not enabled for identifier', { identifier });
      }
      return returnOperationStatus(200, 'success');
    }
  }
}

export class RoleService extends ServiceBase {
  logger: Logger;
  redisClient: Redis;
  cfg: any;
  authZ: ACSAuthZ;
  authZCheck: boolean;
  constructor(cfg: any, db: any, roleTopic: kafkaClient.Topic, logger: any,
    isEventsEnabled: boolean, authZ: ACSAuthZ) {
    super('role', roleTopic, logger, new ResourcesAPIBase(db, 'roles'), isEventsEnabled);
    this.logger = logger;
    const redisConfig = cfg.get('redis');
    redisConfig.db = cfg.get('redis:db-indexes:db-subject');
    this.redisClient = new Redis(redisConfig);
    this.authZ = authZ;
    this.cfg = cfg;
    this.authZCheck = this.cfg.get('authorization:enabled');
  }

  async stop(): Promise<void> {
    await this.redisClient.quit();
  }

  async create(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.items || call.request.items.length == 0) {
      return returnStatus(400, 'No role was provided for creation');
    }

    const items = call.request.items;
    let subject = call.request.subject;
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.CREATE, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.CREATE,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      let createRoleResponse;
      try {
        createRoleResponse = super.create(call, context);
      } catch (err) {
        return returnStatus(err.code, err.message);
      }
      return createRoleResponse;
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
    let subject = call.request.subject;
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
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
      return returnOperationStatus(400, 'No items were provided for update');
    }

    const items = call.request.items;
    let subject = call.request.subject;
    // update owner information
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.MODIFY,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      for (let i = 0; i < items.length; i += 1) {
        // read the role from DB and check if it exists
        const role = items[i];
        const filters = [{
          filter: [{
            field: 'id',
            operation: FilterOperation.eq,
            value: role.id
          }]
        }];
        const roles = await super.read({ request: { filters } }, context);
        if (roles.total_count === 0) {
          return roles;
        }
        const rolesDB = roles.items[0].payload;
        // update meta information from existing Object in case if its
        // not provided in request
        if (!role.meta) {
          role.meta = rolesDB.meta;
        } else if (role.meta && _.isEmpty(role.meta.owner)) {
          role.meta.owner = rolesDB.meta.owner;
        }
        // check for ACS if owner information is changed
        if (!_.isEqual(role.meta.owner, rolesDB.meta.owner)) {
          let acsResponse: DecisionResponse;
          try {
            acsResponse = await checkAccessRequest(subject, [role], AuthZAction.MODIFY,
              'role', this, undefined, false);
          } catch (err) {
            this.logger.error('Error occurred requesting access-control-srv:', err);
            return returnOperationStatus(err.code, err.message);
          }
          if (acsResponse.decision != Decision.PERMIT) {
            return { operation_status: acsResponse.operation_status };
          }
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
      return returnOperationStatus(400, 'No items were provided for upsert');
    }

    let subject = call.request.subject;
    const acsResources = await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, acsResources, AuthZAction.MODIFY,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
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
    let resources = {};
    let subject = call.request.subject;
    let acsResources;
    if (roleIDs) {
      Object.assign(resources, { id: roleIDs });
      acsResources = await this.createMetadata({ id: roleIDs }, AuthZAction.DELETE, subject);
    }
    if (call.request.collection) {
      acsResources = [{ collection: call.request.collection }];
    }
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, AuthZAction.DELETE,
        'role', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const serviceCall = {
          request: {
            collection: request.collection
          }
        };
        const deleteResponse = await super.delete(serviceCall, context);
        logger.info('Role collection deleted:');
        return deleteResponse;
      }
      if (!_.isArray(roleIDs)) {
        roleIDs = [roleIDs];
      }
      logger.silly('deleting Role IDs:', { roleIDs });
      // delete users
      const serviceCall = {
        request: {
          ids: roleIDs
        }
      };
      const deleteResponse = await super.delete(serviceCall, context);
      logger.info('Roles deleted:', { roleIDs });
      return deleteResponse;
    }
  }

  async verifyRoles(roleAssociations: RoleAssociation[]): Promise<boolean> {
    // checking if user roles are valid
    for (let roleAssociation of roleAssociations) {
      const roleID = roleAssociation.role;
      const filters = [{
        filter: [{
          field: 'id',
          operation: FilterOperation.eq,
          value: roleID
        }]
      }];
      const result = await super.read({
        request: {
          filters
        }
      }, {});

      if (!result || !result.items || result.total_count == 0) {
        return false;
      }
    }

    return true;
  }

  /**
   * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
   */
  async createMetadata(res: any, action: string, subject?: Subject): Promise<any> {
    let resources = _.cloneDeep(res);
    let orgOwnerAttributes = [];
    if (!_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    if (subject && subject.scope && (action === AuthZAction.CREATE || action === AuthZAction.MODIFY)) {
      // add user and subject scope as default owner
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization
        },
        {
          id: urns.ownerInstance,
          value: subject.scope
        });
    }

    for (let resource of resources) {
      if (!resource.meta) {
        resource.meta = {};
      }
      if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
        const filters = [{
          filter: [{
            field: 'id',
            operation: FilterOperation.eq,
            value: resource.id
          }]
        }];
        let result = await super.read({
          request: {
            filters
          }
        });
        // update owner info
        if (result.items.length === 1) {
          let item = result.items[0].payload;
          resource.meta.owner = item.meta.owner;
        } else if (result.items.length === 0 && !resource.meta.owner) {
          let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          ownerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user
            },
            {
              id: urns.ownerInstance,
              value: resource.id
            });
          resource.meta.owner = ownerAttributes;
        }
      } else if (action === AuthZAction.CREATE && !resource.meta.owner) {
        let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
        ownerAttributes.push(
          {
            id: urns.ownerIndicatoryEntity,
            value: urns.user
          },
          {
            id: urns.ownerInstance,
            value: resource.id
          });
        resource.meta.owner = ownerAttributes;
      }
    }
    return resources;
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
