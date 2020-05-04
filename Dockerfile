FROM node:12.16.1-stretch
ENV HOME=/home/node
ENV APP_HOME=/home/node/identity-srv
## SETTING UP THE APP ##
RUN mkdir $APP_HOME
WORKDIR $APP_HOME
RUN cd $APP_HOME
# Chown all the files to the app node.
RUN chown -R node:node $HOME
RUN pwd
# Change to the node user.
USER node
RUN npm install
RUN npm run build
EXPOSE 50051
HEALTHCHECK CMD npm run healthcheck
CMD [ "npm", "start" ]
