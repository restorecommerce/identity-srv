import * as _ from 'lodash-es';
import {
  AuthZAction, accessRequest, DecisionResponse, Operation, PolicySetRQResponse, ACSClientContext,
  ACSClientOptions
} from '@restorecommerce/acs-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createClient, createChannel } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import bcrypt from 'bcryptjs';
import {
  DeepPartial,
  FilterOp, FilterOp_Operator,
  Filter_Operation,
  Resource
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import {
  UserServiceDefinition,
  UserServiceClient
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';
import { OperationStatus, Status } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/status.js';

// Create a ids client instance
let idsClientInstance: UserServiceClient;
const cfg = createServiceConfig(process.cwd());
export const getUserServiceClient = (): UserServiceClient => {
  if (!idsClientInstance) {
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    const logger = createLogger(loggerCfg);
    if (grpcIDSConfig) {
      const channel = createChannel(grpcIDSConfig.address);
      idsClientInstance = createClient({
        ...grpcIDSConfig,
        logger
      }, UserServiceDefinition, channel);
    }
  }
  return idsClientInstance;
};

export interface ACSResource {
  resource: string;
  id?: string | string[]; // for what is allowed operation id is not mandatory
  property?: string[];
}

/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function resolveSubject(subject: Subject) {
  if (subject) {
    const idsClient = getUserServiceClient();
    const resp = await idsClient?.findByToken({ token: subject.token });
    if (resp?.payload?.id) {
      subject.id = resp.payload.id;
    }
  }
  return subject;
}

/**
 * reads metadata from DB and updates owner information in resource if action is UPDATE / DELETE
 */
export const createMetadata = async <T extends Resource>(
  resources: T | T[],
  urns: any,
  subject?: Subject
): Promise<T[]> => {
  if (!Array.isArray(resources)) {
    resources = [resources];
  }

  let orgOwnerAttributes = [];
  for (let resource of resources ?? []) {
    if (!resource.meta) {
      resource.meta = {};
      if (subject?.id) {
        orgOwnerAttributes.push(
          {
            id: urns.ownerIndicatoryEntity,
            value: urns.user,
            attributes: [{
              id: urns.ownerInstance,
              value: subject.id
            }]
          }
        );
      } else if (subject?.token) {
        // when no subjectID is provided find the subjectID using findByToken
        subject = await resolveSubject(subject);
        if (subject?.id) {
          orgOwnerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user,
              attributes: [{
                id: urns.ownerInstance,
                value: subject.id
              }]
            });
        }
      }
      resource.meta.owners = orgOwnerAttributes;
    }
  }

  return resources;
};

export async function checkAccessRequest(ctx: ACSClientContext, resource: ACSResource[], action: AuthZAction, operation: Operation.isAllowed, useCache?: boolean): Promise<DecisionResponse>;
export async function checkAccessRequest(ctx: ACSClientContext, resource: ACSResource[], action: AuthZAction, operation: Operation.whatIsAllowed, useCache?: boolean): Promise<PolicySetRQResponse>;

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
export async function checkAccessRequest(
  ctx: ACSClientContext,
  resource: ACSResource[],
  action: AuthZAction,
  operation: Operation,
  useCache = true
): Promise<DecisionResponse | PolicySetRQResponse> {
  const subject = ctx.subject as Subject;
  // resolve subject id using findByToken api and update subject with id
  if (!subject?.id && subject?.token) {
    await resolveSubject(subject);
  }

  let result: DecisionResponse | PolicySetRQResponse;
  try {
    result = await accessRequest(
      subject, resource, action, ctx,
      {
        operation,
        useCache,
        roleScopingEntityURN: cfg?.get('authorization:urns:roleScopingEntityURN')
      } as ACSClientOptions
    );
  } catch (err: any) {
    return {
      decision: Response_Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  return result;
}

export const password = {
  hash: (pw: string): string => {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(pw, salt);
    return hash;
  },
  verify: (password_hash: string, pw: string) => {
    return bcrypt.compareSync(pw, password_hash);
  }
};

export const marshallProtobufAny = (msg: any): any => {
  return {
    type_url: 'identity.rendering.renderRequest',
    value: Buffer.from(JSON.stringify(msg))
  };
};

export const unmarshallProtobufAny = (msg: any, logger: any): any => {
  try {
    if (msg.value) {
      return JSON.parse(msg.value.toString());
    }
  } catch (error) {
    logger.error('Error unmarshalling JSON', msg);
  }
};

export const getDefaultFilter = (identifier: string): DeepPartial<FilterOp[]> => [{
  filters: [
    {
      field: 'name',
      operation: Filter_Operation.eq,
      value: identifier
    },
    {
      field: 'email',
      operation: Filter_Operation.eq,
      value: identifier
    }],
  operator: FilterOp_Operator.or
}];

export const getNameFilter = (userName: string) => [{
  filters: [{
    field: 'name',
    operation: Filter_Operation.eq,
    value: userName
  }]
}];

export const getLoginIdentifierFilter = (
  loginIdentifiers: any,
  value: string
): FilterOp[] => {
  if (typeof loginIdentifiers === 'string') {
    return [{
      filters: [{
        field: loginIdentifiers,
        operation: Filter_Operation.eq,
        value
      }]
    }];
  } else if (Array.isArray(loginIdentifiers)) {
    return [{
      filters: loginIdentifiers.map(
        field => ({
          field,
          operation: Filter_Operation.eq,
          value
        })
      ),
      operator: FilterOp_Operator.or
    }];
  }
};

export const returnOperationStatus = (code: number, message: string) => ({
  operation_status: {
    code: code ?? 500,
    message
  } as OperationStatus
});

export const returnStatus = (
  code: number,
  message: string,
  id?: string
) => ({
  status: {
    id,
    code: code ?? 500,
    message
  } as Status
});

export const returnCodeMessage = (
  code: number,
  message: string
): OperationStatus => ({
  code: code ?? 500,
  message
});

interface CodeIdMsgObj {
  code: number;
  message: string;
  id?: string;
}

export const returnStatusArray = (
  codeIdMsgObj: CodeIdMsgObj[]
) => ({
  status: [...codeIdMsgObj]
});

/**
 * accessResponse returned from `acs-client` contains the filters for the list of
 * resources requested and it returns resource filter map, below api
 * returns applicable `Filters[]` for the specified resource, it iterates through
 * the ACS response and returns the applicable `Filters[]` for the resource.
 * @param accessResponse ACS response
 * @param enitity enitity name
 */
export const getACSFilters = (
  accessResponse: PolicySetRQResponse,
  resource: string
): FilterOp[] => accessResponse?.filters?.find(
  (e) => e?.resource === resource
    && e?.filters[0]?.filters?.length
)?.filters ?? [];