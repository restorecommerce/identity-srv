### 1.8.3 (August 27th, 2024)

- bump versions
- fix oauth
- remove tech users and api keys

### 1.5.1 (Februrary 6th, 2024)

- bump minor dep versions

### 1.5.0 (January 26th, 2024)

- add unauthenticated technical user lookup

### 1.4.7 (January 18th, 2024)

- up deps
- add user.properties

### 1.4.6 (November 26th, 2023)

- removed deprecated method in chassis-srv (collection.load)

## 1.4.5 (November 25th, 2023)

- added client_id for token data

## 1.4.4 (November 23rd, 2023)

- added null checks

## 1.4.3 (November 22nd, 2023)

- added separate queue for identity-srv jobs

## 1.4.2 (November 21st, 2023)

- updated expires_in, last_login and last_access to timestamp fields
- updated dependencies

## 1.4.1 (November 08th, 2023)

- added jobMeta
- improved loggers
- removed ReadRequest

## 1.4.0 (October 22nd, 2023)

- support request password change and request email change for both name and email as identifier

## 1.3.9 (October 22nd, 2023)

- fix delete tokens from redis on user deletion

## 1.3.8 (October 21st, 2023)

- delete tokens from redis on user deletion

## 1.3.7 (October 14th, 2023)

- added null condition for comparison of nested attributes

## 1.3.6 (October 14th, 2023)

- added data field for register user

## 1.3.5 (October 11th, 2023)

- fix return status message for password change

## 1.3.4 (October 11th, 2023)

- fix token destroy api

## 1.3.3 (October 10th, 2023)

- fix db expries in for findByToken
- up log message and added more tests for password verification

## 1.3.2 (October 9th, 2023)

- enable to import tech users without password having null check for password

## 1.3.1 (October 9th, 2023)

- up job name

## 1.3.0 (October 7th, 2023)

- up node and dependencies

## 1.2.2 (October 3rd, 2023)

- fix email confirm change message name
- update URLs for email

## 1.2.1 (September 20th, 2023)

- fix reference error

## 1.2.0 (September 20th, 2023)

- protos made all fields optionals

## 1.1.9 (July 28th, 2023)

- fix email config 

## 1.1.8 (July 28th, 2023)

- date object for findByToken and AuthenticationLogs
- use server generated typings
- hbs email template urls
- email sending

## 1.1.7 (July 26th, 2023)

- up deps

## 1.1.6 (July 26th, 2023)

- up deps

## 1.1.5 (July 26th, 2023)

- roleAssociation and owner attributes
- For DateTimeStamp field handling
- up deps

## 1.1.4 (June 28th, 2023)

- bump package and package lock version

## 1.1.3 (June 28th, 2023)

- updated dependencies

## 1.1.2 (June 19th, 2023)

- updated dependencies

## 1.1.1 (June 2nd, 2023)

- up acs-client

## 1.1.0 (June 2nd, 2023)

- up deps for optional fields and pulralized protos and libs
- fix requestPasswordChange and requestEmailChange to lookup by user name (instead of both user name and email, since if uniqueEmailConstraint is set to false in config it is possible to have multiple users with same email for different user names)
- removed self kill token (as its already taken care in current update api) and used AQL query for updating last login on token
- activate user on confirm password change call if the user is inactive
- fix unit test for request email and request password change test
- remove tokens if user not active

## 1.0.3 (February 8th, 2023)

- handle filter ownership AQL query for multiple owners
- added null check for token value of `0` so that its not added to expired tokens list (for tech users)

## 1.0.2 (December 28th, 2022)

- set active flag for create api depending on the input
- allow to change username field for update api

## 1.0.1 (October 26th, 2022)

- included full text search
- up deps 

## 1.0.0 (August 25th, 2022)

- migrated to fully-typed grpc-client and server
- up deps

## 0.3.3 (August 11th, 2022)

- fix token destroy api to update user reading from DB (instead of cache findByToken)

## 0.3.2 (July 8th, 2022)

- up deps

## 0.3.1 (July 8th, 2022)

- up deps

## 0.3.0 (June 30th, 2022)

- up deps

## 0.2.39 (May 11th, 2022)

- expire jwt token after 6 month

## 0.2.38 (May 11th, 2022)

- correctly remove outdated tokens

## 0.2.37 (May 10th, 2022)

- expire auth tokens after 6 months

## 0.2.36 (May 10th, 2022)

- added oauth getToken support

## 0.2.35 (April 25th, 2022)

- updated user read rpc to return roles as well

## 0.2.34 (April 7th, 2022)

- fix logout response message

## 0.2.33 (April 7th, 2022)

- lookup user by token instead of user service find api in token destroy method

## 0.2.32 (March 28th, 2022)

- expire auth token at the same time as access token

## 0.2.31 (March 24th, 2022)

- manual push to trigger workflow

## 0.2.30 (March 24th, 2022)

- add oauth scope to config

## 0.2.29 (March 24th, 2022)

- fix undefined token names

## 0.2.28 (March 18th, 2022)

- updated acs-client (includes the check to override ACS filters if ACS custom query filters exist)

## 0.2.27 (March 14th, 2022)

- fix to override ACS filters if ACS custom query filters exist

## 0.2.26 (March 14th, 2022)

- supress empty filters

## 0.2.25 (March 14th, 2022)

- fix to apply acs filters

## 0.2.24 (February 24th, 2022)

- insert user data into jwt

## 0.2.23 (February 22nd, 2022)

- add token generation to code exchange flow

## 0.2.22 (February 21st, 2022)

- fix oauth service to append token instead of updating entier user object

## 0.2.21 (February 18th, 2022)

- updated chassis-srv (includes fix for offset store config)

## 0.2.20 (February 15th, 2022)

- check oauth service config before instantiation of oauth service

## 0.2.19 (February 14th, 2022)

- fix redis prod url

## 0.2.18 (February 14th, 2022)

- updated redis url

## 0.2.17 (February 14th, 2022)

- updated dependencies and migrated from ioredis to redis
- added data field for user
- fix to remove expired tokens on login

## 0.2.16 (February 9th, 2022)

- added oauth support

## 0.2.15 (December 22nd, 2021)

- removed importHelpers flag from tsconfig

## 0.2.14 (December 22nd, 2021)

- updated ts config and added no-float promise rule

## 0.2.13 (December 22nd, 2021)

- updated RC dependencies

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
