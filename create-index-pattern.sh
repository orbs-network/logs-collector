#!/bin/bash -e

marker='Logstashfile'

if test -f "$marker"; then
    echo "exists";
    exit 0
fi

curl -XPOST -D- 'http://localhost:5601/api/saved_objects/index-pattern' \
    -H 'Content-Type: application/json' \
    -H 'kbn-version: 7.9.1' \
    -u elastic:changeme \
    -d '{"attributes":{"title":"logstash-*","timeFieldName":"@timestamp"}}'

touch $marker
