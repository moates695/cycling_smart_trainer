#!/bin/bash
# One-time setup of watts.moates.com.au vhost on the nginx-proxy-prod stack.
# Safe to re-run (idempotent). Validates config before touching the live proxy.
set -euo pipefail

BASE=/root/gym_junkie_server
TEMPLATE=$BASE/nginx/nginx.conf.template
COMPOSE=$BASE/docker-compose.yml

echo "== 1/5 Append watts vhost to nginx template =="
if grep -q "watts.moates.com.au" "$TEMPLATE"; then
    echo "   already present, skipping"
else
    cat /tmp/watts-vhost.conf >> "$TEMPLATE"
    echo "   appended"
fi

echo "== 2/5 Add /var/www/watts volume to docker-compose.yml =="
if grep -q "/var/www/watts" "$COMPOSE"; then
    echo "   already present, skipping"
else
    sed -i 's|      - ./nginx/ssl:/etc/nginx/ssl:ro|      - ./nginx/ssl:/etc/nginx/ssl:ro\n      - /var/www/watts:/var/www/watts:ro|' "$COMPOSE"
    grep -q "/var/www/watts" "$COMPOSE" || { echo "   ERROR: volume insert failed"; exit 1; }
    echo "   added"
fi

echo "== 3/5 Validate rendered config in a throwaway container =="
set -a; source "$BASE/app/envs/prod.env"; set +a
docker run --rm \
    --network backend-prod_api-network \
    -v "$BASE/nginx/nginx.conf.template:/etc/nginx/templates/nginx.conf.template:ro" \
    -v "$BASE/nginx/ssl:/etc/nginx/ssl:ro" \
    -v /var/www/watts:/var/www/watts:ro \
    -e API_PORT="${API_PORT:-8000}" \
    -e NGINX_ENVSUBST_FILTER='^API_PORT$' \
    nginx:alpine nginx -t
echo "   config valid"

echo "== 4/5 Recreate nginx-proxy-prod with new mount + config =="
export ENV_NAME=prod
cd "$BASE"
docker compose -p backend-prod up -d --no-deps nginx

echo "== 5/5 Verify =="
sleep 2
docker ps --filter name=nginx-proxy-prod --format '{{.Names}} {{.Status}}'
curl -sk --resolve watts.moates.com.au:443:127.0.0.1 https://watts.moates.com.au/ | grep -o "<title>[^<]*</title>" || echo "WARN: could not fetch title locally"
echo "Done. Check https://watts.moates.com.au in a browser."
