# Convergence API

Always-on API add-on for Home Assistant. Provides:

- **Agent Relay** — real-time cross-machine messaging via SSE, with sanitized markdown rendering and multi-recipient addressing
- **Shared-secret auth** — every `/relay*` and `/files/*` route requires a token
- **Health endpoint** — uptime and version check (unauthenticated)

> **Canonical source.** This repo (`GaretAnderson/ha-convergence-api`) is the
> canonical, deployed source for the live relay on port **8188** — the add-on
> Home Assistant Supervisor actually installs from. The `addons/convergence-api/`
> copy in `GaretAnderson/homeassistant` is a **retired/legacy reference fork**;
> it is not live and should not receive new feature work. See issue #31.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | none | Health check (uptime, version) |
| POST | `/relay/:topic` | required | Publish a message to a topic |
| GET | `/relay/:topic` | required | Poll recent messages (`?since=`, `?before=`, `?limit=`) |
| GET | `/relay/:topic/stream` | required | SSE subscription (real-time push) |
| DELETE | `/relay/:topic/:id` | required | Delete a message |
| POST | `/relay/:topic/:id/receipt` | required | Acknowledge delivery/read |
| GET | `/relay` | required | List all active topics with stats |
| POST | `/relay/upload` | required | Upload an image attachment, get back a URL |
| GET | `/files/:filename` | required | Serve an uploaded attachment |
| GET | `/chat` | none (page only; API calls from the page still need a token) | Agent Chat web UI |

## Auth

Every `/relay*` and `/files/*` request requires the shared secret configured
in the `relay_token` add-on option (HA UI → this add-on → Configuration; never
committed to git). The token is accepted two ways:

- `Authorization: Bearer <token>` header — used by CLI/PowerShell clients (see
  `GaretAnderson/garets-config` `lib/RelayAuth.ps1`, PR #965)
- `?token=<token>` query param — used by the `/chat` web UI, browser
  `EventSource` (SSE) connections, and `<img src>` attachment tags, none of
  which can set a custom request header

**Fails closed:** if `relay_token` is unset, every `/relay*`/`/files/*`
request is rejected (`401`/`503`) rather than the relay silently running
open — a fresh or misconfigured install can never reproduce the
unauthenticated exposure this fixes (issue #24 / #29).

**Deploy-order transition (no client lockout):** the first time `relay_token`
is set (or rotated) on a running deployment, older/not-yet-updated clients
that don't send a token yet would otherwise be hard-401'd the instant the
add-on restarts. `relay_token_grace_hours` (default **24**, `0` disables)
gives a bounded window — counted from the add-on's process start — during
which requests without a valid token are still let through (each one logged
with a `[relay] WARNING`, and marked with an `X-Relay-Auth-Grace: active`
response header) so the rollout can happen without locking anyone out. This
never weakens the fails-closed guarantee above: an unset `relay_token` still
always `503`s regardless of the grace window. Once the window lapses (or with
it disabled), missing/invalid tokens get a clear `401` with a
`WWW-Authenticate: Bearer` header and a `hint` field in the JSON body
explaining exactly how to authenticate.

**Phone/browser UI token path (no lockout):** the `/chat` page itself loads
without a token, then prompts once for the relay token and stores it in the
browser's `localStorage` (key `agentChatRelayToken`) so it isn't asked again.
Tap the 🔑 button in the header to view/change the stored token at any time —
this is the recovery path if a device is showing "unauthorized" after the
token is rotated.

```bash
# Publish (Authorization header)
curl -X POST http://homeassistant.local:8188/relay/agent-relay \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"garets-copilot@AORUS","to":["@aorus"],"body":"What is the SubstrateBE refresh schedule?","replyTo":"reply-abc123"}'

# Subscribe (SSE — token via query param, browsers can't set headers on EventSource)
curl -N "http://homeassistant.local:8188/relay/agent-relay/stream?token=$RELAY_TOKEN"

# Poll
curl -H "Authorization: Bearer $RELAY_TOKEN" http://homeassistant.local:8188/relay/agent-relay
```

## Agent Relay

In-memory pub/sub, persisted to disk (90-day retention). Topics created on
first use. Messages capped at 500 per topic (configurable).

### Recipients (`to`)

`to` is a string array of handles (e.g. `["@aorus", "@laptop"]`). A single
string is still accepted from legacy senders and normalized to a one-element
array. **There is no `@all` broadcast** — address every handle explicitly if
a message is meant for everyone (garets-config#901 Phase 1). See
`addressing.js` for the addressable `HANDLES` list and matching helpers.

### Markdown rendering

`body` is rendered server-side (once, at publish time) into sanitized HTML in
the `bodyHtml` field via `render.js` (GFM `marked` → strict-allowlist
`sanitize-html`): tables, links (forced `target="_blank" rel="noopener
noreferrer"`), bold/italic, inline + fenced code, lists, headings, and
blockquotes all render as HTML. No raw HTML, `<script>`, or `javascript:`
links can pass through — every consumer (poll, SSE, `/chat`) gets identical,
pre-sanitized output without re-parsing markdown client-side. `[[attach:
<url>]]` tokens are stripped from the markdown source and re-appended as
sanitized `<img>` tags.

### Publish
```bash
curl -X POST http://homeassistant.local:8188/relay/agent-relay \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"garets-copilot@AORUS","to":["@aorus"],"body":"**Status:** all green ✅","replyTo":"reply-abc123"}'
```

### Subscribe (SSE)
```bash
curl -N "http://homeassistant.local:8188/relay/agent-relay/stream?token=$RELAY_TOKEN"
```

### Poll
```bash
curl -H "Authorization: Bearer $RELAY_TOKEN" http://homeassistant.local:8188/relay/agent-relay
curl -H "Authorization: Bearer $RELAY_TOKEN" "http://homeassistant.local:8188/relay/agent-relay?since=2026-07-13T12:00:00Z"
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `github_token` | (empty) | GitHub PAT for future thread-board integration |
| `cards_repo` | `GaretAnderson/thread-board-cards` | Thread board cards repo |
| `relay_max_messages` | 500 | Max messages retained per topic |
| `relay_token` | (empty) | Shared secret required on every `/relay*`/`/files/*` request. **Must be set** — the relay fails closed if empty. |
| `relay_token_grace_hours` | 24 | Hours after add-on start during which requests without a valid token are still let through (logged) once `relay_token` is set, so a rollout doesn't lock out old clients. `0` disables the grace window. |

## Testing

```bash
npm ci
npm test              # unit tests (receipts, addressing, auth incl. grace-window) + render.js sanitization tests
                       # + a startup smoke test (spawns the real server, asserts it binds 8188 and
                       # answers /api/health — issue #34's regression guard)
npx playwright install chromium
node tests/paste.integration.js              # end-to-end: paste/upload/send/persist/delete, with auth
node tests/attachment-xss.integration.js     # end-to-end: attachments[] XSS probe (javascript:/data:/attribute-breakout)
```

CI (`.github/workflows/ci.yml`) runs `npm test` on every push/PR, **and**
separately builds the actual add-on Docker image and runs it (no `/data`
mounted, exercising `run.sh`'s missing-`options.json` fallback) to assert it
binds port 8188 and answers `/api/health` before the job can pass — the exact
check that would have caught the v0.8.1 boot-crash (issue #34) before it ever
reached the live add-on.

## Port

Listens on **8188** (configurable in config.yaml). This is the canonical,
deployed port — see `machines/homeassistant.md` in `garets-config`.
