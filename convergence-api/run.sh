#!/usr/bin/with-contenv bash
set -e

GITHUB_TOKEN=$(jq -r '.github_token // empty' /data/options.json)
CARDS_REPO=$(jq -r '.cards_repo // "GaretAnderson/thread-board-cards"' /data/options.json)
RELAY_MAX=$(jq -r '.relay_max_messages // 50' /data/options.json)

export GITHUB_TOKEN CARDS_REPO RELAY_MAX

cd /app
echo "[convergence-api] Starting on port 8088 (relay max: ${RELAY_MAX})"
exec node server.js
