#!/usr/bin/with-contenv bash

# Boot-crash hardening (issue #34, and the repeat crash in issue #37):
# v0.8.1 *and* v0.9.0 both crashed on startup on the live HAOS add-on with
# `state=started`, `cpu=0%`, **empty logs**, and port 8188 refused — twice,
# on the identical signature. The #34 fix added an ERR trap further down this
# script, but that trap only fires for a command that fails *after* it is
# installed; it cannot explain a process that is killed (e.g. OOM-killed by
# the low-power HAOS host under memory pressure — `cpu=0%, mem=0.1%` is
# exactly what a container looks like a moment after its main process was
# SIGKILLed) or a shebang/interpreter failure that happens before any bash
# code runs at all. This first line is unconditional and runs before
# anything else — including `set -e` and the trap below — can fail, so a
# boot attempt is now provably ALWAYS logged at least once, no matter what
# happens next.
echo "[convergence-api] run.sh starting (pid $$)" >&2

set -e

# `set -e` alone gives no clue *which* command failed; this trap prints the
# failing line number + command to stderr before the script (and therefore
# the container) exits, so a boot failure can never be silent again. It
# fires for any command that fails under `set -e`, including the `jq` calls
# below.
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

# Fail loudly (with the actual jq parse error) on malformed options.json
# instead of letting the generic ERR trap below report only a bare "jq
# failed at line N" with no detail on *why* the JSON was rejected — a
# Supervisor schema migration (e.g. this add-on's #31 relay_token addition)
# is exactly the kind of change that could leave a stale/partial
# options.json on an existing install.
if ! jq empty "${OPTIONS_FILE}" 2>/tmp/convergence-api-jq-error.log; then
  echo "[convergence-api] FATAL: ${OPTIONS_FILE} is not valid JSON:" >&2
  cat /tmp/convergence-api-jq-error.log >&2
  exit 1
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

# Deliberately NOT `exec node server.js` here (issue #37): `exec` replaces
# this shell with node, so if node is killed by something the shell never
# sees or logs (most notably SIGKILL from the OOM killer — a container that
# reports `cpu=0%, mem=0.1%` right after `state=started` looks exactly like
# its main process was killed within the first fraction of a second, before
# it had done any measurable work) the container just silently disappears
# with whatever node itself managed to flush, which can be nothing. Running
# node as a supervised child instead means THIS script is still alive to
# observe and log the exit — including the signal name for a kill — no
# matter how abruptly node itself goes away, so a boot failure can never
# again reach the live add-on with zero explanation. Node runs in the
# background with its PID tracked so s6's normal SIGTERM stop signal (sent
# to this script as PID 1) is forwarded for a clean shutdown instead of
# leaving it orphaned.
node server.js &
NODE_PID=$!
trap 'echo "[convergence-api] received stop signal — forwarding to node (pid ${NODE_PID})" >&2; kill -TERM "${NODE_PID}" 2>/dev/null' TERM INT

set +e
wait "${NODE_PID}"
NODE_EXIT_CODE=$?
set -e

if [ "${NODE_EXIT_CODE}" -gt 128 ]; then
  NODE_SIGNAL=$((NODE_EXIT_CODE - 128))
  SIGNAL_NAME=$(kill -l "${NODE_SIGNAL}" 2>/dev/null || echo "unknown")
  echo "[convergence-api] FATAL: node server.js was terminated by signal ${NODE_SIGNAL} (${SIGNAL_NAME}) — this usually means it was killed (e.g. OOM-killed by the host) rather than exiting on its own." >&2
else
  echo "[convergence-api] node server.js exited with code ${NODE_EXIT_CODE}" >&2
fi

exit "${NODE_EXIT_CODE}"
