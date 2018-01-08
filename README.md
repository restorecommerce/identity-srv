# identity-srv

<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fidentity%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/identity-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/identity-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/identity-srv?branch=master)

[version]: http://img.shields.io/npm/v/identity-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/identity-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/identity-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/identity-srv/master.svg?style=flat-square

This microservice handles the user resource.
It provides a [gRPC](https://grpc.io/docs) interface for handling CRUD operations and user-specific functionalities.
This service persists user data within an ArangoDB instance and generic asynchronous communication is performed with [Apache Kafka](https://kafka.apache.org/), using an event-driven approach with message interfaces defined with [Protocol Buffers](https://developers.google.com/protocol-buffers/) (see [kafka-client](https://github.com/restorecommerce/kafka-client) for more information). User-specific operations are implemented and exposed through the [UserService](service.ts), which is a extension of the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface) generic class `ServiceBase`.


## gRPC Interface

This microservice exposes the following gRPC endpoints for User resource.

### User
A User resource.

`io.restorecommerce.user.User`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID, unique, key |
| created | double | required | Date when user was created |
| modified | double | required | Date when user was modified |
| creator | string | optional | User ID of the creator |
| name | string | required | User name |
| email | string | required | Email address |
| active | bool | optional | If the user was activated via the activation process |
| activation_code | string | optional | Activation code used in the activation process |
| password | string | required | Raw password, not stored |
| passwordHash | bytes | optional | Encrypted password, stored |
| guest | bool | optional | A guest user. |
| Role | [ ]Role | optional | Role |

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| Role | string | optional | role of user |

A list of User resources.

`io.restorecommerce.user.UserList`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| items | [ ]io.restorecommerce.user.User | required | List of Users |
| total_count | number | optional | number of Users |

#### Register
Used to register a User.
Requests are performed providing `io.restorecommerce.user.RegisterRequest` protobuf message as input and responses are a `io.restorecommerce.user.User` message. If a valid configuration for retrieving email-related [handlebars](http://handlebarsjs.com/) templates from a remote server is provided, an email request is performed upon a successful registration. The email contains the user's auto-generated activation code. Email requests are done by emitting a`sendEmail` notification event, which is consumed by [notification-srv](http://github.com/restorecommerce/notification-srv). This service internally uses [mailer](https://github.com/restorecommerce/mailer) to send email.
Please note that this email operation also implies template rendering, which is performed by emitting a `RenderRequest` event, which is consumed by the [rendering-srv](http://github.com/restorecommerce/rendering-srv). Therefore, the email sending step requires both a running instance of the rendering service and the notification service (or similar services which implement the given interfaces) as well as a remote server containing a set of email templates.

`io.restorecommerce.user.RegisterRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| guest | bool | optional | guest user, default value is `false` |
| name | string | required | user name |
| email | string | required | user email ID |
| password | string | required | user password |
| creator | string | optional | user id of the creator |
| Role | Role | optional | Role |

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

#### ChangeEmailID
Used to change EmailID of the User (User should be activated to perform this operation). Requests are performed providing `io.restorecommerce.user.ChangeEmailIdRequest` protobuf message as input and responses are a `io.restorecommerce.user.User` message.
After the EmailID is changed User account needs to be activated again with the new
activation code sent via email to User. For more details about the email operation see `Register`.

`io.restorecommerce.user.ChangeEmailIdRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| email | string | required | EmailID  |

#### VerifyPassword
Used to verify the password of the User. Requests are performed providing `io.restorecommerce.user.VerifyPasswordRequest` protobuf message as input and responses are a `google.protobuf.Empty` message.

`io.restorecommerce.user.VerifyPasswordRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| user | string | required | User name |
| password | string | required | Raw password |

#### CreateUsers
Used for bulk creation of Users. Requests are performed providing `io.restorecommerce.user.UserList` protobuf message as input and responses are a `io.restorecommerce.user.UserList` message.

#### Unregister
Used to unregister a User. Requests are performed providing `io.restorecommerce.user.UnregisterRequest` protobuf message as input and responses are a `google.protobuf.Empty` message.

`io.restorecommerce.user.UnregisterRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |

#### Find
Used to find the User details. Requests are performed providing `io.restorecommerce.user.FindRequest` protobuf message as input and responses are a `io.restorecommerce.user.User` message.

`io.restorecommerce.user.FindRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | User ID |
| name | string | required | User name |
| email | string | required | User EmailID |

#### CRUD Operations
The microservice exposes the below CRUD operations for creating or
modifying User resource.

`io.restorecommerce.user.Service`

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | io.restorecommerce.user.UserList | io.restorecommerce.user.UserList | Create a list of User resources |
| Read | io.restorecommerce.resourcebase.ReadRequest | io.restorecommerce.user.UserList | Read a list of User resources |
| Update | io.restorecommerce.user.UserList | io.restorecommerce.user.UserList | Update a list of User resources |
| Delete | io.restorecommerce.resourcebase.DeleteRequest | Empty | Delete a list of User resources |
| Upsert | io.restorecommerce.user.UserList | io.restorecommerce.user.UserList | Create or Update a list of User resources |

For the detailed protobuf message structure of `io.restorecommerce.resourcebase.ReadRequest` and `io.restorecommerce.resourcebase.DeleteRequest` refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface).

## Kafka Events

This microservice subscribes to the following Kafka events by topic:
- io.restorecommerce.command
  - restoreCommand
  - healthCheckCommand
  - resetCommand
- io.restorecommerce.rendering
  - identityRenderResponse

List of events emitted to Kafka by this microservice for below topics:
- io.restorecommerce.users.resource
  - registered
  - activated
  - passwordChanged
  - emailIdChanged
  - unregistered
  - usersCreated
  - usersModified
  - usersDeleted
- io.restorecommerce.notification
  - sendEmail
- io.restorecommerce.rendering
  - renderRequest
- io.restorecommerce.command
  - healthCheckResponse
  - resetResponse

For `sendEmail` event protobuf message structure see [notification-srv](https://github.com/restorecommerce/notification-srv)
and for `renderRequest` event protobuf message structure see [rendering-srv](https://github.com/restorecommerce/rendering-srv).

## Shared Interface

This microservice uses [chassis-srv](http://github.com/restorecommerce/chassis-srv), a base engine for microservices, in order to provide the following functionalities:
- exposure of gRPC endpoints for user-handling operations
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/command-interface.md) which
provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
- database access, which is abstracted by the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface)

## Usage

See [tests](#test/).


**Note**: although any kind of gRPC client can be used to connect to these endpoints, the tests make use of the [grpc-client](https://github.com/restorecommerce/grpc-client),
a `restorecommerce` module which allows an application to connect to multiple gRPC endpoints with custom middleware, loadbalancing and retry/timeout support.
