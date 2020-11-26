#!/bin/bash

docker rm -f identity_zk identity_kafka identity_redis identity_adb
docker network rm testing_net
