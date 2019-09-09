# identity-srv

<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fidentity%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/identity-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/identity-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/identity-srv?branch=master)

[version]: http://img.shields.io/npm/v/identity-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/identity-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/identity-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/identity-srv/master.svg?style=flat-square

This microservice' features:

- Management of _User Accounts_ and _Roles_ entities
- User-to-Role associations with arbitrary scoping
- User account creation (self-service, by privileged user, by invitation)
- Password change (self-service)
- Password recovery (self-service)
- Un-registration (self-service)
- Customizable, optional email notifications to drive processes

The microservice exposes a [gRPC](https://grpc.io/docs) interface for handling CRUD operations and user-specific functionalities.
This service persists user data within an [ArangoDB](https://www.arangodb.com/) instance and generic asynchronous communication is performed with [Apache Kafka](https://kafka.apache.org/), using an event-driven approach with message interfaces defined with [Protocol Buffers](https://developers.google.com/protocol-buffers/) (see [kafka-client](https://github.com/restorecommerce/kafka-client) for more information). Resource-handling operations are implemented and exposed through the [UserService and the RoleService](service.ts), which extend the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface) generic class `ServiceBase`.

## Configuration

The following service specific configuration properties under the `service` property are available:

- `userActivationRequired` [`true`]: if set to `false`, users do not require account activation to be able to log in and use their account
- `register` [`true`]: if set to `false`, the `Register` endpoint is disabled and users can only be created through the bulk creation method `Create`, which can be seen as an admin-only operation
- `enableEmail` [`true`]: if set to `true`, emails are sent out upon specific events, like account creation and email change
- `activationURL`: URL to show link in activation email to activate the account
- `emailConfirmationURL`: URL to show link in confirmation email to confirm email address change
- `invitationURL`: URL to show link in invitation email to accept invitation
- `hbsTemplates`: contains URLs for [Handlebars templates](https://handlebarsjs.com/) and served via external web application. These templates are used in email sent by system for different user operations like `Register`, `RequestEmailChange` and `RequestPasswordChange`.
- `minUsernameLength`: minimum length for the user's `name`
- `maxUsernameLength`: maximum length for the user's `name`

## gRPC Interface

This microservice exposes the following gRPC endpoints:

### User

A User resource.

`io.restorecommerce.user.User`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID, unique, key |
| meta | [`io.restorecommerce.meta.Meta`](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | required | Meta info |
| name | string | required | Username |
| first_name | string | required | User's first name |
| last_name | string | required | User's last name |
| email | string | required | Email address |
| new_email | string | optional | Property in which the email is stored upon an email change request until its confirmation  |
| active | bool | optional | Value is `true` if the user was successfully activated |
| activation_code | string | optional | Activation code used in the activation process (cleared after successful activation) |
| password | string | required | Raw password, not stored |
| password_hash | bytes | optional | Hashed password, stored |
| timezone | string | optional | The User's timezone setting (defaults to 'Europe/Berlin') |
| locale | string | optional | The User's locale ID |
| unauthenticated | boolean | optional | Set automatically to `true` upon user registry until its account is activated for the first time |
| guest | bool | optional | If user is guest |
| role_associations | [ ] `io.restorecommerce.user.RoleAssociation` | optional | Role associations |
| user_type | `io.restorecommerce.user.UserType` | optional | User Type - individula, organization or guest user |
| image | `io.restorecommerce.image.Image` | optional | Image |
| invite | bool | optional | used for user invitation |
| invited_by_user_name | string | optional | inviting User's name |
| invited_by_user_first_name | string | optional | inviting User's first name |
| invited_by_user_last_name | string | optional | inviting User's last name |

`io.restorecommerce.user.RoleAssociation`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| role | string | required | Role ID |
| Attribute | [ ] `io.restorecommerce.user.RoleAssociation.Attribute` | optional | Attributes associated with the User's role |

`io.restorecommerce.user.RoleAssociation.Attribute`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | optional | attribute identifier |
| value | string | optional | attribute value |

`io.restorecommerce.user.UserType`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| INDIVIDUAL_USER | enum | optional | individual User |
| ORG_USER  | enum | optional | organizational User |
| GUEST | enum | optional | guest User |

`io.restorecommerce.image.Image`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | optional | image identifier |
| caption | string | optional | image caption |
| filename | string | optional | image file name |
| content_type | string | optional | image content type |
| url | string | required | image URL |
| url | string | optional | image width |
| url | string | optional | image height |
| url | string | optional | image length |

A list of User resources.

`io.restorecommerce.user.UserList`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| items | [ ]`io.restorecommerce.user.User` | required | List of Users |
| total_count | number | optional | number of Users |

#### CRUD Operations

The microservice exposes the below CRUD operations for creating or modifying User resources.

`io.restorecommerce.user.Service`

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | `io.restorecommerce.user.UserList` | `io.restorecommerce.user.UserList` | Create a list of User resources |
| Read | `io.restorecommerce.resourcebase.ReadRequest` | `io.restorecommerce.user.UserList` | Read a list of User resources |
| Update | `io.restorecommerce.user.UserList` | `io.restorecommerce.user.UserList` | Update a list of User resources |
| Delete | `io.restorecommerce.resourcebase.DeleteRequest` | Empty | Delete a list of User resources |
| Upsert | `io.restorecommerce.user.UserList` | `io.restorecommerce.user.UserList` | Create or Update a list of User resources |

#### `Register`

Used to register a User.
Requests are performed providing `io.restorecommerce.user.RegisterRequest` protobuf message as input and responses are a `io.restorecommerce.user.User` message. If a valid configuration for retrieving email-related [handlebars](http://handlebarsjs.com/) templates from a remote server is provided, an email request is performed upon a successful registration. Such config should correspond to the `service/hbsTemplates` element in the config files. The email contains the user's activation code. Email requests are done by emitting a`sendEmail` notification event, which is consumed by [notification-srv](http://github.com/restorecommerce/notification-srv) to send an email.
Please note that this email operation also implies template rendering, which is performed by emitting a `renderRequest` event, which is consumed by the [rendering-srv](http://github.com/restorecommerce/rendering-srv). Therefore, the email sending step requires both a running instance of the rendering-srv and the notification-srv (or similar services which implement the given interfaces) as well as a remote server containing a set of email templates. This is decoupled from the service's core functionalities and it is automatically disabled if no templates configuration is provided.

Moreover, the `Register` operation itself is optional and one can enable or disable it through the `service.register` configuration value. If disabled, the only endpoint for user creation is `Create`.

`io.restorecommerce.user.RegisterRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| guest | bool | optional | Guest user, default value is `false` |
| name | string | required | Username |
| first_name | string | required | User's first name |
| last_name | string | required | User's last name |
| email | string | required | User email ID |
| password | string | required | User password |
| creator | string | optional | User id of the creator |
| timezone | string | optional | The User's timezone setting (defaults to 'Europe/Berlin') |
| locale | string | optional | The User's locale setting (defaults to 'de-DE') |
| role_associations | `io.restorecommerce.user.RoleAssociation`[] | required | A list of roles with their associated attributes |

#### `Activate`

Used to activate a User. The `service.userActivationRequired` config value turns the user activation process on or off. Requests are performed providing `io.restorecommerce.user.ActiveRequest` protobuf message as input and responses are a `google.protobuf.Empty` message.

`io.restorecommerce.user.ActiveRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| activation_code | string | required | activation code for User |

#### `ChangePassword`

Used to change password for the User (User should be activated to perform this operation).
Requests are performed providing `io.restorecommerce.user.ChangePasswordRequest` protobuf message as input and responses are a `io.restorecommerce.user.User` message.

`io.restorecommerce.user.ChangePasswordRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| password | string | required | old password |
| new_password | string | required | new password |

#### `RequestPasswordChange`

Used to change password for the User in case they forget it.
It generates and persists an activation code for the user and issues an email with a confirmation URL.
Requests are performed providing `io.restorecommerce.user.RequestPasswordChangeRequest` protobuf message as input and responses are `google.protobuf.Empty` messages. Either user name or email should be specified upon the request.

`io.restorecommerce.user.RequestPasswordChangeRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | optional | User name |
| email | string | optional | User email |

#### `ConfirmPasswordChange`

Used to confirm the user's password change request. The input is a `io.restorecommerce.user.ConfirmPasswordChangeRequest` message and the response is a `google.protobuf.Empty` message. If the received activation code matches the previously generated activation code, the stored password hash value is replaced by a hash derived from the new password and the activation code is reset.

`io.restorecommerce.user.ConfirmPasswordChangeRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | required | User name |
| activation_code | string | required | Activation code  |
| password | string | required | New password |

#### `RequestEmailChange`

Used to change the user's email. Requests are performed providing the `io.restorecommerce.user.RequestEmailChange` protobuf message as input and responses is a `google.protobuf.Empty` message. when receiving this request, the service assigns the new email value to the user's `new_email` property and triggers an email with a confirmation URL containing a newly-generated activation code.

`io.restorecommerce.user.ChangeEmailRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| email | string | required | New email  |

#### `ConfirmEmailChange`

Used to confirm the user's email change request. The input is a `io.restorecommerce.user.ConfirmEmailChange` message and the response is a `google.protobuf.Empty` message. If the received activation code matches the previously generated activation code, the value assigned to the `new_email` property is then assigned to the `email` property and `new_email` is set to null.

`io.restorecommerce.user.ConfirmEmailChange`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | required | User name |
| activation_code | string | required | Activation code  |

#### `ConfirmUserInvitation`

Used to confirm user invitation. Requests are performed providing `io.restorecommerce.user.ConfirmUserInvitationRequest` protobuf message as input and responses are a `google.protobuf.Empty` message. For `Create` operation if the invite flag `io.restorecommerce.user.invite` is set to true then an inviation mail would be sent if `invitationURL` and `hbsTemplates` configuration values are setup accordingly.

`io.restorecommerce.user.ConfirmUserInvitationRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | required | User name |
| password | string | required | User password |
| activation_code | string | required | User's activation_code sent via email |

#### `Login`

Used to verify the User name or email with password and return User's information in case the operation is successful. Requests are performed providing `io.restorecommerce.user.LoginRequest` protobuf message as input and the response is `io.restorecommerce.user.User` message.

`io.restorecommerce.user.LoginRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| identifier | string | required | User name or User email |
| password | string | required | Raw password |

#### `Unregister`

Used to unregister a User. Requests are performed providing `io.restorecommerce.user.UnregisterRequest` protobuf message as input and responses are a `google.protobuf.Empty` message.

`io.restorecommerce.user.UnregisterRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |

#### `Find`

A simplified version of `read`, which only filters users by username, email and/or ID. Requests are performed providing `io.restorecommerce.user.FindRequest` protobuf message as input and responses contain a list  `io.restorecommerce.user.User` messages.

`io.restorecommerce.user.FindRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| name | string | required | User name |
| email | string | required | User EmailID |

#### `FindByRole`

A custom endpoint in order to filter a user by its role and any attributes associated with it. Requests are performed providing `io.restorecommerce.user.FindByRoleRequest` protobuf message as input and responses contain a list  `io.restorecommerce.user.User` messages.

`io.restorecommerce.user.FindRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| role | string | required | Role name |
| attributes | `io.restorecommerce.user.RoleAssociation.Attribute`[] | optional | Role attributes |

### `Role`

A Role resource.

`io.restorecommerce.role.Role`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | Role identifier |
| name | string | required | specifies the Role of the User |
| description | string | optional | Role description |
| created | double | optional | Role created date |
| modified | double | optional | Role modified date |

#### `CRUD Operations`

The microservice exposes the below CRUD operations for creating or modifying Role resources.

`io.restorecommerce.role.Service`

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | `io.restorecommerce.user.RoleList` | `io.restorecommerce.user.RoleList` | Create a list of Role resources |
| Read | `io.restorecommerce.resourcebase.ReadRequest` | `io.restorecommerce.user.RoleList` | Read a list of Role resources |
| Update | `io.restorecommerce.user.RoleList` | `io.restorecommerce.user.RoleList` | Update a list of Role resources |
| Delete | `io.restorecommerce.resourcebase.DeleteRequest` | Empty | Delete a list of Role resources |
| Upsert | `io.restorecommerce.user.RoleList` | `io.restorecommerce.user.RoleList` | Create or Update a list of Role resources |

For the detailed protobuf message structure of `io.restorecommerce.resourcebase.ReadRequest` and `io.restorecommerce.resourcebase.DeleteRequest` refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface).

## Kafka Events

This microservice subscribes to the following events by topic:

| Topic Name | Event Name | Description |
| ----------- | ------------ | ------------- |
| `io.restorecommerce.command` | `restoreCommand` | for triggering for system restore |
|                              | `resetCommand` | for triggering system reset |
|                              | `healthCheckCommand` | to get system health check |
|                              | `versionCommand` | to get system version |
| `io.restorecommerce.rendering` | `renderResponse` | to get response from render request |

List of events emitted by this microservice for below topics:

| Topic Name | Event Name | Description |
| ----------- | ------------ | ------------- |
| `io.restorecommerce.users.resource` | `registered` | emitted upon user registration |
|                                     | `activated` | emitted upon user activation |
|                                     | `passwordChangeRequested` | emitted when user reqeusts for password change |
|                                     | `passwordChanged` | emitted when password was changed successfully |
|                                     | `emailChangeRequested` | emitted when user reqeusts for email change |
|                                     | `emailChangeConfirmed` | emitted when user's email was changed successfully |
|                                     | `unregistered` | emitted when an user is unregistered |
|                                     | `userCreated` | emitted when an user is created |
|                                     | `userModified` | emitted when an user is modified |
|                                     | `userDeleted` | emitted when an user is deleted |
| `io.restorecommerce.roles.resource` | `roleCreated` | emitted upon role creation |
|                                     | `roleModified` | emitted upon role modification |
|                                     | `roleDeleted` | emitted when role deletion |
| `io.restorecommerce.notification` | `sendEmail` | emitted when triggering notification email |
| `io.restorecommerce.rendering` | `renderRequest` | emitted when rendering is requested  |
| `io.restorecommerce.command` | `restoreResponse` | system restore response |
|                              | `resetResponse` | system reset response |
|                              | `healthCheckResponse` | system health check response |
|                              | `versionResponse` | system version response |

For `renderRequest` and `renderResponse` the message structures are defined in [rendering-srv](https://github.com/restorecommerce/rendering-srv) and for `sendEmail` they are defined in [notification-srv](https://github.com/restorecommerce/notification-srv),

## Chassis Service

This service uses [chassis-srv](http://github.com/restorecommerce/chassis-srv), a base module for [restorecommerce](https://github.com/restorecommerce) microservices, in order to provide the following functionalities:

- exposure of all previously mentioned gRPC endpoints
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/blob/master/command-interface.md) which
provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
- database access, which is abstracted by the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface)
- stores the offset values for Kafka topics at regular intervals to [Redis](https://redis.io/).

## Running as Docker Container

This service depends on a set of _backing services_ that can be started using a
dedicated [docker compose definition](https://github.com/restorecommerce/system).

```sh
docker run \
 --name restorecommerce_identity_srv \
 --hostname identity-srv \
 -e NODE_ENV=production \
 -p 50051:50051 \
 restorecommerce/identity-srv
```

## Running Locally

Install dependencies

```sh
npm install
```

Build service

```sh
# compile the code
npm run build
```

Start service

```sh
# run compiled service
npm start
```
