#!/bin/sh
# Container start: apply pending migrations, then replace this shell with Node. With `exec`, Node
# is PID 1 and receives Docker's SIGTERM itself, so Nest's shutdown hooks run and pg-boss stops
# its workers gracefully. A failed migration stops the container before the API serves anything.
set -eu
cd /app/apps/api
node_modules/.bin/prisma migrate deploy
exec node dist/main.js
