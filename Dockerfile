FROM node:9.2.0-wheezy

RUN apt-get update && apt-get install -y libc6-dev

# Create app directory
RUN mkdir -p /usr/share/identity-srv
RUN mkdir -p /root/.ssh
WORKDIR /usr/share/identity-srv

# Set config volumes
VOLUME /usr/share/identity-srv/cfg
VOLUME /usr/share/identity-srv/protos

# Bundle app source
COPY . /usr/share/identity-srv

# Install app dependencies
RUN npm install -g typescript

RUN cd /usr/share/identity-srv
COPY id_rsa /root/.ssh/
COPY config /root/.ssh/
COPY known_hosts /root/.ssh/

RUN npm install
RUN npm run postinstall

EXPOSE 50051
CMD [ "npm", "start" ]

# To build the image:
# docker build -t restorecommerce/identity-srv .
#
# To create a container:
# docker create --name identity-srv -v /restore/identity-srv-TypeScript/test/cfg:/usr/share/identity-srv/cfg --net restorecms_default restorecommerce/identity-srv
#
# docker create --name identity-srv --net restorecms_default restorecommerce/identity-srv
# To run the container:
# docker start identity-srv
