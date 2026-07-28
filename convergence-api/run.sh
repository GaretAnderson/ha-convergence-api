#!/usr/bin/with-contenv bash
set -e

GITHUB_TOKEN=$(jq -r '.github_token // empty' /data/options.json)
CARDS_REPO=$(jq -r '.cards_repo // "GaretAnderson/thread-board-cards"' /data/options.json)
RELAY_MAX=$(jq -r '.relay_max_messages // 50' /data/options.json)
RELAY_TOKEN=$(jq -r '.relay_token // empty' /data/options.json)
RELAY_TOKEN_GRACE_HOURS=$(jq -r '.relay_token_grace_hours // 24' /data/options.json)

export GITHUB_TOKEN CARDS_REPO RELAY_MAX RELAY_TOKEN RELAY_TOKEN_GRACE_HOURS

if [ -z "${RELAY_TOKEN}" ]; then
  echo "[convergence-api] WARNING: relay_token option is not set — the relay will reject all /relay and /files requests until it is configured."
else
  echo "[convergence-api] relay_token configured (auth transition grace window: ${RELAY_TOKEN_GRACE_HOURS}h from this start)"
fi

cd /app
echo "[convergence-api] Starting on port 8188 (relay max: ${RELAY_MAX})"
exec node server.js
