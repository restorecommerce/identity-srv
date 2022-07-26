import { BaseDocument, FilterOp } from '@restorecommerce/resource-base-interface/lib/core/interfaces';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth';

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

export interface UserPayload {
  payload?: User;
  status?: {
    code: number;
    message: string;
  };
}

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface UserInviationReq {
  identifier: string;
  password: string;
  activation_code: string;
}

export interface FindUser {
  id?: string;
  email?: string;
  name?: string;
  subject?: Subject;
  filters?: FilterOp [];
  custom_queries?: string[];
  custom_arguments?: any;
}

export interface FindUserByToken {
  token?: string;
}

export interface ActivateUser {
  identifier: string;
  activation_code: string;
  subject?: Subject;
}

export interface ConfirmEmailChange {
  identifier: string;
  activation_code: string;
  subject?: Subject;
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
  identifier: string;
  new_email: string;
  subject?: Subject;
}

export interface Role extends BaseDocument {
  name: string;
  description: string;
}

export interface ForgotPassword {
  identifier: string; // username
  subject?: Subject;
}

export interface SendInvitationEmailRequest {
  identifier: string; // username or email
  invited_by_user_identifier: string; // inviting user's username or email
  subject?: Subject;
}

export interface UnregisterRequest {
  identifier: string; // username or email
  subject?: Subject;
}

export interface SendActivationEmailRequest {
  identifier: string; // username or email
  subject?: Subject;
}

export interface ChangePassword {
  identifier: string; // username or email
  password: string;
  new_password?: string;
  subject?: Subject;
}

export interface ConfirmPasswordChange {
  identifier: string;
  password: string;
  activation_code: string;
  subject?: Subject;
}

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface Response {
  payload: any;
  count: number;
  status?: {
    code: number;
    message: string;
  };
}

export interface FilterType {
  field?: string;
  operation?: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'in' | 'isEmpty' | 'iLike';
  value?: string;
  type?: 'string' | 'boolean' | 'number' | 'date' | 'array';
}
