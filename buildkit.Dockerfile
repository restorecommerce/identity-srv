# syntax = docker/dockerfile:experimental
FROM node:12.16.1-alpine as build

RUN --mount=type=cache,target=/root/.npm npm install -g typescript@3.4.1

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY package.json package.json
COPY package-lock.json package-lock.json

RUN --mount=type=cache,target=/root/.npm npm ci

COPY --chown=node:node . .

RUN npm run build


FROM node:12.16.1-alpine as deployment

RUN --mount=type=cache,target=/root/.npm npm install -g typescript@3.4.1

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY package.json package.json
COPY package-lock.json package-lock.json

RUN --mount=type=cache,target=/root/.npm npm ci --only=production

COPY --from=build $APP_HOME/lib $APP_HOME/lib
COPY --from=build $APP_HOME/setupTopics.js $APP_HOME/setupTopics.js
COPY --from=build $APP_HOME/cfg $APP_HOME/cfg
COPY --from=build $APP_HOME/templates $APP_HOME/templates

EXPOSE 50051
HEALTHCHECK CMD npm run healthcheck
CMD [ "npm", "start" ]
