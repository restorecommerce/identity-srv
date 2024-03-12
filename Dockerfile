### Build
FROM node:20.8.0-alpine3.18 as build
ENV NO_UPDATE_NOTIFIER=true

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY --chown=node:node . .

RUN npm ci
RUN npm run build


### Deployment
FROM node:20.8.0-alpine3.18 as deployment

ENV NO_UPDATE_NOTIFIER=true

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY --chown=node:node filter_ownership.aql filter_role_association.aql $APP_HOME
COPY --chown=node:node ./email_templates $APP_HOME/email_templates 
COPY --chown=node:node ./cfg $APP_HOME/cfg
COPY --chown=node:node --from=build $APP_HOME/lib $APP_HOME/lib

EXPOSE 50051

CMD [ "node", "./lib/start.cjs" ]
