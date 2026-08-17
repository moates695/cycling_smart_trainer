#!/bin/bash
# Build, ship and release the WATTS API to the droplet (ssh alias: do).
#
# The static PWA is deploy.sh; this is the backend half. They are separate on
# purpose — a front end change should not restart the API, and an API release
# should not invalidate every cached asset.
#
# One-time setup (database, env file, nginx location) is setup-api.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=do
REMOTE_DIR=/root/watts

echo "== 0/4 Preflight =="
# compose interpolates ${WATTS_DB_PASSWORD} into both the database container and
# the API's DATABASE_URL, and reads it from $REMOTE_DIR/.env, which setup-api.sh
# writes. Unset, compose substitutes an empty string with only a warning: the
# database would come up with a blank password and the API would fail to reach
# it. Refuse to deploy rather than release that.
ssh "$REMOTE" "grep -q '^WATTS_DB_PASSWORD=.' $REMOTE_DIR/.env 2>/dev/null" || {
    echo "ERROR: no WATTS_DB_PASSWORD in $REMOTE:$REMOTE_DIR/.env — run setup-api.sh first."
    exit 1
}
echo "   database password present"

echo "== 1/4 Ship the server source =="
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
rsync -az --delete \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '.pytest_cache' \
    --exclude '.env' \
    server/ "$REMOTE:$REMOTE_DIR/server/"
rsync -az deploy/watts-api.compose.yml "$REMOTE:$REMOTE_DIR/docker-compose.yml"

echo "== 2/4 Build the image =="
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose -p watts build watts-api"

echo "== 3/4 Migrate, then release =="
# Migrations run before the new code is live, so the schema is never behind the
# app. Every migration so far is additive, which is what makes that ordering safe.
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose -p watts up -d watts-postgres"
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose -p watts run --rm watts-api alembic upgrade head"
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose -p watts up -d watts-api"

echo "== 4/4 Verify =="
sleep 3
ssh "$REMOTE" "docker ps --filter name=watts- --format '{{.Names}} {{.Status}}'"
curl -sf https://watts.moates.com.au/api/health && echo || {
    echo "WARN: /api/health did not respond. Check: ssh $REMOTE 'docker logs watts-api --tail 50'"
    exit 1
}
echo "API released."
