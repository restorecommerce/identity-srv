## 0.2.12 (December 21st, 2021)

- updated RC dependencies

## 0.2.11 (December 15th, 2021)

- updated acs-client and other dependencies

## 0.2.10 (December 13th, 2021)

- added context null check

## 0.2.9 (December 10th, 2021)

- updated acs-client with restructured checkAccessRequest api
- updated logger and other dependencies

## 0.2.8 (November 11th, 2021)

- make password optional for tech user creation
- enable login for tech users

## 0.2.7 (October 19th, 2021)

- fix activate and confirm password to pass user id for acs check  (needed in ACL check)

## 0.2.6 (October 7th, 2021)

- updated acs-client and protos

## 0.2.5 (September 30th, 2021)

- fix response for findByToken for empty token

## 0.2.4 (September 28th, 2021)

- up acs-client dep

## 0.2.3 (September 28th, 2021)

- added support for `loginIdentifierProperty`

## 0.2.2 (September 21st, 2021)

- up RC dependencies

## 0.2.1 (September 13th, 2021)

- up dependencies

## 0.2.0 (August 10th, 2021)

- latest grpc-client
- migraged kafka-client to kafkajs
- chassis-srv using the latest grpc-js and protobufdef loader
- filter changes (removed google.protobuf.struct completely and defined nested proto structure)
- added status object to each item and also overall operation_status.

## 0.1.31 (June 28th, 2021)

- updated node version to 16.3
- updated logger and protos

## 0.1.30 (April 19th, 2021)

- fix to flush chaced data of `findByToken` (done on user update).

## 0.1.29 (April 6th, 2021)

- fix to reject for expired tokens on `findByToken`

## 0.1.28 (March 23rd, 2021)

- fix find operation for assigning filter only if its provided
- updated role Assoc modified to compare attributes id and values

## 0.1.27 (March 19th, 2021)

- added unique email constraint feature
- fix `roleAssocsModified` to compare only role and attributes, modified the verifyRoleAssocs to check for invalid roles provided and fixed tests
- migrated redis to ioredis
- updated dependencies

## 0.1.26 (March 11th, 2021)

- update dependencies.

## 0.1.25 (March 8th, 2021)

- added optional field `data` to be used inside makeRenderRequestMsg
when it is provided in the config.json. 

## 0.1.24 (February 24th, 2021)

- updated logger and service config

## 0.1.23 (February 23rd, 2021)

- updated node and npm version

## 0.1.22 (February 22nd, 2021)

- Added check to verify user roleAssociations only if the role associations are changed

## 0.1.21 (January 19th, 2021)

- moved role_assoc from register and made it configurable,
- updated requestPasswordChange, confirmPasswordChange, requestEmailChange, confirmEmailChange, activate, sendInvitationEmailRequest, unregister, changePassword to use identifier field.
- added sendActivationEmail rpc to resend registration emails
- Add ACS checks for requestEmailChange and changed the recipient to new email
- up documentation, protos

## 0.1.20 (January 15th, 2021)

- fix to support both name and email fields for request password change method

## 0.1.19 (January 12th, 2021)

- changed the update tokens aql query from APPEND to PUSH

## 0.1.18 (January 9th, 2021)

- fix to set email enabled config on startup

## 0.1.17 (December 10th, 2020)

- fix for invalidating findByToken cache

## 0.1.16 (December 4th, 2020)

- up acs-client (unauthenticated fix), protos (last_login updated on token)

## 0.1.15 (December 2nd, 2020)

- fix docker image permissions

### 0.1.14 (November 19th, 2020)

- added findByToken and empty password check for technical user
- removed subject cache, storing of token to redis and unused methods from token service.
- added interactive flag to tokens
- up token service to match oidc token fields
- modified update api of user service to verify role associations

### 0.1.13 (October 28th, 2020)

- changed HBS templates naming in configuration
- added query params to activation urls
- updated acs-client for unauthenticated fix and fixed activation to remove user name

### 0.1.12 (October 19th, 2020)

- update services in production config

### 0.1.11 (October 19th, 2020)

- updated chassis-srv
- add acs-srv readiness check
- updated acs-client

### 0.1.10 (October 14th, 2020)

- updated acs-client for evaluation_cacheable and protos
- updated dependencies

### 0.1.9 (October 10th, 2020)

- switch docker healthcheck to grpc

### 0.1.8 (October 9th, 2020)

- update to chassis-srv v0.1.5
- add redis and arangodb readiness checks

### 0.1.7 (October 9th, 2020)

- up acs-client includes fix for validatino of token with subject-id
- fix for populate role associations
- removed acs check for authentication log create (else after token is destroyed we cannot log logout message)

### 0.1.6 (October 3rd, 2020)

- added token service and authentication_log service
- restructured protos

### 0.1.5 (September 14th, 2020)

- fix to use separate redisClient objects and updated doc

### 0.1.4 (September 9th, 2020)

- updated login method for password / token
- removed reading of HR scope from subject cache

### 0.1.3 (Auguest 27th, 2020)

- healthcheck fix, updated dependencies

### 0.1.2 (Auguest 18th, 2020)

- updated logger and node version

### 0.1.1 (Auguest 10th, 2020)

- fix to enable to change owner information of Users for update / upsert operations (in case if user needs to be moved from one org to another)

### 0.1.0 (July 29th, 2020)

- initial release
