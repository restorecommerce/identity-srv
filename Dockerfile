FROM node:12.4.0-stretch

# Install dependencies
RUN apt-get update && apt-get install -y libc6-dev

## CREATE APP USER ##
# Create the home directory for the new app user.
RUN mkdir -p /home/app

# Create an app user so our application doesn't run as root.
RUN groupadd -r app &&\
    useradd -r -g app -d /home/app -s /sbin/nologin -c "Docker image user" app

# Create app directory
ENV HOME=/home/app
ENV APP_HOME=/home/app/identity-srv

# Install global dependencies
RUN npm install -g typescript

## SETTING UP THE APP ##
WORKDIR $APP_HOME

# Chown all the files to the app user.
RUN chown -R app:app $HOME

# Change to the app user.
USER app

# Set config volumes
VOLUME $APP_HOME/cfg

# Install Dependencies
COPY --chown=app package.json $APP_HOME
COPY --chown=app package-lock.json $APP_HOME
RUN npm install

# Bundle app source
COPY --chown=app . $APP_HOME
RUN npm run build

HEALTHCHECK CMD npm run healthcheck

EXPOSE 50051
CMD [ "npm", "start" ]


#FROM node:9.2.0-wheezy
#RUN mkdir -p /home/app
#RUN groupadd -r app &&\
#    useradd -r -g app -d /home/app -s /sbin/nologin -c "Docker image user" app
#ENV HOME=/home/app
#ENV APP_HOME=/home/app/identity-srv
#RUN mkdir $APP_HOME
#WORKDIR $APP_HOME
#RUN pwd
# Copy files from base container by changing the ownership
#COPY --chown=app:app --from=base /home/app/identity-srv/ .
#USER app
#EXPOSE 50051
#CMD [ "npm", "start" ]

# To build the image:
# docker build -t restorecommerce/identity-srv .
#
# To create a container:
# docker create --name identity-srv --net restorecms_default restorecommerce/identity-srv
#
# To run the container:
# docker start identity-srv
