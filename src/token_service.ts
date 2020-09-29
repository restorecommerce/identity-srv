import { Logger, errors } from '@restorecommerce/chassis-srv';
import { ACSAuthZ, PermissionDenied, AuthZAction, Decision, Subject, ApiKey } from '@restorecommerce/acs-client';
import { Topic } from '@restorecommerce/kafka-client';
import { AccessResponse, getSubjectFromRedis, checkAccessRequest } from './utils';
import { RedisClient } from 'redis';
import * as _ from 'lodash';

interface TokenData {
  id: string;
  payload: any;
  expires_in: number;
  subject?: Subject;
  api_key?: ApiKey;
}

interface ReqTokenData {
  request: TokenData;
}

const unmarshallProtobufAny = (msg: any): any => JSON.parse(msg.value.toString());

const marshallProtobufAny = (msg: any): any => {
  if (msg) {
    return {
      type_url: '',
      value: Buffer.from(JSON.stringify(msg))
    };
  }
};

const grantKeyFor = (id: any) => {
  return `grant:${id}`;
};

const userCodeKeyFor = (userCode: any) => {
  return `userCode:${userCode}`;
};

const uidKeyFor = (uid: any) => {
  return `uid:${uid}`;
};

export class TokenService {
  logger: Logger;
  cfg: any;
  authZ: ACSAuthZ;
  redisClient: RedisClient;
  constructor(cfg: any, logger: any, authZ: ACSAuthZ, tokenRedisClient: RedisClient) {
    this.logger = logger;
    this.authZ = authZ;
    this.cfg = cfg;
    this.redisClient = tokenRedisClient;
  }

  private getKey(id: string) {
    return `AccessToken:${id}`;
  }

  /**
   * Store / Upsert accessToken Data to redis
   *
  **/
  async upsert(call: ReqTokenData, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('No id was provided for creat / upsert');
    }

