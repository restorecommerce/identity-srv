import * as _ from 'lodash';
import * as uuid from 'uuid';
import * as kafkaClient from '@restorecommerce/kafka-client';
import {
  checkAccessRequest,
  fetch,
  getACSFilters,
  getDefaultFilter,
  getLoginIdentifierFilter,
  getNameFilter,
  marshallProtobufAny,
  password,
  returnCodeMessage,
  returnOperationStatus,
  returnStatus,
  unmarshallProtobufAny
} from './utils';
import { ResourcesAPIBase, ServiceBase, FilterValueType } from '@restorecommerce/resource-base-interface';
import { Logger } from 'winston';
import {
  ACSAuthZ,
  AuthZAction,
  DecisionResponse,
  HierarchicalScope,
  Operation,
  PolicySetRQResponse,
  ResolvedSubject,
  updateConfig
} from '@restorecommerce/acs-client';
import { createClient, RedisClientType } from 'redis';
import { query } from '@restorecommerce/chassis-srv/lib/database/provider/arango/common';
import { validateAllChar, validateEmail, validateFirstChar, validateStrLen, validateSymbolRepeat } from './validation';
import { TokenService } from './token_service';
import { Arango } from '@restorecommerce/chassis-srv/lib/database/provider/arango/base';
import {
  ActivateRequest,
  ChangeEmailRequest,
  ChangePasswordRequest,
  ConfirmEmailChangeRequest,
  ConfirmPasswordChangeRequest,
  ConfirmUserInvitationRequest,
  DeepPartial,
  DeleteUsersByOrgResponse,
  FindByRoleRequest,
  FindByTokenRequest,
  FindRequest,
  LoginRequest,
  OrgIDRequest,
  RegisterRequest,
  RequestPasswordChangeRequest,
  SendActivationEmailRequest,
  SendInvitationEmailRequest,
  UserServiceImplementation,
  UnregisterRequest,
  User,
  UserList,
  UserListResponse,
  UserListWithRoleResponse,
  UserResponse,
  UserType
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import {
  RoleList,
  RoleListResponse,
  RoleServiceImplementation
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/role';
import {
  DeleteRequest,
  DeleteResponse,
  Filter_Operation,
  FilterOp_Operator,
  ReadRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';
import { OperationStatusObj } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/status';
import { Meta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/meta';
import { Attribute } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/attribute';
import { Effect } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/rule';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';
import {
  RoleAssociation,
  Subject
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth';
import { zxcvbnOptions, zxcvbnAsync, ZxcvbnResult } from '@zxcvbn-ts/core';
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common';
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en';
import * as zxcvbnDePackage from '@zxcvbn-ts/language-de';
import { matcherPwnedFactory } from '@zxcvbn-ts/matcher-pwned';
import {
  MatchEstimated,
  MatchExtended,
  Matcher,
  Match,
} from '@zxcvbn-ts/core/dist/types';

export const DELETE_USERS_WITH_EXPIRED_ACTIVATION = 'delete-users-with-expired-activation-job';

export class UserService extends ServiceBase<UserListResponse, UserList> implements UserServiceImplementation {

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
  redisClient: RedisClientType<any, any>;
  authZCheck: boolean;
  tokenService: TokenService;
  tokenRedisClient: RedisClientType<any, any>;
  uniqueEmailConstraint: boolean;

  constructor(cfg: any, topics: any, db: any, logger: Logger,
    isEventsEnabled: boolean, roleService: RoleService, authZ: ACSAuthZ) {
    let resourceFieldConfig;
    if (cfg.get('fieldHandlers')) {
      resourceFieldConfig = cfg.get('fieldHandlers');
      resourceFieldConfig['bufferFields'] = resourceFieldConfig?.bufferFields?.users;
      if (cfg.get('fieldHandlers:timeStampFields')) {
        resourceFieldConfig['timeStampFields'] = [];
        for (let timeStampFiledConfig of cfg.get('fieldHandlers:timeStampFields')) {
          if (timeStampFiledConfig.entities.includes('users')) {
            resourceFieldConfig['timeStampFields'].push(...timeStampFiledConfig.fields);
          }
        }
      }
    }
    super('user', topics['user.resource'], logger, new ResourcesAPIBase(db, 'users', resourceFieldConfig),
      isEventsEnabled);
    this.cfg = cfg;
    this.db = db;
    this.topics = topics;
    this.logger = logger;
    this.roleService = roleService;
    this.authZ = authZ;
    const redisConfig = cfg.get('redis');
    redisConfig.database = cfg.get('redis:db-indexes:db-subject');
    this.redisClient = createClient(redisConfig);
    this.redisClient.on('error', (err) => logger.error('Redis client error in subject store', err));
    this.redisClient.connect().then((val) =>
      logger.info('Redis client connection successful for subject store')).catch(err => logger.error('Redis connection error', err));
    this.authZCheck = this.cfg.get('authorization:enabled');
    redisConfig.database = this.cfg.get('redis:db-indexes:db-findByToken') || 0;
    this.tokenRedisClient = createClient(redisConfig);
    this.tokenRedisClient.on('error', (err) => logger.error('Redis client error in token cache store', err));
    this.tokenRedisClient.connect().then((val) =>
      logger.info('Redis client connection successful for token cache store')).catch(err => logger.error('Redis connection error', err));
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
   */
  async find(request: FindRequest, context): Promise<DeepPartial<UserListResponse>> {
    let { id, name, email, subject } = request;
    let acsResponse: PolicySetRQResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = [];
      acsResponse = await checkAccessRequest(context, [{ resource: 'user' }],
        AuthZAction.READ, Operation.whatIsAllowed) as PolicySetRQResponse;
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for find', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (acsResponse.decision === Response_Decision.PERMIT) {
      const logger = this.logger;
      const filterStructure: any = {
        filters: [{
          filters: []
        }]
      };
      if (id) {
        // Object.assign(filterStructure, { id: { $eq: id } });
        filterStructure.filters[0].filters.push({
          field: 'id',
          operation: Filter_Operation.eq,
          value: id
        });
      }
      if (name) {
        // Object.assign(filterStructure, { name: { $eq: name } });
        filterStructure.filters[0].filters.push({
          field: 'name',
          operation: Filter_Operation.eq,
          value: name
        });
      }
      if (email) {
        // Object.assign(filterStructure, { email: { $eq: email } });
        filterStructure.filters[0].filters.push({
          field: 'email',
          operation: Filter_Operation.eq,
          value: email
        });
      }
      if (filterStructure?.filters[0]?.filters?.length > 1) {
        filterStructure.filters[0].operator = FilterOp_Operator.or;
      }

      // add ACS filters if subject is not tech user
      let acsFilterObj, techUser;
      const techUsersCfg = this.cfg.get('techUsers');
      if (techUsersCfg?.length > 0) {
        techUser = _.find(techUsersCfg, { id: subject.id });
      }
      let filters = getACSFilters(acsResponse, 'user');
      if (!techUser && filters) {
        acsFilterObj = filters;
      }

      if (acsFilterObj) {
        if (_.isArray(acsFilterObj)) {
          for (let acsFilter of acsFilterObj) {
            filterStructure.filters.push(acsFilter);
          }
        } else {
          filterStructure.filters.push(acsFilterObj);
        }
      }
      const readRequest = ReadRequest.fromPartial({});
      readRequest.filters = filterStructure?.filters;
      if (acsResponse?.custom_query_args?.length > 0) {
        readRequest.custom_queries = acsResponse?.custom_query_args[0]?.custom_queries;
        readRequest.custom_arguments = acsResponse?.custom_query_args[0]?.custom_arguments;
      }
      const users = await super.read(readRequest, context);
      if (users.total_count > 0) {
        logger.silly('found user(s)', { users });
        return users;
      }
      logger.silly('user(s) could not be found for request', request);
      return returnOperationStatus(404, 'user not found');
    }
  }

  /**
  * update's the last login time for provided token
  * @param id subject id
  * @param token token value for which the last login should be updated
  */
  async updateTokenLastLogin(id: string, token: string) {
    // update last_login
    const aql_last_login = `FOR u IN users
    FILTER u.id == @docID
     UPDATE u WITH { 
      tokens: (
          FOR tokenObj in u.tokens
            RETURN tokenObj.token == @token
              ? MERGE( tokenObj, {last_login: @last_login })
              : tokenObj
      )
    } IN users`;
    const bindVars_last_login = Object.assign({
      docID: id,
      token,
      last_login: new Date().getTime()
    });
    const res_last_login = await query(this.db.db, 'users', aql_last_login, bindVars_last_login);
    return await res_last_login.all();
  }

  async updateUserTokens(id, token, expiredTokens?: any) {
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
      // check for expired tokens if they exist and remove them
      if (expiredTokens?.length > 0) {
        const token_remove = `FOR doc in users FILTER doc.id == @docID UPDATE doc WITH
          { tokens: REMOVE_VALUES(doc.tokens, @expiredTokens)} IN users return doc`;
        const bindTokenVars = Object.assign({
          docID: id,
          expiredTokens
        });
        const res = await query(this.db.db, 'users', token_remove, bindTokenVars);
        await res.all();
        this.logger.debug('Expired tokens removed successfully');
      }
    }
  }

  async removeToken(id, tokenObj) {
    // Remove token using AQL query
    if (tokenObj) {
      const token_remove = `FOR doc in users FILTER doc.id == @docID UPDATE doc WITH
          { tokens: REMOVE_VALUES(doc.tokens, @tokenObj)} IN users return doc`;
      const bindTokenVars = Object.assign({
        docID: id,
        tokenObj
      });
      const res = await query(this.db.db, 'users', token_remove, bindTokenVars);
      await res.all();
      this.logger.debug('Removed token removed successfully');
    }
  }

  /**
   * Endpoint to search for user by token.
   */
  async findByToken(request: FindByTokenRequest, context): Promise<DeepPartial<UserResponse>> {
    const { token } = request;
    let userData;
    const logger = this.logger;
    if (token) {
      userData = await this.tokenRedisClient.get(token);
      if (userData) {
        // user data
        userData = JSON.parse(userData);
        logger.debug('Found user data in redis cache', { userId: userData?.id });
        if (userData?.meta?.created || userData?.meta?.modified) {
          userData.meta.created = new Date(userData.meta.created);
          userData.meta.modified = new Date(userData.meta.modified);
        }
        // validate token expiry date and delete it if expired
        if (userData?.tokens) {
          const redisToken = _.find(userData.tokens, { token });
          if ((!redisToken.expires_in || redisToken?.expires_in === 0) || (new Date(redisToken?.expires_in).getTime() >= new Date().getTime())) {
            userData?.tokens?.forEach((tokenObj) => tokenObj.expires_in = new Date(tokenObj.expires_in));
            return { payload: userData, status: returnCodeMessage(200, 'success') };
          } else {
            // delete token from redis and update user entity
            let numberOfDeletedKeys = await this.tokenRedisClient.del(token);
            this.logger.info('Redis cached data for findByToken deleted successfully', { noOfKeys: numberOfDeletedKeys });
            return { status: returnCodeMessage(401, 'Redis cached data for findByToken deleted successfully') };
          }
        }
      } else {
        // when not set in redis
        // regex filter search field for token array
        const filters = [{
          filters: [{
            field: 'tokens[*].token',
            operation: Filter_Operation.in,
            value: token
          }]
        }];
        let users = await super.read(ReadRequest.fromPartial({ filters }), context);
        if (users?.total_count === 0) {
          logger.debug('No user found for provided token value', { token });
          return { status: { code: 401, message: 'No user found for provided token value' } };
        }
        if (users?.total_count === 1) {
          logger.debug('found user from token', { users });
          if (users?.items[0]?.payload) {
            // validate token expiry and delete if expired
            const dbToken = _.find(users.items[0].payload.tokens, { token });
            // if expires_in does not exist or if its set to value 0 - token valid without time frame
            if ((!dbToken.expires_in || dbToken?.expires_in === 0) || (dbToken?.expires_in.getTime() >= new Date().getTime())) {
              await this.tokenRedisClient.set(token, JSON.stringify(users.items[0].payload));
              logger.debug('Stored user data to redis cache successfully');
              let user = users.items[0].payload;
              // update token last_login
              await this.updateTokenLastLogin(user.id, token);
              const updatedUser = await super.read(ReadRequest.fromPartial({ filters }), context);
              logger.debug('updated user token last login successfully', { updatedUser });
              const dbUser = updatedUser?.items.length > 0 ? updatedUser.items[0]?.payload : undefined;
              return { payload: dbUser, status: { code: 200, message: 'success' } };
            } else if (dbToken?.expires_in?.getTime() < new Date().getTime()) {
              logger.debug(`Token ${token} expired`);
              return { status: { code: 401, message: `Token ${token} expired` } };
            }
          }
        }
        logger.silly('multiple user found for request', request);
        return { status: { code: 400, message: 'multiple users found for token' } };
      }
    } else {
      return { status: { code: 400, message: 'Token not provided' } };
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
   */
  async read(request: ReadRequest, context): Promise<DeepPartial<UserListWithRoleResponse>> {
    let subject = request.subject;
    let acsResponse: PolicySetRQResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject: request.subject,
        resources: []
      }, [{ resource: 'user' }], AuthZAction.READ, Operation.whatIsAllowed) as PolicySetRQResponse;
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for read', { code: err.code, message: err.message, stack: err.stack });
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    const acsFilters = getACSFilters(acsResponse, 'user');
    const readRequest = ReadRequest.fromPartial({
      offset: request.offset, limit: request.limit,
      sorts: request.sorts, filters: request.filters, fields: request.fields, locales_limiter: request.locales_limiter,
      custom_arguments: request.custom_arguments, custom_queries: request.custom_queries, search: request.search
    });
    if (acsResponse?.filters && acsFilters) {
      if (!readRequest.filters) {
        readRequest.filters = [];
      }
      readRequest.filters.push(...acsFilters);
    }

    if (acsResponse?.custom_query_args?.length > 0) {
      readRequest.custom_queries = acsResponse.custom_query_args[0].custom_queries;
      readRequest.custom_arguments = acsResponse.custom_query_args[0].custom_arguments;
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      let users = await super.read(readRequest, context) as UserListWithRoleResponse;
      let roles = await this.roleService.read(ReadRequest.fromPartial({ subject }), context);
      let rolesList = roles?.items?.map(e => e.payload);
      users?.items?.forEach(userObj => {
        let userRoles = [];
        if (userObj?.payload) {
          userObj?.payload?.role_associations?.forEach(roleAssoc => {
            let role = rolesList?.filter(r => r.id === roleAssoc?.role);
            if (role?.length === 1) {
              userRoles.push(role[0]);
            }
          });
          userObj.payload.roles = userRoles;
        }
      });
      return users;
    }
  }

  superRead(request: ReadRequest, context): Promise<DeepPartial<UserListResponse>> {
    return super.read(request, context);
  }

  /**
   * Extends ServiceBase.create()
   */
  async create(request: UserList, context: any): Promise<DeepPartial<UserListResponse>> {
    let usersList = request.items;
    const insertedUsers = { items: [], total_count: 0, operation_status: { code: 0, message: '' } };
    // verify the assigned role_associations with the HR scope data before creating
    // extract details from auth_context of request and update the context Object
    let subject = request.subject;
    // update meta data for owners information
    const acsResources = await this.createMetadata(usersList, AuthZAction.CREATE, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = acsResources;
      acsResponse = await checkAccessRequest(context, [{ resource: 'user', id: acsResources.map(item => item.id) }], AuthZAction.CREATE,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for create', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (this.cfg.get('authorization:enabled')) {
        try {
          // validate and remove item if there is an error when verifying role associations
          for (let item of usersList || []) {
            const verficationResponse = await this.verifyUserRoleAssociations([item], subject);
            // error verifying role associations
            const userID = item.id;
            if (!_.isEmpty(verficationResponse) && verficationResponse?.status?.message) {
              insertedUsers.items.push(returnStatus(verficationResponse.status.code,
                verficationResponse.status.message, verficationResponse.status.id));
              usersList = _.filter(usersList, (item) => (item.id != userID));
            }
          }
        } catch (err) {
          this.logger.error('Error caught verifying user role associations', { code: err.code, message: err.message, stack: err.stack });
          const errMessage = err.details ? err.details : err.message;
          // for unhandled promise rejection
          return returnOperationStatus(400, errMessage);
        }
      }
      if (usersList?.length > 0) {
        for (let user of usersList) {
          user.activation_code = '';
          // if user is inactive set activation_code
          if (!user.active) {
            user.activation_code = this.idGen();
          }
          user.unauthenticated = false;
          if (user.invite) {
            user.active = false;
            user.activation_code = this.idGen();
            user.unauthenticated = true;
          }
          insertedUsers.items.push(await this.createUser(user, context));

          if (this.emailEnabled && user?.invite) {
            await this.fetchHbsTemplates();
            // send render request for user Invitation
            const renderRequest = this.makeInvitationEmailData(user);
            await this.topics.rendering.emit('renderRequest', renderRequest);
          }
        }
      }
      insertedUsers.operation_status = returnCodeMessage(200, 'success');
      if (insertedUsers?.items?.length > 0) {
        insertedUsers.total_count = insertedUsers.items.length;
      }
      return insertedUsers;
    }
  }

  private async verifyUserRoleAssociations(usersList: User[], subject: any): Promise<any> {
    let validateRoleScope = false;
    let token, redisHRScopesKey, user;
    let hierarchical_scopes: any = [];
    if (subject) {
      token = subject.token;
    }
    if (token) {
      user = await this.findByToken(FindByTokenRequest.fromPartial({ token }), {});
      if (user?.payload) {
        const tokenFound = _.find(user?.payload?.tokens, { token });
        if (tokenFound && tokenFound?.interactive) {
          redisHRScopesKey = `cache:${user.payload.id}:hrScopes`;
        } else if (tokenFound && !tokenFound?.interactive) {
          redisHRScopesKey = `cache:${user.payload.id}:${token}:hrScopes`;
        }
        subject.role_associations = user.payload.role_associations;
      }
    }

    if (redisHRScopesKey) {
      hierarchical_scopes = await this.redisClient.get(redisHRScopesKey) as any;
      hierarchical_scopes = hierarchical_scopes ? JSON.parse(hierarchical_scopes) : subject?.hierarchical_scopes;
    } else if (subject && subject?.hierarchical_scopes) {
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
        let ctx = { subject, resources: [] };
        acsResponse = await checkAccessRequest(ctx, [{ resource: 'user' }], AuthZAction.MODIFY, Operation.whatIsAllowed);
      } catch (err) {
        this.logger.error('Error making wahtIsAllowedACS request for verifying role associations', { code: err.code, message: err.message, stack: err.stack });
        return returnStatus(err.code, err.message, usersList[0].id);
      }
      // for apiKey no need to verify role assocs
      const configuredApiKey = this.cfg.get('authentication:apiKey');
      if ((acsResponse.decision === Response_Decision.PERMIT) &&
        (configuredApiKey && subject.token && configuredApiKey === subject.token)) {
        return;
      }
      if ((acsResponse as PolicySetRQResponse)?.policy_sets?.length > 0) {
        const policiesList = (acsResponse as PolicySetRQResponse).policy_sets[0].policies;
        if (policiesList?.length > 0) {
          for (let policy of policiesList) {
            for (let rule of policy?.rules) {
              if (rule?.effect === Effect.PERMIT && rule?.target?.subjects) {
                // check if the rule subject has any scoping Entity
                const ruleSubjectAttrs = rule?.target?.subjects;
                for (let ruleAttr of ruleSubjectAttrs || []) {
                  if (ruleAttr?.id === this.cfg.get('authorization:urns:role')) {
                    // rule's role which give's user the acess to create User
                    createAccessRole.push(ruleAttr.value);
                    // check if there is no scoping then skip comparing / validating role scope instance
                    // ex: superAdmin who does not have role scoping instance
                    if (ruleSubjectAttrs?.length === 1) {
                      skipValidatingScopingInstance = true;
                    }
                  }
                  if (ruleAttr?.id === this.cfg.get('authorization:urns:roleScopingEntity')) {
                    validateRoleScope = true;
                  }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      this.logger.error('Error caught calling ACS', { code: err.code, message: err.message, stack: err.stack });
      return returnStatus(err.code, err.message);
    }
    // check if the assignable_by_roles contain createAccessRole
    for (let user of usersList || []) {
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
        filters: [{
          field: 'id',
          operation: Filter_Operation.in,
          value: JSON.stringify(targetUserRoleIds),
          type: FilterValueType.ARRAY
        }]
      }];
      let rolesData = await this.roleService.read({
        filters,
        subject
      } as any, {});
      if (rolesData?.total_count === 0) {
        let message = `One or more of the target role IDs are invalid ${targetUserRoleIds},` +
          ` no such role exist in system`;
        this.logger.verbose(message);
        return returnStatus(400, message, user.id);
      }
      let dbTargetRoles = [];
      if (rolesData?.items?.length > 0) {
        for (let targetRole of rolesData.items) {
          if (targetRole?.payload?.id) {
            dbTargetRoles.push(targetRole.payload.id);
            if (!targetRole?.payload?.assignable_by_roles ||
              !createAccessRole.some((role) => targetRole?.payload?.assignable_by_roles?.includes(role))) {
              const userName = user?.name ? user.name : undefined;
              let message = `The target role ${targetRole.payload.id} cannot be assigned to` +
                ` user ${userName} as user role ${createAccessRole} does not have permissions`;
              this.logger.verbose(message);
              return returnStatus(403, message, user.id);
            }
          }
        }
      }

      // validate target roles is a valid role in DB
      for (let targetUserRoleId of targetUserRoleIds || []) {
        if (!dbTargetRoles?.includes(targetUserRoleId)) {
          const userName = user?.name ? user.name : undefined;
          let message = `The target role ${targetUserRoleId} is invalid and cannot be assigned to` +
            ` user ${userName}`;
          this.logger.verbose(message);
          return returnStatus(403, message, user.id);
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
      hierarchical_scopes = subject?.hierarchical_scopes;
      if (!_.isEmpty(hierarchical_scopes)) {
        for (let hrScope of hierarchical_scopes || []) {
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
        return returnStatus(401, 'No Hierarchical Scopes could be found', usersList[0].id);
      }
      for (let user of usersList) {
        if (user?.role_associations?.length > 0) {
          const validationResponse = this.validateUserRoleAssociations(user.role_associations, hrScopes, user.name, subject, user.id);
          if (!_.isEmpty(validationResponse)) {
            return validationResponse;
          }
          if (!_.isEmpty(user?.tokens)) {
            for (let token of user.tokens) {
              if (!token?.interactive && !_.isEmpty(token?.scopes)) {
                for (let scope of token?.scopes || []) {
                  // if scope is not found in role assoc invalid scope assignemnt in token
                  if (!_.find(user.role_associations, { id: scope })) {
                    let message = `Invalid token scope ${scope} found for Subject ${user.id}`;
                    this.logger.verbose(message);
                    return returnStatus(400, message, user.id);
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
   */
  private validateUserRoleAssociations(userRoleAssocs: RoleAssociation[],
    hrScopes: HierarchicalScope[], userName: string, subject: ResolvedSubject, userID: string) {
    for (let userRoleAssoc of userRoleAssocs || []) {
      let validUserRoleAssoc = false;
      let userRole = userRoleAssoc?.role;
      if (userRole) {
        let userRoleAttr = userRoleAssoc?.attributes as Attribute[];
        let userScope;
        for (let roleScopeInstObj of userRoleAttr || []) {
          roleScopeInstObj?.attributes?.filter((obj) => {
            if (obj?.id === this.cfg.get('authorization:urns:roleScopingInstance')) {
              userScope = obj?.value;
            }
          });
        }
        // validate the userRole and userScope with hrScopes
        if (userRole && hrScopes.length > 0) {
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
          if (subject?.role_associations?.length > 0) {
            const creatorRoleAssocs = subject.role_associations;
            for (let role of creatorRoleAssocs || []) {
              if (role.role === userRole) {
                // check if the target scope matches
                let creatorScope;
                let creatorRoleAttr = role.attributes;
                for (let roleScopeInstObj of creatorRoleAttr) {
                  roleScopeInstObj?.attributes?.filter((obj) => {
                    if (obj?.id === this.cfg.get('authorization:urns:roleScopingInstance')) {
                      creatorScope = obj?.value;
                    }
                  });
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
          return returnStatus(403, message, userID);
        }
      }
    }
  }

  private checkTargetScopeExists(hrScope: HierarchicalScope, targetScope: string): boolean {
    if (hrScope?.id === targetScope) {
      // found the target scope object, iterate and put the orgs in reducedUserScope array
      this.logger.debug(`Valid target scope:`, targetScope);
      return true;
    } else if (hrScope?.children.length > 0) {
      for (let childNode of hrScope?.children) {
        if (this.checkTargetScopeExists(childNode, targetScope)) {
          return true;
        }
      }
    }
    return false;
  }

  private async checkPasswordStrength(password: string): Promise<ZxcvbnResult> {
    const minLength: number = this.cfg.get('service:passwordMinLength');
    const minLengthMatcher: Matcher = {
      Matching: class MatchMinLength {
        match({ password }: { password: string }) {
          const matches: Match[] = [];
          if (password.length < minLength) {
            matches.push({
              pattern: 'minLength',
              token: password,
              i: 0,
              j: password.length - 1,
            });
          }
          return matches;
        }
      },
      feedback(match: MatchEstimated, isSoleMatch: boolean | undefined) {
        return {
          warning: 'Your password is not long enough',
          suggestions: [],
        };
      },
      scoring(match: MatchExtended) {
        // The length of the password is multiplied by 10 to create a higher score the more characters are added.
        return match.token.length * 10;
      },
    };

    const numberMatcher: Matcher = {
      Matching: class MatchNumber {
        match({ password }: { password: string }) {
          const matches: Match[] = [];
          if (!/[0-9]/.test(password)) {
            matches.push({
              pattern: 'number',
              token: password,
              i: 0,
              j: password.length - 1,
            });
          }
          return matches;
        }
      },
      feedback(match: MatchEstimated, isSoleMatch: boolean | undefined) {
        return {
          warning: 'Your password must contain at least one number',
          suggestions: [],
        };
      },
      scoring(match: MatchExtended) {
        return 10; // adjust the score as needed
      },
    };

    const uppercaseMatcher: Matcher = {
      Matching: class MatchUppercase {
        match({ password }: { password: string }) {
          const matches: Match[] = [];
          if (!/[A-Z]/.test(password)) {
            matches.push({
              pattern: 'uppercase',
              token: password,
              i: 0,
              j: password.length - 1,
            });
          }
          return matches;
        }
      },
      feedback(match: MatchEstimated, isSoleMatch: boolean | undefined) {
        return {
          warning: 'Your password must contain at least one uppercase letter',
          suggestions: [],
        };
      },
      scoring(match: MatchExtended) {
        return 10; // adjust the score as needed
      },
    };

    const lowercaseMatcher: Matcher = {
      Matching: class MatchLowercase {
        match({ password }: { password: string }) {
          const matches: Match[] = [];
          if (!/[a-z]/.test(password)) {
            matches.push({
              pattern: 'lowercase',
              token: password,
              i: 0,
              j: password.length - 1,
            });
          }
          return matches;
        }
      },
      feedback(match: MatchEstimated, isSoleMatch: boolean | undefined) {
        return {
          warning: 'Your password must contain at least one lowercase letter',
          suggestions: [],
        };
      },
      scoring(match: MatchExtended) {
        return 10; // adjust the score as needed.
      },
    };

    const specialCharMatcher: Matcher = {
      Matching: class MatchSpecialChar {
        match({ password }: { password: string }) {
          const matches: Match[] = [];
          if (!/[!@#$%^&*]/.test(password)) {
            matches.push({
              pattern: 'specialChar',
              token: password,
              i: 0,
              j: password.length - 1,
            });
          }
          return matches;
        }
      },
      feedback(match: MatchEstimated, isSoleMatch: boolean | undefined) {
        return {
          warning: 'Your password must contain at least one special character (!@#$%^&*)',
          suggestions: [],
        };
      },
      scoring(match: MatchExtended) {
        return 10; // adjust the score as needed
      },
    };

    const matcherPwned = matcherPwnedFactory(fetch, zxcvbnOptions);
    zxcvbnOptions.addMatcher('pwned', matcherPwned);
    zxcvbnOptions.addMatcher('minLength', minLengthMatcher);
    zxcvbnOptions.addMatcher('number', numberMatcher);
    zxcvbnOptions.addMatcher('uppercase', uppercaseMatcher);
    zxcvbnOptions.addMatcher('lowercase', lowercaseMatcher);
    zxcvbnOptions.addMatcher('specialChar', specialCharMatcher);

    const options = {
      dictionary: {
        ...zxcvbnCommonPackage.dictionary,
        ...zxcvbnEnPackage.dictionary,
        ...zxcvbnDePackage.dictionary,
      },
      graphs: zxcvbnCommonPackage.adjacencyGraphs,
      useLevenshteinDistance: true,
      translations: zxcvbnEnPackage.translations,
    };
    zxcvbnOptions.setOptions(options);
    const result = await zxcvbnAsync(password);

    return result;
  };

  /**
   * Validates User and creates it in DB,
   * @param user
   */
  private async createUser(user: User, context: any): Promise<DeepPartial<UserResponse>> {
    const logger = this.logger;

    // User creation
    logger.silly('request to register a user');

    this.setUserDefaults(user);
    if ((!user?.password && !user?.invite && (user?.user_type != UserType.TECHNICAL_USER))) {
      return returnStatus(400, 'argument password is empty', user.id);
    }
    if (!user.email) {
      return returnStatus(400, 'argument email is empty', user.id);
    }
    if (!user.name) {
      return returnStatus(400, 'argument name is empty', user.id);
    }

    let resultPasswordChecker;
    if (user.password) {
      resultPasswordChecker = await this.checkPasswordStrength(user.password);
    }
    const minScore: number = this.cfg.get('service:passwordComplexityMinScore');
    if (minScore > resultPasswordChecker?.score) {
      logger.error(`Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID ${user?.id}`);
      return returnStatus(400, `Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID ${user?.id}`);
    }

    const serviceCfg = this.cfg.get('service');

    const minLength = serviceCfg?.minUsernameLength;
    const maxLength = serviceCfg?.maxUsernameLength;

    try {
      this.validUsername(user?.name, minLength, maxLength, logger);
    } catch (err) {
      const errorMessage = `Error while validating username: ${user.name}, ` +
        `error: ${err.name}, message:${err.details}`;
      logger.error(errorMessage);
      return returnStatus(400, errorMessage, user.id);
    }

    if (_.isEmpty(user?.first_name) || _.isEmpty(user?.last_name)) {
      return returnStatus(400, 'User register requires both first and last name', user.id);
    }

    // Since for guestUser he should be able to register with same email ID multiple times
    // so we are creating user and not making the unique emailID or user name check
    // Guest creation
    if (user?.guest) {
      logger.silly('request to register a guest');

      const createStatus = await super.create(UserList.fromPartial({
        items: [user]
      }), context);
      logger.info('guest user registered', user);
      await (this.topics['user.resource'].emit('registered', user));
      return createStatus.items[0];
    }

    logger.silly('register is checking id, name and email', { id: user.id, name: user.name, email: user.email });
    let filters;
    if (this.uniqueEmailConstraint) {
      filters = [{
        filters: [{
          field: 'name',
          operation: Filter_Operation.eq,
          value: user.name
        },
        {
          field: 'email',
          operation: Filter_Operation.eq,
          value: user.email
        }],
        operator: FilterOp_Operator.or
      }];
    } else {
      filters = getNameFilter(user.name);
    }
    let users = await super.read(ReadRequest.fromPartial({ filters }), context);
    if (users.total_count > 0) {
      for (let user of users.items || []) {
        if (user?.payload?.guest) {
          logger.debug('Guest user', { name: user.payload.name });
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

    const result = await super.create(UserList.fromPartial({
      items: [user]
    }), context);
    if (result?.items?.length > 0) {
      for (let item of result?.items) {
        if (item?.payload?.data) {
          item.payload.data = { value: Buffer.from(JSON.stringify(item.payload.data)) };
        }
      }
    }
    return (result).items[0];
  }

  /**
   * Endpoint register, register a user or guest user.
   * @return type is any since it can be guest or user type
   */
  async register(request: RegisterRequest, context): Promise<DeepPartial<UserResponse>> {
    const user: User = User.fromPartial(request);
    const register = this.cfg.get('service:register');
    if (!register) {
      this.logger.info('Endpoint register has been disabled');
      return returnStatus(412, 'Endpoint register has been disabled');
    }
    if (!user.email) {
      return returnStatus(400, 'argument email is empty', user.id);
    }
    if (!user.name) {
      return returnStatus(400, 'argument name is empty', user.id);
    }
    if (!user.password) {
      return returnStatus(400, 'argument password is empty', user.id);
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

  async confirmUserInvitation(request: ConfirmUserInvitationRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    // find the actual user object from DB using the UserInvitationReq identifier
    // activate user and update password
    const identifier = request.identifier;
    const subject = request.subject;
    const filters = getDefaultFilter(identifier);
    let user: DeepPartial<User>;
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);

    if (users?.total_count === 1) {
      user = users?.items[0]?.payload;
    } else if (users?.total_count === 0) {
      return returnOperationStatus(404, `user not found for identifier ${identifier}`);
    } else if (users?.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for user invitation confirmation, multiple users found for identifier ${identifier}`);
    }

    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: {
          id: user.id,
          active: true,
          activation_code: request.activation_code,
          password_hash: password.hash(request.password),
          meta: user.meta
        }
      }, [{ resource: 'user', id: user.id, property: ['active', 'activation_code', 'password_hash'] }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for confirmUserInvitation', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if ((!request.activation_code) || request.activation_code !== user.activation_code) {
        this.logger.debug('wrong activation code', { user });
        return returnOperationStatus(412, 'wrong activation code');
      }
      user.active = true;
      user.unauthenticated = false;
      user.activation_code = '';

      user.password_hash = password.hash(request.password);
      const updateStatus = await super.update(UserList.fromPartial({
        items: [user]
      }), context);
      this.logger.info('password updated for invited user', { identifier });
      return { operation_status: updateStatus?.items[0]?.status };
    }
  }

  /**
   * Endpoint sendEmail to trigger sending mail notification.
   * @param  {any} renderResponse
   */
  async sendEmail(renderResponse: any): Promise<void> {
    const responseID: string = renderResponse?.id;
    if (!responseID?.startsWith('identity')) {
      this.logger.verbose(`Discarding render response ${responseID}`);
      return;
    }

    const split = responseID?.split('#');
    if (split?.length != 2) {
      this.logger.verbose(`Unknown render response ID format: ${responseID}`);
      return;
    }

    const emailAddress = split[1];

    const filters = [{
      filters: [{
        field: 'email',
        operation: Filter_Operation.eq,
        value: emailAddress
      },
      {
        field: 'new_email',
        operation: Filter_Operation.eq,
        value: emailAddress
      }],
      operator: FilterOp_Operator.or
    }];

    const user = await super.read(ReadRequest.fromPartial({ filters }), {});
    if (_.isEmpty(user?.items)) {
      this.logger.silly(`Received rendering response from unknown email address ${emailAddress}; discarding`);
      return;
    }

    const responseBody = unmarshallProtobufAny(renderResponse?.responses[0], this.logger);
    const responseSubject = unmarshallProtobufAny(renderResponse?.responses[1], this.logger);
    const emailData = this.makeNotificationData(emailAddress, responseBody, responseSubject);
    await this.topics?.notificationReq?.emit('sendEmail', emailData);
  }

  private idGen(): string {
    return uuid.v4().replace(/-/g, '');
  }

  // validUsername validates user names using regular expressions
  private validUsername(username: string, minLength: number, maxLength: number, logger: Logger) {
    if (username.includes('@')) {
      validateEmail(username, logger);
      return;
    }
    validateStrLen(username, minLength, maxLength, logger);
    validateFirstChar(username, logger);
    validateAllChar(username, logger);
    validateSymbolRepeat(username, logger);
  }

  /**
   * Endpoint to activate a User
   */
  async activate(request: ActivateRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const logger = this.logger;
    const identifier = request.identifier;
    const activationCode = request.activation_code;
    const subject = request.subject;
    let acsResponse: DecisionResponse;
    const inactivatedAccountExpiry = this.cfg.get('service:inactivatedAccountExpiry');

    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
    let user;
    if (users?.items?.length > 0) {
      user = users?.items[0]?.payload;
    }

    // Check if inactivatedAccountExpiry is set and positive
    if (inactivatedAccountExpiry != undefined && inactivatedAccountExpiry > 0) {

      if (user && user.meta.created) {
        const currentTimestamp = new Date(); // Current Unix timestamp in seconds
        const activationTimestamp = user.meta.created;

        // Check if the activation code has expired
        // calculate the difference between currentTimestamp.getTime() and activationTimestamp.getTime(). This gives the time difference in milliseconds.
        // multiply inactivatedAccountExpiry by 1000 to convert it to milliseconds (assuming it's specified in seconds), and then compare it with the time difference to check if the activation code has expired.
        if (currentTimestamp.getTime() - activationTimestamp.getTime() > inactivatedAccountExpiry * 1000) {
          logger.debug('activation code has expired', user);
          return returnOperationStatus(400, 'Activation code has expired');
        }
      }
    }

    if (!users || users?.total_count === 0) {
      return returnOperationStatus(404, 'user not found');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for user activation, multiple users found for identifier ${identifier}`);
    }

    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: { id: user.id, active: true, activation_code: activationCode, meta: user.meta }
      }, [{ resource: 'user', id: user.id, property: ['active', 'activation_code'] }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for activate', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (!identifier) {
        return returnOperationStatus(400, 'argument id is empty');
      }
      if (!activationCode) {
        return returnOperationStatus(400, 'argument activation_code is empty');
      }
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
      const updateStatus = await super.update(UserList.fromPartial({
        items: [user]
      }), context);
      if (updateStatus?.items[0]?.status?.message === 'success') {
        logger.info('user activated', user);
        await this.topics['user.resource'].emit('activated', { id: user.id });
      }
      return { operation_status: updateStatus?.items[0]?.status };
    }
  }

  /**
   * Endpoint to change user password for authenticated user
   */
  async changePassword(request: ChangePasswordRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const logger = this.logger;
    const pw = request.password;
    const newPw = request.new_password;
    let subject = request.subject;
    const dbUser = await this.findByToken(FindByTokenRequest.fromPartial({ token: subject.token }), {});
    if (!dbUser || _.isEmpty(dbUser.payload)) {
      return returnOperationStatus(404, 'Invalid token or user does not exist');
    }
    const users = await super.read(ReadRequest.fromPartial({
      filters: [{
        filters: [{
          field: 'id',
          operation: Filter_Operation.eq,
          value: dbUser?.payload?.id
        }]
      }]
    }), context);
    if (!users || users.total_count === 0) {
      logger.debug('user does not exist', { identifier: subject.id });
      return returnOperationStatus(404, 'user does not exist');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for change password, multiple users found for identifier ${subject.id}`);
    }
    const user = users.items[0].payload;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: { id: user.id, password: pw, new_password: newPw, meta: user.meta }
      }, [{ resource: 'user', id: user.id, property: ['password', 'new_password'] }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for changePassword', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      const userPWhash = user.password_hash;
      if (!password.verify(userPWhash, pw)) {
        return returnOperationStatus(401, 'password does not match');
      }

      const resultPasswordChecker = await this.checkPasswordStrength(newPw);
      const minScore: number = this.cfg.get('service:passwordComplexityMinScore');
      if (minScore > resultPasswordChecker.score) {
        logger.error(`Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID:`, user.id);
        return returnOperationStatus(400, `Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID ${user.id}`);
      }

      user.password_hash = password.hash(newPw);
      const updateStatus = await super.update(UserList.fromPartial({
        items: [user]
      }), context);
      if (updateStatus?.items[0]?.status?.message === 'success') {
        logger.info('password changed for user', { identifier: subject.id });
        await this.topics['user.resource'].emit('passwordChanged', user);
      }
      return { operation_status: updateStatus?.items[0]?.status };
    }
  }

  /**
   * Endpoint to request password change.
   * A UUID is generated and a confirmation email is
   * sent out to the user's defined email address.
   */
  async requestPasswordChange(request: RequestPasswordChangeRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const logger = this.logger;
    const identifier = request.identifier;
    // check for the identifier against name or email
    const filters = getDefaultFilter(identifier);
    let user;
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
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
    const updateStatus = await super.update(UserList.fromPartial({
      items: [user]
    }), context);
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
   */
  async confirmPasswordChange(request: ConfirmPasswordChangeRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const logger = this.logger;
    const { identifier, activation_code } = request;
    const newPassword = request.password;
    let subject = request.subject;
    let acsResponse: DecisionResponse;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    let user: DeepPartial<User>;
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
    if (!users || users.total_count === 0) {
      return returnOperationStatus(404, 'user not found');
    } else if (users.total_count === 1) {
      user = users.items[0].payload;
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for confirm password change, multiple users found for identifier ${identifier}`);
    }
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: {
          id: user.id,
          activation_code,
          password_hash: password.hash(newPassword),
          meta: user.meta
        }
      }, [{ resource: 'user', id: user.id, property: ['activation_code', 'password_hash'] }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for confirmPasswordChange', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (!user.activation_code || user.activation_code !== activation_code) {
        logger.debug('wrong activation code upon password change confirmation for user', user.name);
        return returnOperationStatus(412, 'wrong activation code');
      }

      user.activation_code = '';
      // if user is inactive activate user
      if (!user.active) {
        user.active = true;
        user.unauthenticated = false;
      }
      const resultPasswordChecker = await this.checkPasswordStrength(newPassword);
      const minScore: number = this.cfg.get('service:passwordComplexityMinScore');
      if (minScore > resultPasswordChecker.score) {
        logger.error(`Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID:`, user.id);
        return returnOperationStatus(400, `Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID ${user.id}`);
      }

      user.password_hash = password.hash(newPassword);
      const updateStatus = await super.update(UserList.fromPartial({
        items: [user]
      }), context);
      if (updateStatus?.items[0]?.status?.message === 'success') {
        logger.info('password changed for user', user.id);
        await this.topics['user.resource'].emit('passwordChanged', user);
      }
      return { operation_status: updateStatus?.items[0]?.status };
    }
  }

  /**
   * Endpoint to change email Id.
   */
  async requestEmailChange(request: ChangeEmailRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const logger = this.logger;
    const identifier = request.identifier;
    const new_email = request.new_email;
    const subject = request.subject;
    let acsResponse: DecisionResponse;
    // check for the identifier against name or email
    const filters = getDefaultFilter(identifier);
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
    if (!users || users.total_count === 0) {
      logger.debug('user does not exist', { identifier });
      return returnOperationStatus(404, 'user does not exist');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for request email change, multiple users found for identifier ${identifier}`);
    }
    const user = users.items[0].payload;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: { id: user.id, identifier, new_email, meta: user.meta }
      }, [{ resource: 'user', id: user.id, property: ['identifier', 'new_email'] }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for requestEmailChange', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      user.new_email = new_email;
      user.activation_code = this.idGen();
      const updateStatus = await super.update(UserList.fromPartial({
        items: [user]
      }), context);
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
   */
  async confirmEmailChange(request: ConfirmEmailChangeRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const logger = this.logger;
    const identifier = request.identifier;
    const activationCode = request.activation_code;

    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
    if (users && users.total_count === 0) {
      logger.debug('user does not exist', identifier);
      return returnOperationStatus(404, 'user does not exist');
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for confirm email change, multiple users found for identifier ${identifier}`);
    }

    const user = users.items[0].payload;
    let subject = request.subject;
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: {
          id: user.id,
          activation_code: activationCode,
          email: user.new_email,
          meta: user.meta
        }
      }, [{ resource: 'user', id: user.id, property: ['email', 'activation_code'] }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for confirmEmailChange', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (user.activation_code !== activationCode) {
        logger.debug('wrong activation code upon email confirmation for user', user);
        return returnOperationStatus(412, 'wrong activation code');
      }
      user.email = user.new_email;
      user.new_email = '';
      user.activation_code = '';
      const updateStatus = await super.update(UserList.fromPartial({
        items: [user]
      }), context);
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
   */
  async update(request: UserList, context: any): Promise<DeepPartial<UserListResponse>> {
    if (_.isNil(request) || _.isNil(request.items) || _.isEmpty(request.items)) {
      return returnOperationStatus(400, 'No items were provided for update');
    }
    let items = request.items;
    let subject = request.subject;
    // update meta data for owners information
    const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = acsResources;
      acsResponse = await checkAccessRequest(context, [{ resource: 'user', id: acsResources.map(e => e.id) }], AuthZAction.MODIFY,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for update', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      let updateWithStatus = { items: [], operation_status: {} };
      if (this.cfg.get('authorization:enabled')) {
        try {
          const roleAssocsModified = await this.roleAssocsModified(items, context);
          if (roleAssocsModified) {
            // validate and remove item if there is an error when verifying role associations
            for (let item of items) {
              const verficationResponse = await this.verifyUserRoleAssociations([item], subject);
              // error verifying role associations
              const userID = item.id;
              if (!_.isEmpty(verficationResponse) && verficationResponse?.status?.message) {
                updateWithStatus.items.push(returnStatus(verficationResponse.status.code,
                  verficationResponse.status.message, verficationResponse.status.id));
                items = _.filter(items, (item) => (item.id != userID));
              }
            }
          }
        } catch (err) {
          const errMessage = err.details ? err.details : err.message;
          this.logger.error('Error validating role associations', { code: err.code, message: errMessage, stack: err.stack });
          // for unhandled promise rejection
          return returnOperationStatus(400, errMessage);
        }
      }
      // each item includes payload and status in turn
      for (let i = 0; i < items?.length; i += 1) {
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
          filters: [{
            field: 'id',
            operation: Filter_Operation.eq,
            value: user.id
          }]
        }];
        const users = await super.read(ReadRequest.fromPartial({ filters }), context);
        if (users.total_count === 0) {
          updateWithStatus.items.push(returnStatus(404, 'user not found for update', user.id));
          items = _.filter(items, (item) => item.id !== user.id);
          continue;
        }
        let dbUser = users.items[0].payload;
        // if user name is changed, check if the new user name is not used by any one else in application
        if (user?.name && (dbUser.name != user.name)) {
          const filters = getNameFilter(user.name);
          let users = await super.read(ReadRequest.fromPartial({ filters }), context);
          if (users.total_count > 0) {
            updateWithStatus.items.push(returnStatus(409, `User name ${user.name} already exists`, user.id));
            items = _.filter(items, (item) => item.name !== user.name);
            continue;
          }
        }
        // update meta information from existing Object in case if its
        // not provided in request
        if (!user.meta) {
          user.meta = dbUser.meta as Meta;
        } else if (user.meta && _.isEmpty(user.meta.owners)) {
          user.meta.owners = dbUser.meta.owners as Attribute[];
        }
        // check for ACS if owners information is changed
        if (!_.isEqual(user.meta.owners, dbUser.meta.owners)) {
          let acsResponse: DecisionResponse;
          try {
            if (!context) { context = {}; };
            context.subject = subject;
            context.resources = user;
            acsResponse = await checkAccessRequest(context, [{ resource: 'user', id: user.id }], AuthZAction.MODIFY,
              Operation.isAllowed, false);
          } catch (err) {
            this.logger.error('Error occurred requesting access-control-srv for update', { code: err.code, message: err.message, stack: err.stack });
            // return returnStatus(err.code, err.message);
            updateWithStatus.items.push(returnStatus(err.code, err.message, user.id));
            items = _.filter(items, (item) => item.id !== user.id);
            continue;
          }
          if (acsResponse.decision != Response_Decision.PERMIT) {
            // return returnStatus(acsResponse.response.status.code, acsResponse.response.status.message);
            updateWithStatus.items.push(returnStatus(acsResponse.operation_status.code, acsResponse.operation_status.message, user.id));
            items = _.filter(items, (item) => item.id !== user.id);
            continue;
          }
        }

        // Flush findByToken redis data
        if (user?.tokens?.length > 0) {
          for (let token of user.tokens) {
            const tokenValue = token.token;
            const response = await this.tokenRedisClient.get(tokenValue);
            if (response) {
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
                      for (let redisAttribute of redisRoleAssoc.attributes) {
                        const redisNestedAttributes = redisAttribute.attributes;
                        if (userRoleAssoc?.attributes?.length > 0) {
                          for (let userAttribute of userRoleAssoc.attributes) {
                            const userNestedAttributes = userAttribute.attributes;
                            if (userAttribute.id === redisAttribute.id &&
                              userAttribute.value === redisAttribute.value &&
                              this.nestedAttributesEqual(redisNestedAttributes, userNestedAttributes)) {
                              found = true;
                              roleAssocEqual = true;
                              break;
                            }
                          }
                        } else {
                          found = true;
                          roleAssocEqual = true;
                          break;
                        }
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
              if (!roleAssocEqual || !tokensEqual || (updatedRoleAssocs?.length != redisRoleAssocs?.length)) {
                // flush token subject cache
                await this.tokenRedisClient.del(tokenValue);
                this.logger.info('Redis cached data for findByToken deleted successfully', { token: tokenValue });
              }
            }
          }
        }
        // Update password if it contains that field by updating hash
        if (user.password) {
          const resultPasswordChecker = await this.checkPasswordStrength(user.password);
          const minScore: number = this.cfg.get('service:passwordComplexityMinScore');
          if (minScore > resultPasswordChecker.score) {
            this.logger.error(`Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID:`, user.id);
            return returnOperationStatus(400, `Password is too weak The password score is ${resultPasswordChecker.score}/4, minimum score is ${minScore}. Suggestions: ${resultPasswordChecker.feedback.suggestions} & ${resultPasswordChecker.feedback.warning} User ID ${user.id}`);
          }

          user.password_hash = password.hash(user.password);
          delete user.password;
        } else {
          // set the existing hash password field
          user.password_hash = dbUser.password_hash;
        }
        if (!user.active && user?.tokens?.length > 0) {
          for (let token of user.tokens) {
            const tokenValue = token.token;
            await this.tokenRedisClient.del(tokenValue);
            this.logger.info('Redis token deleted successfully', { token: tokenValue });
          }
          user.tokens = [];
        }
      }
      let updateStatus: any = { items: [] };
      if (items?.length > 0) {
        updateStatus = await super.update({ items }, context);
      }
      updateStatus.items.push(...updateWithStatus.items);
      if (!updateStatus.operation_status) {
        updateStatus.operation_status = { code: 200, message: 'success' };
      }
      return updateStatus;
    }
  }

  private nestedAttributesEqual(dbAttributes, userAttributes) {
    if (!userAttributes) {
      return true;
    }
    if (dbAttributes?.length > 0 && userAttributes?.length > 0) {
      return userAttributes.every((obj) => dbAttributes.some((dbObj => dbObj.value === obj.value)));
    } else if (dbAttributes?.length != userAttributes?.length) {
      return false;
    }
  }

  private async roleAssocsModified(usersList: User[], context: any) {
    this.logger.debug('Checking for changes in role-associations');
    let roleAssocsModified = false;
    for (let user of usersList) {
      const userID = user.id;
      const filters = [{
        filters: [{
          field: 'id',
          operation: Filter_Operation.eq,
          value: user.id
        }]
      }];
      const userRoleAssocs = user.role_associations;
      const users = await super.read(ReadRequest.fromPartial({ filters }), context);
      if (users?.items?.length > 0) {
        let dbRoleAssocs = users.items[0].payload.role_associations;
        if (userRoleAssocs?.length != dbRoleAssocs?.length) {
          roleAssocsModified = true;
          this.logger.debug('Role associations length are not equal', { id: userID });
          break;
        } else {
          // compare each role and its association
          if (userRoleAssocs?.length > 0 && dbRoleAssocs?.length > 0) {
            for (let userRoleAssoc of userRoleAssocs) {
              let found = false;
              for (let dbRoleAssoc of dbRoleAssocs) {
                if (dbRoleAssoc.role === userRoleAssoc.role) {
                  if (dbRoleAssoc?.attributes?.length > 0) {
                    for (let dbAttribute of dbRoleAssoc.attributes) {
                      const dbNestedAttributes = dbAttribute.attributes;
                      if (userRoleAssoc?.attributes?.length > 0) {
                        for (let userAttribute of userRoleAssoc.attributes) {
                          const userNestedAttributes = userAttribute.attributes;
                          if (userAttribute.id === dbAttribute.id &&
                            userAttribute.value === dbAttribute.value &&
                            this.nestedAttributesEqual(dbNestedAttributes, userNestedAttributes)) {
                            found = true;
                            break;
                          }
                        }
                      }
                    }
                  } else {
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
   */
  async upsert(request: UserList, context: any): Promise<DeepPartial<UserListResponse>> {
    if (_.isNil(request) || _.isNil(request.items) || _.isEmpty(request.items)) {
      return returnOperationStatus(400, 'No items were provided for upsert');
    }

    let usersList = request.items;
    let subject = request.subject;
    const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: PolicySetRQResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = acsResources;
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: acsResources
      }, [{ resource: 'user', id: acsResources.map(e => e.id) }], AuthZAction.MODIFY, Operation.whatIsAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for upsert', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      let upsertWithStatus = { items: [], total_count: 0, operation_status: {} };
      if (this.cfg.get('authorization:enabled')) {
        try {
          const roleAssocsModified = await this.roleAssocsModified(usersList, context);
          if (roleAssocsModified) {
            // validate and remove item if there is an error when verifying role associations
            for (let item of usersList) {
              const verficationResponse = await this.verifyUserRoleAssociations([item], subject);
              // error verifying role associations
              const userID = item.id;
              if (!_.isEmpty(verficationResponse) && verficationResponse.status && verficationResponse.status.message) {
                upsertWithStatus.items.push(returnStatus(verficationResponse.status.code,
                  verficationResponse.status.message, verficationResponse.status.id));
                usersList = _.filter(usersList, (item) => (item.id != userID));
              }
            }
          }
        } catch (err) {
          const errMessage = err.details ? err.details : err.message;
          // for unhandled promise rejection
          return returnOperationStatus(400, errMessage);
        }
      }
      // let result = [];
      for (let i = 0; i < usersList.length; i += 1) {
        // read the user from DB and update the special fields from DB
        // for user modification
        const user = usersList[i];
        let filters;
        if (this.uniqueEmailConstraint) {

          filters = [{
            filters: [{
              field: 'name',
              operation: Filter_Operation.eq,
              value: user.name
            },
            {
              field: 'email',
              operation: Filter_Operation.eq,
              value: user.email
            }],
            operator: FilterOp_Operator.or
          }];
        } else {
          filters = getNameFilter(user.name);
        }

        const users = await super.read(ReadRequest.fromPartial({ filters }), context);
        if (users.total_count === 0) {
          // call the create method, checks all conditions before inserting
          upsertWithStatus.items.push(await this.createUser(user, context));
        } else if (users.total_count === 1) {
          let updateResponse = await this.update(UserList.fromPartial({ items: [user], subject }), context);
          upsertWithStatus.items.push(updateResponse.items[0]);
        } else if (users.total_count > 1) {
          return returnOperationStatus(400, `Invalid identifier provided user upsert, multiple users found for identifier ${user.name}`);
        }
      }
      upsertWithStatus.operation_status = { code: 200, message: 'success' };
      upsertWithStatus.total_count = upsertWithStatus?.items?.length;
      return upsertWithStatus;
    }
  }

  /**
   * Endpoint verifyPassword, checks if the provided password and user matches
   * the one found in the database.
   */
  async login(request: LoginRequest, context): Promise<DeepPartial<UserResponse>> {
    if (_.isEmpty(request) ||
      (_.isEmpty(request.identifier) || (_.isEmpty(request.password) &&
        _.isEmpty(request.token)))
    ) {
      return returnStatus(400, 'Missing credentials');
    }
    const identifier = request.identifier;
    const obfuscateAuthNErrorReason = this.cfg.get('obfuscateAuthNErrorReason') ?
      this.cfg.get('obfuscateAuthNErrorReason') : false;
    let loginIdentifierProperty = this.cfg.get('service:loginIdentifierProperty');
    // if loginIdentifierProperty is not set defaults to name / email
    if (!loginIdentifierProperty) {
      loginIdentifierProperty = ['name', 'email'];
    }
    const filters = getLoginIdentifierFilter(loginIdentifierProperty, identifier);
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
    if (users.total_count === 0) {
      if (obfuscateAuthNErrorReason) {
        return returnStatus(412, 'Invalid credentials provided, user inactive or account does not exist');
      } else {
        return returnStatus(404, 'user not found');
      }
    } else if (users.total_count > 1) {
      return returnStatus(400, `Invalid identifier provided for login, multiple users found for identifier ${identifier}`);
    }
    const user = users.items[0].payload;
    if (!user.active) {
      if (obfuscateAuthNErrorReason) {
        return returnStatus(412, 'Invalid credentials provided, user inactive or account does not exist', user.id);
      } else {
        return returnStatus(412, 'user is inactive', user.id);
      }
    }

    if (user.user_type && user.user_type === UserType.TECHNICAL_USER && request.token) {
      const tokens = user.tokens;
      for (let eachToken of tokens) {
        if (request.token === eachToken.token) {
          return { payload: user, status: { code: 200, message: 'success' } };
        }
      }
      if (obfuscateAuthNErrorReason) {
        return returnStatus(412, 'Invalid credentials provided, user inactive or account does not exist', user.id);
      } else {
        return returnStatus(401, 'password does not match', user.id);
      }
    } else if (request.password) {
      const match = password.verify(user.password_hash, request.password);
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
   */
  async unregister(request: UnregisterRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const logger = this.logger;
    const identifier = request.identifier;
    logger.silly('unregister', identifier);
    let subject = request.subject;

    const filters = getDefaultFilter(identifier);
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);

    if (users && users.total_count === 0) {
      logger.debug('user does not exist', { identifier });
      return returnOperationStatus(404, `user with identifier ${identifier} does not exist for unregistering`);
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for unregistering, multiple users found for identifier ${identifier}`);
    }

    let resources = users.items.map((e) => e.payload);
    const acsResources = await this.createMetadata(resources, AuthZAction.DELETE, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = acsResources;
      acsResponse = await checkAccessRequest(context, [{ resource: 'user', id: acsResources.map(e => e.id) }], AuthZAction.DELETE,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv unregistering user', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      // delete user
      let userID = users?.items[0]?.payload?.id;
      const unregisterStatus = await super.delete(DeleteRequest.fromPartial({
        ids: [userID]
      }), context);
      if (unregisterStatus?.status[0]?.message === 'success') {
        logger.info('user with identifier deleted', { identifier });
        await this.topics['user.resource'].emit('unregistered', userID);
      }
      return { operation_status: unregisterStatus?.status[0] };
    }
  }

  /**
   * Endpoint delete, to delete a user or list of users
   */
  async delete(request: DeleteRequest, context: any): Promise<DeepPartial<DeleteResponse>> {
    const logger = this.logger;
    let userIDs = request.ids;
    let resources = [];
    let acsResources = [];
    let subject = request.subject;
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
    if (request.collection) {
      action = AuthZAction.DROP;
      acsResources = [{ collection: request.collection }];
    }
    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = acsResources;
      acsResponse = await checkAccessRequest(context, [{ resource: 'user', id: acsResources.map(e => e.id) }], action,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for delete', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const deleteResponse = await super.delete(DeleteRequest.fromPartial({
          collection: request.collection
        }), context);
        logger.info('Users collection deleted');
        return deleteResponse;
      }
      if (userIDs.length > 0) {
        const filters = [{
          filters: [{
            field: 'id',
            operation: Filter_Operation.in,
            value: JSON.stringify(userIDs),
            type: FilterValueType.ARRAY
          }]
        }];
        let userData = await super.read({
          filters,
        } as any, {});
        if (userData?.items?.length > 0) {
          userData?.items?.forEach((user) => {
            user?.payload?.tokens?.forEach(async (tokenObj) => {
              if (tokenObj?.token) {
                await this.tokenRedisClient.del(tokenObj.token);
              }
            });
          });
        }
      }
      logger.silly('Deleting User IDs', { userIDs });
      // delete users
      const deleteStatusArr = await super.delete(DeleteRequest.fromPartial({
        ids: userIDs
      }), context);
      logger.info('Users deleted:', userIDs);
      return deleteStatusArr;
    }
  }

  async deleteUsersByOrg(request: OrgIDRequest, context): Promise<DeepPartial<DeleteUsersByOrgResponse>> {
    const orgIDs = request.org_ids;
    let subject = request.subject;
    let acsResponse: PolicySetRQResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = { id: orgIDs };
      acsResponse = await checkAccessRequest(context, [{ resource: 'user', id: orgIDs }], AuthZAction.DELETE,
        Operation.isAllowed) as PolicySetRQResponse;
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for deleteUsersByOrg', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      const deletedUserIDs = await this.modifyUsers(orgIDs, false, context, subject);
      const operation_status = returnCodeMessage(200, 'success');
      return { user_ids: deletedUserIDs.map((user) => { return user.id; }), operation_status };
    }
  }

  async findByRole(request: FindByRoleRequest, context): Promise<DeepPartial<UserListResponse>> {
    const role: string = request.role;
    if (!role) {
      return returnOperationStatus(400, 'missing role name');
    }

    const reqAttributes: any[] = request.attributes || [];
    let subject = request.subject;
    let acsResponse: PolicySetRQResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: []
      }, [{ resource: 'user' }], AuthZAction.READ, Operation.whatIsAllowed) as PolicySetRQResponse;
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for findByRole', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      const filters = [{
        filters: [{
          field: 'name',
          operation: Filter_Operation.eq,
          value: role
        }]
      }];
      const result = await this.roleService.read(ReadRequest.fromPartial({
        filters,
        fields: [{
          name: 'id',
          include: true
        }],
        subject
      }), context);

      if (_.isEmpty(result) || _.isEmpty(result.items) || result.total_count == 0) {
        return returnOperationStatus(404, `Role ${role} does not exist`);
      }

      const roleObj = result.items[0].payload;
      const id = roleObj.id;

      // note: inefficient, a custom AQL query should be the final solution
      let custom_queries, custom_arguments;
      if (acsResponse?.custom_query_args?.length > 0) {
        custom_queries = acsResponse.custom_query_args[0].custom_queries;
        custom_arguments = acsResponse.custom_query_args[0].custom_arguments;
      }
      const userResult = await super.read(ReadRequest.fromPartial({
        custom_queries,
        custom_arguments
      }), context);
      if (_.isEmpty(userResult) || _.isEmpty(userResult.items) || userResult.total_count == 0) {
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
        if (techUsersCfg?.length > 0) {
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
          this.logger.error('Unexpected error occurred while loading email templates', { code: err.code, message: err.message, stack: err.stack });
        }
      }
    } else {
      this.logger.info('Email sending is disabled');
    }
  }

  private makeActivationEmailData(user: DeepPartial<User>): any {
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

  private makeConfirmationData(user: DeepPartial<User>, passwordChange: boolean, identifier: string, email?: string): any {
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

  private makeRenderRequestMsg(user: DeepPartial<User>, subject: any, body: any,
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
      payloads: [{
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
    await this.modifyUsers(orgIDs, true, {});
  }

  disableAC() {
    try {
      this.cfg.set('authorization:enabled', false);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught disabling authorization:', { code: err.code, message: err.message, stack: err.stack });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  enableAC() {
    try {
      this.cfg.set('authorization:enabled', this.authZCheck);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught enabling authorization', { code: err.code, message: err.message, stack: err.stack });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  private async modifyUsers(orgIds: string[], deactivate: boolean,
    context: any, subject?: any): Promise<User[]> {
    const deactivateUsers = [];
    const roleID = await this.getNormalUserRoleID(context, subject);
    for (let org of orgIds) {
      const result = await super.read(ReadRequest.fromPartial({
        custom_queries: ['filterByRoleAssociation'],
        custom_arguments: {
          value: Buffer.from(JSON.stringify({
            userRole: roleID,
            scopingEntity: this.cfg.get('urns:organization'),
            scopingInstances: [org]
          }))
        }
      }), {});
      // The above custom query is to avoid to retreive all the users in DB
      // and get only those belong to orgIds and then check below to see if
      // that org is the only one present before actually deleting the user
      const users = result.items || [];
      for (let i = 0; i < users?.length; i += 1) {
        const user: User = _.cloneDeep(users[i].payload);
        user.active = false;
        deactivateUsers.push(user);
      }
    }

    if (deactivate) {
      await super.update(UserList.fromPartial({ items: deactivateUsers }), {});
    } else {
      const ids = deactivateUsers.map((user) => { return user.id; });
      this.logger.info('Deleting users:', { ids });
      await super.delete(DeleteRequest.fromPartial({ ids }), {});
    }

    return deactivateUsers;
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
      filters: [{
        field: 'name',
        operation: Filter_Operation.eq,
        value: roleName
      }]
    }];
    const role: any = await this.roleService.read(ReadRequest.fromPartial({ filters, subject }), context);
    if (role?.items?.length > 0) {
      roleID = role?.items[0]?.payload?.id;
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

    const meta: Meta = Meta.fromPartial({
      owners: !!user.meta && !_.isEmpty(user.meta.owners) ? user.meta.owners : [
        {
          id: OWNER_INDICATOR_ENTITY,
          value: USER_URN,
          attributes: [{
            id: OWNER_SCOPING_INSTANCE,
            value: userID
          }]
        }
      ],
      modified_by: !!user.meta && !_.isEmpty(user.meta.modified_by) ? user.meta.modified_by : user.id
    });

    user.id = userID;
    user.meta = meta;
    return user;
  }

  /**
   * reads meta data from DB and updates owners information in resource if action is UPDATE / DELETE
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
      // add user and subject scope as default owners
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization,
          attributes: [{
            id: urns.ownerInstance,
            value: subject.scope
          }]
        });
    }

    if (resources) {
      for (let resource of resources) {
        if (!resource.meta) {
          resource.meta = {};
        }
        if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
          const filters = [{
            filters: [{
              field: 'id',
              operation: Filter_Operation.eq,
              value: resource.id
            }]
          }];
          let result = await super.read(ReadRequest.fromPartial({ filters }), {});
          // update owners info
          if (result?.items?.length === 1) {
            let item = result.items[0].payload;
            resource.meta.owners = item.meta.owners;
          } else if (result?.items?.length === 0) {
            if (_.isEmpty(resource.id)) {
              resource.id = uuid.v4().replace(/-/g, '');
            }
            let ownerAttributes;
            if (!resource.meta.owners) {
              ownerAttributes = _.cloneDeep(orgOwnerAttributes);
            } else {
              ownerAttributes = resource.meta.owners;
            }
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user,
                attributes: [{
                  id: urns.ownerInstance,
                  value: resource.id
                }]
              });
            resource.meta.owners = ownerAttributes;
          }
        } else if (action === AuthZAction.CREATE) {
          if (_.isEmpty(resource.id)) {
            resource.id = uuid.v4().replace(/-/g, '');
          }
          let ownerAttributes;
          if (!resource.meta.owners) {
            ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          } else {
            ownerAttributes = resource.meta.owners;
          }
          ownerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user,
              attributes: [{
                id: urns.ownerInstance,
                value: resource.id
              }]
            });
          resource.meta.owners = ownerAttributes;
        }
      }
    }
    return resources;
  }

  private async makeUserForInvitationData(user, invited_by_user_identifier): Promise<any> {
    let invitedByUser;
    const filters = [{
      filters: [
        {
          field: 'name',
          operation: Filter_Operation.eq,
          value: invited_by_user_identifier
        },
        {
          field: 'email',
          operation: Filter_Operation.eq,
          value: invited_by_user_identifier
        }
      ],
      operator: FilterOp_Operator.or
    }];
    const invitedByUsers = await super.read(ReadRequest.fromPartial({ filters }), {});
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

  async sendActivationEmail(request: SendActivationEmailRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const { identifier, subject } = request;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
    if (users.total_count === 1) {
      const user = users.items[0].payload;
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

  async sendInvitationEmail(request: SendInvitationEmailRequest, context): Promise<DeepPartial<OperationStatusObj>> {
    const { identifier, invited_by_user_identifier, subject } = request;
    let user;
    // check for the identifier against name or email in DB
    const filters = getDefaultFilter(identifier);
    const users = await super.read(ReadRequest.fromPartial({ filters }), context);
    if (users.total_count === 1) {
      user = users.items[0].payload;
    } else if (users.total_count === 0) {
      return returnOperationStatus(404, `user with identifier ${identifier} not found`);
    } else if (users.total_count > 1) {
      return returnOperationStatus(400, `Invalid identifier provided for send invitation email, multiple users found for identifier ${identifier}`);
    }

    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = { id: user.id, identifier, invited_by_user_identifier, meta: user.meta };
      acsResponse = await checkAccessRequest(context, [{ resource: 'user', id: user.id }],
        AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for sendInvitationEmail', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
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

export class RoleService extends ServiceBase<RoleListResponse, RoleList> implements RoleServiceImplementation {

  logger: Logger;
  redisClient: RedisClientType<any, any>;
  cfg: any;
  authZ: ACSAuthZ;
  authZCheck: boolean;

  constructor(cfg: any, db: any, roleTopic: kafkaClient.Topic, logger: any,
    isEventsEnabled: boolean, authZ: ACSAuthZ) {
    let resourceFieldConfig;
    if (cfg.get('fieldHandlers')) {
      resourceFieldConfig = cfg.get('fieldHandlers');
      resourceFieldConfig['bufferFields'] = resourceFieldConfig?.bufferFields?.roles;
      if (cfg.get('fieldHandlers:timeStampFields')) {
        resourceFieldConfig['timeStampFields'] = [];
        for (let timeStampFiledConfig of cfg.get('fieldHandlers:timeStampFields')) {
          if (timeStampFiledConfig.entities.includes('roles')) {
            resourceFieldConfig['timeStampFields'].push(...timeStampFiledConfig.fields);
          }
        }
      }
    }
    super('role', roleTopic, logger, new ResourcesAPIBase(db, 'roles', resourceFieldConfig), isEventsEnabled);
    this.logger = logger;
    const redisConfig = cfg.get('redis');
    redisConfig.database = cfg.get('redis:db-indexes:db-subject');
    this.redisClient = createClient(redisConfig);
    this.redisClient.on('error', (err) => logger.error('Redis client error in subject store', err));
    this.redisClient.connect().then((val) =>
      logger.info('Redis client connection successful for subject store')).catch(err => logger.error('Redis connection error', err));
    this.authZ = authZ;
    this.cfg = cfg;
    this.authZCheck = this.cfg.get('authorization:enabled');
  }

  async stop(): Promise<void> {
    await this.redisClient.quit();
  }

  async create(request: RoleList, context: any): Promise<DeepPartial<RoleListResponse>> {
    if (!request || !request.items || request?.items?.length == 0) {
      return returnOperationStatus(400, 'No role was provided for creation');
    }
    let subject = request.subject;
    const acsResources = await this.createMetadata(request.items, AuthZAction.CREATE, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: acsResources
      }, [{ resource: 'role', id: acsResources.map(e => e.id) }], AuthZAction.CREATE, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for creating role', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      let createRoleResponse;
      try {
        createRoleResponse = super.create(request, context);
      } catch (err) {
        return returnOperationStatus(err.code, err.message);
      }
      return createRoleResponse;
    }
  }

  /**
   * Extends ServiceBase.read()
   */
  async read(request: ReadRequest, context: any): Promise<DeepPartial<RoleListResponse>> {
    let subject = request.subject;
    let acsResponse: PolicySetRQResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: []
      }, [{ resource: 'role' }], AuthZAction.READ, Operation.whatIsAllowed) as PolicySetRQResponse;
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for read', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    const readRequest = request;
    if (acsResponse?.custom_query_args?.length > 0) {
      readRequest.custom_queries = acsResponse.custom_query_args[0].custom_queries;
      readRequest.custom_arguments = acsResponse.custom_query_args[0].custom_arguments;
    }
    if (acsResponse.decision === Response_Decision.PERMIT) {
      return await super.read(readRequest, context);
    }
  }

  /**
   * Extends the generic update operation in order to update any fields
   */
  async update(request: RoleList, context: any): Promise<DeepPartial<RoleListResponse>> {
    if (_.isNil(request) || _.isNil(request.items) || _.isEmpty(request.items)) {
      return returnOperationStatus(400, 'No items were provided for update');
    }

    const items = request.items;
    let subject = request.subject;
    // update owners information
    const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: acsResources
      }, [{ resource: 'role', id: acsResources.map(e => e.id) }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for update', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      for (let i = 0; i < items?.length; i += 1) {
        // read the role from DB and check if it exists
        const role = items[i];
        const filters = [{
          filters: [{
            field: 'id',
            operation: Filter_Operation.eq,
            value: role.id
          }]
        }];
        const roles = await super.read(ReadRequest.fromPartial({ filters }), context);
        if (roles.total_count === 0) {
          return roles;
        }
        const rolesDB = roles.items[0].payload;
        // update meta information from existing Object in case if its
        // not provided in request
        if (!role.meta) {
          role.meta = rolesDB.meta as Meta;
        } else if (role.meta && _.isEmpty(role.meta.owners)) {
          role.meta.owners = rolesDB.meta.owners as Attribute[];
        }
        // check for ACS if owners information is changed
        if (!_.isEqual(role.meta.owners, rolesDB.meta.owners)) {
          let acsResponse: DecisionResponse;
          try {
            if (!context) { context = {}; };
            context.subject = subject;
            context.resources = role;
            acsResponse = await checkAccessRequest(context, [{ resource: 'role', id: role.id }], AuthZAction.MODIFY,
              Operation.isAllowed, false);
          } catch (err) {
            this.logger.error('Error occurred requesting access-control-srv for update', { code: err.code, message: err.message, stack: err.stack });
            return returnOperationStatus(err.code, err.message);
          }
          if (acsResponse.decision != Response_Decision.PERMIT) {
            return { operation_status: acsResponse.operation_status };
          }
        }
      }
      return super.update(request, context);
    }
  }

  /**
   * Extends the generic upsert operation in order to upsert any fields
   */
  async upsert(request: RoleList, context: any): Promise<DeepPartial<RoleListResponse>> {
    if (_.isNil(request) || _.isNil(request.items) || _.isEmpty(request.items)) {
      return returnOperationStatus(400, 'No items were provided for upsert');
    }

    let subject = request.subject;
    const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: acsResources
      }, [{ resource: 'role', id: acsResources.map(e => e.id) }], AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for upsert', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      return super.upsert(request, context);
    }
  }

  /**
   * Endpoint delete, to delete a role or list of roles
   */
  async delete(request: DeleteRequest, context: any): Promise<DeepPartial<DeleteResponse>> {
    const logger = this.logger;
    let roleIDs = request.ids;
    let resources = {};
    let subject = request.subject;
    let acsResources;
    if (!_.isEmpty(roleIDs)) {
      Object.assign(resources, { id: roleIDs });
      acsResources = await this.createMetadata({ id: roleIDs }, AuthZAction.DELETE, subject);
    }
    if (request.collection) {
      acsResources = [{ collection: request.collection }];
    }
    let acsResponse: DecisionResponse;
    try {
      if (!context) { context = {}; };
      context.subject = subject;
      context.resources = acsResources;
      acsResponse = await checkAccessRequest({
        ...context,
        subject,
        resources: acsResources
      }, [{ resource: 'role', id: acsResources.map(e => e.id) }], AuthZAction.DELETE, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv for delete', { code: err.code, message: err.message, stack: err.stack });
      return returnOperationStatus(err.code, err.message);
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    if (acsResponse.decision === Response_Decision.PERMIT) {
      if (request.collection) {
        // delete collection and return
        const deleteResponse = await super.delete(DeleteRequest.fromPartial({
          collection: request.collection
        }), context);
        logger.info('Role collection deleted:');
        return deleteResponse;
      }
      logger.silly('deleting Role IDs:', { roleIDs });
      // delete users
      const deleteResponse = await super.delete(DeleteRequest.fromPartial({
        ids: roleIDs
      }), context);
      logger.info('Roles deleted:', { roleIDs });
      return deleteResponse;
    }
  }

  async verifyRoles(role_associations: RoleAssociation[]): Promise<boolean> {
    // checking if user roles are valid
    if (role_associations?.length > 0) {
      for (let roleAssociation of role_associations) {
        const roleID = roleAssociation.role;
        const filters = [{
          filters: [{
            field: 'id',
            operation: Filter_Operation.eq,
            value: roleID
          }]
        }];
        const result = await super.read(ReadRequest.fromPartial({ filters }), {});

        if (!result || !result.items || result.total_count == 0) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * reads meta data from DB and updates owners information in resource if action is UPDATE / DELETE
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
      // add user and subject scope as default owners
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization,
          attributes: [{
            id: urns.ownerInstance,
            value: subject.scope
          }]
        });
    }

    for (let resource of resources) {
      if (!resource.meta) {
        resource.meta = {};
      }
      if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
        const filters = [{
          filters: [{
            field: 'id',
            operation: Filter_Operation.eq,
            value: resource.id
          }]
        }];
        let result = await super.read(ReadRequest.fromPartial({
          filters
        }), {});
        // update owners info
        if (result?.items?.length === 1) {
          let item = result.items[0].payload;
          resource.meta.owners = item.meta.owners;
        } else if (result?.items?.length === 0) {
          if (_.isEmpty(resource.id)) {
            resource.id = uuid.v4().replace(/-/g, '');
          }
          let ownerAttributes;
          if (!resource.meta.owners) {
            ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          } else {
            ownerAttributes = resource.meta.owners;
          }
          if (subject && subject.id) {
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user,
                attributes: [{
                  id: urns.ownerInstance,
                  value: resource.id
                }]
              });
          }
          resource.meta.owners = ownerAttributes;
        }
      } else if (action === AuthZAction.CREATE && !resource.meta.owners) {
        if (_.isEmpty(resource.id)) {
          resource.id = uuid.v4().replace(/-/g, '');
        }
        let ownerAttributes;
        if (!resource.meta.owners) {
          ownerAttributes = _.cloneDeep(orgOwnerAttributes);
        } else {
          ownerAttributes = resource.meta.owners;
        }
        if (subject && subject.id) {
          ownerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user,
              attributes: [{
                id: urns.ownerInstance,
                value: subject.id
              }]
            });
        }
        resource.meta.owners = ownerAttributes;
      }
    }
    return resources;
  }

  disableAC() {
    try {
      this.cfg.set('authorization:enabled', false);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught disabling authorization', { code: err.code, message: err.message, stack: err.stack });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  enableAC() {
    try {
      this.cfg.set('authorization:enabled', this.authZCheck);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught enabling authorization', { code: err.code, message: err.message, stack: err.stack });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }
}
