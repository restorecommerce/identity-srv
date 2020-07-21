#!/bin/bash

DOCKER_BUILDKIT=1 docker build \
  --tag restorecommerce/identity-srv \
  -f ./buildkit.Dockerfile \
  --cache-from restorecommerce/identity-srv \
  --build-arg APP_HOME=/home/node/identity-srv \
  .
