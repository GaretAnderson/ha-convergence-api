#!/usr/bin/with-contenv bash
set -e

# Boot-crash hardening (issue #34): v0.8.1 crashed on startup with the
# container reporting cpu=0%/empty logs — whatever failed, it failed before
# a single line reached the log. `set -e` alone gives no clue *which* command
# failed; this trap prints the failing line number + command to stderr before
# the script (and therefore the container) exits, so a boot failure can never
# be silent again. It fires for any command that fails under `set -e`,
# including the `jq` calls below.
trap 'echo "[convergence-api] FATAL: run.sh failed at line ${LINENO} (command: ${BASH_COMMAND}) — exiting" >&2' ERR

OPTIONS_FILE=/data/options.json
# Defensive: an add-on should always have /data/options.json populated by the
# Supervisor before start, but a missing/unmounted /data (fresh install race,
# manual `docker run` outside the Supervisor, etc.) previously made the very
# first `jq` call below fail-and-exit under `set -e` with zero prior output —
# exactly the "empty logs" symptom in #34. Fall back to a real (not a process
# substitution / named pipe, which can only be read once and would break the
# repeated `jq` reads below) empty-JSON file so every option below takes its
# in-script default instead of hard-failing.
if [ ! -f "${OPTIONS_FILE}" ]; then
  echo "[convergence-api] WARNING: ${OPTIONS_FILE} not found — starting with default options." >&2
  OPTIONS_FILE=/tmp/convergence-api-default-options.json
  echo '{}' > "${OPTIONS_FILE}"
fi

GITHUB_TOKEN=$(jq -r '.github_token // empty' "${OPTIONS_FILE}")
CARDS_REPO=$(jq -r '.cards_repo // "GaretAnderson/thread-board-cards"' "${OPTIONS_FILE}")
RELAY_MAX=$(jq -r '.relay_max_messages // 50' "${OPTIONS_FILE}")
RELAY_TOKEN=$(jq -r '.relay_token // empty' "${OPTIONS_FILE}")
RELAY_TOKEN_GRACE_HOURS=$(jq -r '.relay_token_grace_hours // 24' "${OPTIONS_FILE}")

export GITHUB_TOKEN CARDS_REPO RELAY_MAX RELAY_TOKEN RELAY_TOKEN_GRACE_HOURS

if [ -z "${RELAY_TOKEN}" ]; then
  echo "[convergence-api] WARNING: relay_token option is not set — the relay will reject all /relay and /files requests until it is configured."
else
  echo "[convergence-api] relay_token configured (auth transition grace window: ${RELAY_TOKEN_GRACE_HOURS}h from this start)"
fi

cd /app
echo "[convergence-api] Starting on port 8188 (relay max: ${RELAY_MAX})"
exec node server.js
