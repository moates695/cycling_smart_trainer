#!/bin/bash
# One-time setup for the WATTS API on the droplet. Safe to re-run.
#
# Run this once before the first deploy-api.sh. It creates the env file, brings
# up Postgres, and adds the `location ^~ /api/` block to the shared nginx
# template — validating the rendered config in a throwaway container before it
# touches the live proxy, exactly as setup-droplet.sh does.
set -euo pipefail

BASE=/root/gym_junkie_server
TEMPLATE=$BASE/nginx/nginx.conf.template
ENV_FILE=$BASE/app/envs/watts.env
REMOTE_DIR=/root/watts

echo "== 1/5 Create $ENV_FILE if it is missing =="
if [ -f "$ENV_FILE" ]; then
    echo "   already present, leaving it alone"
else
    umask 077
    cat > "$ENV_FILE" <<EOF
# WATTS API secrets. Not in git; readable only by root.
WATTS_DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

# Fill the key and secret in from the DO console. Until then the FIT endpoints
# return 503 and everything else works.
#
# The bucket is the Space name, not the folder: WATTS shares gym-junkie-01 and
# lives under watts-01/. The prefix must stay different from local dev's
# watts-01/dev — the orphan sweep deletes objects under <prefix>/fit/ that have
# no row in its own database, so a shared prefix means one side deletes the
# other's ride files.
WATTS_SPACES_ENDPOINT=https://syd1.digitaloceanspaces.com
WATTS_SPACES_REGION=syd1
WATTS_SPACES_BUCKET=gym-junkie-01
WATTS_SPACES_KEY=
WATTS_SPACES_SECRET=
WATTS_SPACES_PREFIX=watts-01/prod
EOF
    echo "   created with a generated database password"
fi

# Keys added after the first run have to reach an env file that already exists,
# so append what is missing rather than assuming the heredoc above ran. Never
# overwrites a value that is already there.
ensure_key() {
    if grep -q "^$1=" "$ENV_FILE"; then return; fi
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
    echo "   added $1"
}

# Peppers the password reset codes. The API refuses to start in production
# without it, because the fallback pepper is in the source tree — which would
# make a leaked database enough to mint a working reset code.
ensure_key WATTS_SECRET_KEY "$(openssl rand -base64 32)"

# Outbound mail for reset codes. The password is a Google App Password and has
# to be pasted in by hand; until it is, a reset code is logged as dropped rather
# than sent, and never written to the log in production.
ensure_key WATTS_SMTP_HOST smtp.gmail.com
ensure_key WATTS_SMTP_PORT 587
ensure_key WATTS_SMTP_USERNAME auth.moates@gmail.com
ensure_key WATTS_SMTP_PASSWORD ""
# Unquoted on purpose: docker compose env_file takes the value verbatim, quotes
# and all, and a quoted display name would make the From header malformed.
ensure_key WATTS_SMTP_FROM "WATTS <auth.moates@gmail.com>"

echo "== 2/5 Bring up watts-postgres =="
# The database password is the one value compose interpolates rather than passes
# through env_file, so it has to reach compose as a variable. It goes in
# $REMOTE_DIR/.env, which compose reads by itself: an `export` here would only
# last the length of this script, and every later `docker compose -p watts ...`
# run by hand on the droplet would silently interpolate an empty password.
#
# Sourcing $ENV_FILE instead would be the obvious move and is wrong: it is a
# docker env_file, not a shell script. WATTS_SMTP_FROM is deliberately unquoted
# so the From header keeps its display name, which makes `WATTS <auth@...>` a
# redirection as far as bash is concerned, and `source` dies on that line.
sed -n 's/^WATTS_DB_PASSWORD=//p' "$ENV_FILE" | (umask 077; sed 's/^/WATTS_DB_PASSWORD=/' > "$REMOTE_DIR/.env")
grep -q '^WATTS_DB_PASSWORD=.' "$REMOTE_DIR/.env" || { echo "   ERROR: no WATTS_DB_PASSWORD in $ENV_FILE"; exit 1; }
echo "   wrote $REMOTE_DIR/.env for compose interpolation"
cd "$REMOTE_DIR"
docker compose -p watts up -d watts-postgres
echo "   waiting for health ..."
for _ in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' watts-postgres 2>/dev/null)" = "healthy" ]; then
        echo "   healthy"; break
    fi
    sleep 2
done

echo "== 3/5 Add the /api/ location to the nginx template =="
if grep -q "watts-api:8010" "$TEMPLATE"; then
    echo "   already present, skipping"
else
    echo "   ERROR: re-run setup-droplet.sh with the updated deploy/watts-vhost.conf,"
    echo "          which now carries the location ^~ /api/ block."
    exit 1
fi

echo "== 4/5 Validate the rendered config in a throwaway container =="
set -a; source "$BASE/app/envs/prod.env"; set +a
docker run --rm \
    --network backend-prod_api-network \
    -v "$TEMPLATE:/etc/nginx/templates/nginx.conf.template:ro" \
    -v "$BASE/nginx/ssl:/etc/nginx/ssl:ro" \
    -v /var/www/watts:/var/www/watts:ro \
    -e API_PORT="${API_PORT:-8000}" \
    -e NGINX_ENVSUBST_FILTER='^API_PORT$' \
    nginx:alpine nginx -t
echo "   config valid"

echo "== 5/5 Reload nginx-proxy-prod =="
# --force-recreate for the reason spelled out in setup-droplet.sh: the template
# is rendered at container start, so an unchanged compose file means plain
# `up -d` leaves the old config live.
export ENV_NAME=prod
cd "$BASE"
docker compose -p backend-prod up -d --force-recreate --no-deps nginx

echo
echo "Done. Now run deploy/deploy-api.sh to build and release the API."
echo "Remaining manual steps:"
echo "  - put a Spaces key and secret in $ENV_FILE, and apply the CORS policy"
echo "    from the plan to the gym-junkie-01 Space (CORS is set per Space, so it"
echo "    applies to everything else in that bucket too);"
echo "  - put the Gmail App Password in WATTS_SMTP_PASSWORD in $ENV_FILE."
echo "    Password resets cannot be delivered until that is set. Check the"
echo "    droplet can reach Gmail at all first: nc -zv smtp.gmail.com 587"
