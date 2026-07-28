#!/bin/bash
# Build and publish the site to watts.moates.com.au (droplet ssh alias: do).
# One-time vhost setup lives in setup-droplet.sh; this is the everyday deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist .parcel-cache
npm run build
rsync -az --delete --exclude '*.map' dist/ do:/var/www/watts/
echo "Deployed to https://watts.moates.com.au"
