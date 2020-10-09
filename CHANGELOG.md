### 0.1.7 (October 3rd, 2020)

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