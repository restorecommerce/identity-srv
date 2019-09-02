# Development

To run the service, a running instance of

- [Kafka](https://kafka.apache.org/)
- [ArangoDB](https://www.arangodb.com/)
- [Redis](https://redis.io/)

Refer to [System](https://github.com/restorecommerce/system) repository to start the backing-services before running the tests.

## Building

Install dependencies

```sh
npm install
```

Build service

```sh
# compile the code
npm run build
```

## Running in Development Mode

Run application in development mode

```sh
# Start service in development mode
npm run dev
```

## Running in Production Mode

```sh
# compile the code
npm run build

# run compiled service
npm start
```

## Environment Definition

The environment is defined by the `NODE_ENV` environment variable
and there are environment specific configuration files.

```sh
# Linux
export NODE_ENV="development"

# Windows
set NODE_ENV=development
```

Valid environment identifiers are:

- `development`
- `production`

### Testing

Run tests

```sh
npm run test
```
