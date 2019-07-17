# identity-srv

<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fidentity%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/identity-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/identity-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/identity-srv?branch=master)

[version]: http://img.shields.io/npm/v/identity-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/identity-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/identity-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/identity-srv/master.svg?style=flat-square

This microservice handles the User and Role resources.
It provides a [gRPC](https://grpc.io/docs) interface for handling CRUD operations and user-specific functionalities.
This service persists user data within an ArangoDB instance and generic asynchronous communication is performed with [Apache Kafka](https://kafka.apache.org/), using an event-driven approach with message interfaces defined with [Protocol Buffers](https://developers.google.com/protocol-buffers/) (see [kafka-client](https://github.com/restorecommerce/kafka-client) for more information). Resource-handling operations are implemented and exposed through the [UserService and the RoleService](service.ts), which extend the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface) generic class `ServiceBase`.

Several features are meant to be configurable and disabled, if they are not necessary. Within the service's configuration file. under `service/` there is a set of flags that can be enabled or disabled:
- `userActivationRequired`: if set to `false`, users do not require account activation to be able to log in and use their account
- `register`: if set to `false`, the `Register` endpoint is disabled and users can only be created through the bulk creation method `createUsers`, which can be seen as an admin-only operation
- `enableEmail`: if set to `true`, emails are sent out upon specific events, like account creation and email change
- `activationLink`: contains the URL prefix for the activation link which is generated upon account creation
- `emailConfirmationLink`: contains the URL prefix for the confirmation link which is generated upon an email change request
- `invitationLink`: contains the URL prefix for invitation link when another user sends an invite request
- `hbs_templates`: contains all data necessary for retrieving HBS templates from a remote server; such templates can be used to request email data rendering in order to send out all necessary emails (this is ignored if `enableEmail` is set to false).\
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

A list of User resources.

`io.restorecommerce.user.UserList`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| items | [ ]`io.restorecommerce.user.User` | required | List of Users |
| total_count | number | optional | number of Users |

#### Register
Used to register a User.
Requests are performed providing `io.restorecommerce.user.RegisterRequest` protobuf message as input and responses are a `io.restorecommerce.user.User` message. If a valid configuration for retrieving email-related [handlebars](http://handlebarsjs.com/) templates from a remote server is provided, an email request is performed upon a successful registration. Such config should correspond to the `service/hbs_templates` element in the config files. The email contains the user's activation code. Email requests are done by emitting a`sendEmail` notification event, which is consumed by [notification-srv](http://github.com/restorecommerce/notification-srv) to send an email. 
Please note that this email operation also implies template rendering, which is performed by emitting a `renderRequest` event, which is consumed by the [rendering-srv](http://github.com/restorecommerce/rendering-srv). Therefore, the email sending step requires both a running instance of the rendering-srv and the notification-srv (or similar services which implement the given interfaces) as well as a remote server containing a set of email templates. This is decoupled from the service's core functionalities and it is automatically disabled if no templates configuration is provided. 

Moreover, the `register` operation itself is optional and one can enable or disable it through the `service.register` configuration value. If disabled, the only endpoint for user creation is `create`.

`io.restorecommerce.user.RegisterRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| guest | bool | optional | Guest user, default value is `false` |
| name | string | required | Username |
| first_name | string | required | User's first name |
| last_name | string | required | User's last name |
| email | string | required | User email ID |
| password | string | required | User password |
| creator | string | required | User id of the creator |
| timezone | string | optional | The User's timezone setting (defaults to 'Europe/Berlin') |
| locale | string | optional | The User's locale setting (defaults to 'de-DE') |
| role_associations | `io.restorecommerce.user.RoleAssociation`[] | required | A list of roles with their associated attributes |

#### Activate
Used to activate a User. The ``service.userActivationRequired`` config value turns the user activation process on or off. Requests are performed providing `io.restorecommerce.user.ActiveRequest` protobuf message as input and responses are a `google.protobuf.Empty` message.

`io.restorecommerce.user.ActiveRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| activation_code | string | required | activation code for User |

#### ChangePassword

Used to change password for the User (User should be activated to perform this operation).
Requests are performed providing `io.restorecommerce.user.ChangePasswordRequest` protobuf message as input and responses are a `io.restorecommerce.user.User` message.

`io.restorecommerce.user.ChangePasswordRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| password | string | required | new password |

#### RequestPasswordChange

Used to change password for the User in case he/she forgets it.
It generates and persists an activation code for the user and issues an email with a confirmation link.
Requests are performed providing `io.restorecommerce.user.ForgotPasswordRequest` protobuf message as input and responses are `google.protobuf.Empty` messages. Either user name or email should be specified upon the request.

`io.restorecommerce.user.ForgotPasswordRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | optional | User name |
| email | string | optional | User email |

#### ConfirmPasswordChange

Used to confirm the user's password change request. The input is a `io.restorecommerce.user.ConfirmPasswordChangeRequest` message and the response is a `google.protobuf.Empty` message. If the received activation code matches the previously generated activation code, the stored password hash value is replaced by a hash derived from the new password and the activation code is reset.

`io.restorecommerce.user.ConfirmPasswordChangeRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | required | User name |
| activation_code | string | required | Activation code  |
| password | string | required | New password |

#### RequestEmailChange

Used to change the user's email. Requests are performed providing the `io.restorecommerce.user.RequestEmailChange` protobuf message as input and responses is a `google.protobuf.Empty` message. 
when receiving this request, the service assigns the new email value to the user's `new_email` property and issues an email with a confirmation link containing a newly-generated activation code.

`io.restorecommerce.user.ChangeEmailRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| email | string | required | New email  |

#### ConfirmEmailChange

Used to confirm the user's email change request. The input is a `io.restorecommerce.user.ConfirmEmailChange` message and the response is a `google.protobuf.Empty` message. If the received activation code matches the previously generated activation code, the value assigned to the `new_email` property is then assigned to the `email` property and `new_email` is set to null.

`io.restorecommerce.user.ConfirmEmailChange`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | required | User name |
| activation_code | string | required | Activation code  |

#### ConfirmUserInvitation
Used to confirm user invitation. Requests are performed providing `io.restorecommerce.user.ActivateInvitationRequest` protobuf message as input and responses are a `google.protobuf.Empty` message. For `Create` operation if the invite flag `io.restorecommerce.user.invite` is set to true then an inviation mail would be sent if `invitationLink` and `hbs_templates` configuration values are setup accordingly.

`io.restorecommerce.user.ActivateInvitationRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | required | User name |
| password | string | required | User password |
| activation_code | string | required | User's activation_code sent via email |

#### Login

Used to verify the a User's password and return its info in case the operation is successful. Requests are performed providing `io.restorecommerce.user.LoginRequest` protobuf message as input and the response is `io.restorecommerce.user.User` message.

`io.restorecommerce.user.LoginRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| name | string | optional | User name |
| email | string | optional | User email |
| password | string | required | Raw password |

#### Unregister
Used to unregister a User. Requests are performed providing `io.restorecommerce.user.UnregisterRequest` protobuf message as input and responses are a `google.protobuf.Empty` message.

`io.restorecommerce.user.UnregisterRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |

#### Find
A simplified version of `read`, which only filters users by username, email and/or ID. Requests are performed providing `io.restorecommerce.user.FindRequest` protobuf message as input and responses contain a list  `io.restorecommerce.user.User` messages.

`io.restorecommerce.user.FindRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| name | string | required | User name |
| email | string | required | User EmailID |

#### FindByRole

A custom endpoint in order to filter a user by its role and any attributes associated with it. Requests are performed providing `io.restorecommerce.user.FindByRoleRequest` protobuf message as input and responses contain a list  `io.restorecommerce.user.User` messages.

`io.restorecommerce.user.FindRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| role | string | required | Role name |
| attributes | `io.restorecommerce.user.RoleAssociation.Attribute`[] | optional | Role attributes |

### Role
A Role resource.

`io.restorecommerce.role.Role`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | Role identifier |
| name | string | required | specifies the Role of the User |
| description | string | optional | Role description |
| created | double | optional | Role created date |
| modified | double | optional | Role modified date |


#### CRUD Operations
The microservice exposes the below CRUD operations for creating or
modifying User and Role resources.

`io.restorecommerce.user.Service`

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | `io.restorecommerce.user.UserList` | `io.restorecommerce.user.UserList` | Create a list of User resources |
| Read | `io.restorecommerce.resourcebase.ReadRequest` | `io.restorecommerce.user.UserList` | Read a list of User resources |
| Update | `io.restorecommerce.user.UserList` | `io.restorecommerce.user.UserList` | Update a list of User resources |
| Delete | `io.restorecommerce.resourcebase.DeleteRequest` | Empty | Delete a list of User resources |
| Upsert | `io.restorecommerce.user.UserList` | `io.restorecommerce.user.UserList` | Create or Update a list of User resources |

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

This microservice subscribes to the following Kafka events by topic:
- io.restorecommerce.command
  - restoreCommand
  - resetCommand
  - healthCheckCommand
  - versionCommand
- io.restorecommerce.rendering
  - renderResponse

List of events emitted to Kafka by this microservice for below topics:
- io.restorecommerce.users.resource
  - registered
  - activated
  - passwordChangeRequested
  - passwordChanged
  - emailChangeRequested
  - emailChangeConfirmed
  - unregistered
  - userCreated
  - userModified
  - userDeleted
- io.restorecommerce.roles.resource
  - roleCreated
  - roleModified
  - roleDeleted
- io.restorecommerce.notification
  - sendEmail
- io.restorecommerce.rendering
  - renderRequest
- io.restorecommerce.command
  - restoreResponse
  - resetResponse
  - healthCheckResponse
  - versionResponse

For `renderRequest` and `renderResponse` the message structures are defined in [rendering-srv](https://github.com/restorecommerce/rendering-srv) and for `sendEmail` they are defined in [notification-srv](https://github.com/restorecommerce/notification-srv),


## Chassis Service

This service uses [chassis-srv](http://github.com/restorecommerce/chassis-srv), a base module for [restorecommerce](https://github.com/restorecommerce) microservices, in order to provide the following functionalities:
- exposure of all previously mentioned gRPC endpoints
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/blob/master/command-interface.md) which
provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
- database access, which is abstracted by the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface)
- stores the offset values for Kafka topics at regular intervals to [Redis](https://redis.io/).

## Development

### Tests
See [tests](test/).

**Note**: although any kind of gRPC client can be used to connect to these endpoints, the tests make use of the [grpc-client](https://github.com/restorecommerce/grpc-client),
a [restorecommerce](https://github.com/restorecommerce) module which allows an application to connect to multiple gRPC endpoints with custom middleware, loadbalancing and retry/timeout support.

## Usage

### Development

- Install dependencies

```sh
npm install
```

- Build application

```sh
# compile the code
npm run build
```

- Run application and restart it on changes in the code

```sh
# Start identity-srv backend in dev mode
npm run dev
```

### Production

```sh
# compile the code
npm run build

# run compiled server
npm start
```