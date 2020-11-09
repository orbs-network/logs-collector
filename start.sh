#!/bin/bash -e

echo "Starting up everything..."

if test ! -f ".env"; then
    echo "ELK_VERSION=7" > .env
fi

cd collector && npm install; cd ..

echo "Starting up the ELK stack.."
docker-compose up -d

echo "ELK is now performing its initial setup (this might take a couple of minutes)..."
node collector/check-readiness.js

echo "Create logstash index pattern.."
./create-index-pattern.sh

echo "The stack is up and ready for use"
echo "Feel free to navigate to http://localhost:5601 to access Kibana"
echo "The access credentials are:"
echo "Username: elastic"
echo "Password: changeme"
echo " "
echo "Attempting to open it for you :-)"
echo "After logging in, please navigate to Discover to be able to see logs"
open "http://localhost:5601"

exit 0
