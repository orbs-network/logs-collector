#!/bin/bash -e

echo "Stopping everything.."
docker-compose down

echo "The ELK stack is now down, to start again run ./start.sh again"

exit 0