    const tokenData = call.request;
    let subject = await getSubjectFromRedis(call);
    call.request = await this.createMetadata(tokenData, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, tokenData, AuthZAction.CREATE,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const multi = this.redisClient.multi();
      const key = this.getKey(tokenData.id);
      const payload = unmarshallProtobufAny(tokenData.payload);
      tokenData.payload = JSON.stringify(payload);

      if (payload.grantId) {
        const grantKey = grantKeyFor(payload.grantId);
        multi.rpush(grantKey, key);
        // if you're seeing grant key lists growing out of acceptable proportions consider using LTRIM
        // here to trim the list to an appropriate length
        const ttl = await this.redisClient.ttl(grantKey);
        if (tokenData.expires_in > ttl) {
          multi.expire(grantKey, tokenData.expires_in);
        }
      }

      if (payload.userCode) {
        const userCodeKey = userCodeKeyFor(payload.userCode);
        multi.set(userCodeKey, tokenData.id);
        multi.expire(userCodeKey, tokenData.expires_in);
      }

      if (payload.uid) {
        const uidKey = uidKeyFor(payload.uid);
        multi.set(uidKey, tokenData.id);
        multi.expire(uidKey, tokenData.expires_in);
      }
      const response = new Promise((resolve, reject) => {
        multi.exec((err, res) => {
          if (err) {
            reject(err);
            return;
          }
          if (res) {
            const response = {
              status: `AccessToken data ${tokenData.id} persisted successfully`
            };
            resolve(response);
          }
        }).catch(reject);
      });
      return marshallProtobufAny(response);
    }
  }

  /**
   * Find access token data from redis by id
   *
  **/
  async find(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('No id was provided for find');
    }

    let subject = await getSubjectFromRedis(call);
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request, AuthZAction.READ,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const data: any = await new Promise((resolve, reject) => {
        const key = this.getKey(call.request.id);
        this.redisClient.get(key, async (err, reply) => {
          if (err) {
            reject(err);
            return;
          }

          if (reply) {
            this.logger.debug('Found AccessToken in redis', key);
            resolve(JSON.parse(reply));
          } else {
            resolve();
          }
        }).catch(reject);
      });

      if (!data) {
        return undefined;
      }

      if (typeof data === 'string') {
        return JSON.parse(data);
      } else if (data && typeof data === 'object') {
        const { payload, ...rest } = data;
        return marshallProtobufAny({
          ...rest,
          ...JSON.parse(payload),
        });
      }
    }
  }

  /**
   * Find access token data from redis by uid
   *
  **/
  async findByUid(call: any, context: any): Promise<any> {
    if (!call || !call.request || !call.request.uid) {
      throw new errors.InvalidArgument('No uid was provided for find operation');
    }

    let subject = await getSubjectFromRedis(call);
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request, AuthZAction.READ,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const id = await new Promise((resolve, reject) => {
        const key = uidKeyFor(call.request.uid);
        this.redisClient.get(key, (err, reply) => {
          if (err) {
            reject(err);
            return;
          }

          if (reply) {
            this.logger.debug('Found UID key in redis', key);
            resolve(JSON.parse(reply));
          } else {
            resolve();
          }
        }).catch(reject);
      });
      return await this.find({ request: { id, subject } });
    }
  }

  /**
   * Find access token data from redis by userCode
   *
  **/
  async findByUserCode(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.uid) {
      throw new errors.InvalidArgument('UserCode was not provided for find operation');
    }

    let subject = await getSubjectFromRedis(call);
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request, AuthZAction.READ,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const id = await new Promise((resolve, reject) => {
        const key = userCodeKeyFor(call.request.user_code);
        this.redisClient.get(key, (err, reply) => {
          if (err) {
            reject(err);
            return;
          }

          if (reply) {
            this.logger.debug('Found UserCode key in redis', key);
            resolve(JSON.parse(reply));
          } else {
            resolve();
          }
        }).catch(reject);
      });
      return await this.find({ request: { id, subject } });
    }
  }

  /**
   * Delete access token data from redis by id
   *
  **/
  async destroy(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.uid) {
      throw new errors.InvalidArgument('Key was not provided for delete operation');
    }

    let subject = await getSubjectFromRedis(call);
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request, AuthZAction.DELETE,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const response = await new Promise((resolve, reject) => {
        const key = this.getKey(call.request.id);
        this.redisClient.del(key, (err, reply) => {
          if (err) {
            reject(err);
            return;
          }

          if (reply) {
            const response = `Key ${key} deleted successfully`;
            this.logger.debug(response);
            resolve(response);
          } else {
            const response = `Key could not be ${key} deleted successfully`;
            resolve(response);
          }
        }).catch(reject);
        return marshallProtobufAny({ response });
      });
    }
  }

  /**
   * Delete access token data from redis by grant_id
   *
  **/
  async revokeByGrantId(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.grant_id) {
      throw new errors.InvalidArgument('GrantId was not provided for revokeByGrantId operation');
    }

    let subject = await getSubjectFromRedis(call);
    call.request = await this.createMetadata(call.request, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request, AuthZAction.DELETE,
        'token', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    if (acsResponse.decision === Decision.PERMIT) {
      const multi = this.redisClient.multi();
      const tokens: any = await new Promise((resolve, reject) => {
        const key = grantKeyFor(call.request.grant_id);
        this.redisClient.lrange(key, 0, -1, (err, res) => {
          if (err) {
            reject(err);
            return;
          } else {
            resolve(res);
          }
        }).catch(reject);
      });
      tokens.forEach((token: any) => multi.del(token));
      const response = new Promise((resolve, reject) => {
        multi.exec((err, res) => {
          if (err) {
            reject(err);
            return;
          }
          if (res) {
            const response = {
              status: `Revoke by GrantId ${call.request.grant_id} successfull`
            };
            resolve(response);
          }
        }).catch(reject);
      });
      return marshallProtobufAny(response);
    }
  }

  /**
   * Consume access token data from redis by id
   *
  **/
  async consume(call: any, context?: any): Promise<any> {
    if (!call || !call.request || !call.request.id) {
      throw new errors.InvalidArgument('ID was not provided for consume operation');
    }
    try {
      this.redisClient.set(this.getKey(call.request.id), 'consumed', Math.floor(Date.now() / 1000));
      return marshallProtobufAny({ response: `AccessToken with ID ${call.request.id} consumed` });
    } catch (err) {
      return marshallProtobufAny({ response: `error consuming access token` });
    }
  }

  /**
   * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
   */
  async createMetadata(res: any, subject?: Subject): Promise<any> {
    let resources = _.cloneDeep(res);
    let orgOwnerAttributes = [];
    if (!_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    for (let resource of resources) {
      if (!resource.meta) {
        resource.meta = {};
      }
      if (subject.id) {
        orgOwnerAttributes.push(
          {
            id: urns.ownerIndicatoryEntity,
            value: urns.user
          },
          {
            id: urns.ownerInstance,
            value: subject.id
          });
      }
      resource.meta.owner = orgOwnerAttributes;
    }
    return resources;
  }
}