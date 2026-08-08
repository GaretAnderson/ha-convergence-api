# Convergence API

Always-on API add-on for Home Assistant. Provides:

- **Agent Relay** — real-time cross-machine messaging via SSE
- **Agent Chat** — a chat UI (`/chat`) with server-rendered, sanitized markdown,
  organized into **registry-driven purpose-channels** (helper/tutor/advisor/threads;
  guru disabled/local-only by default — garets-config#1051)
- **Health endpoint** — uptime and version check

## Local development

Run the whole thing on your machine — server + a single **echo responder** — to
validate the garets-chat look and live behavior before pushing to HAOS. You
won't have the full multi-agent prod deployment, but the responder replies to
whatever you send so you can exercise the real send/receive path:

```bash
cd convergence-api
npm install        # first time only (installs dev deps too)
npm run dev        # boots server.js on :8088 + the echo responder
```

Then open **http://127.0.0.1:8088/chat** (the script tries to open it for you).

The echo responder subscribes to the `agent-relay` topic over SSE and, for every
message you send:

- posts a **delivery + read receipt** as the addressed agent (the inline receipt
  name lights up teal — proves the receipt path), and
- **replies** with a markdown message that echoes your text and reports the `to`
  it was addressed with — so you can confirm each channel tab wires `to`
  correctly and that server-side markdown rendering works.

It answers as the agent implied by the active tab's `to` (helper / tutor /
advisor / threads), so switching tabs feels like talking to different agents.
**guru stays gated** (life-domain — shown as a disabled outline pill, never
networked). This lets you verify the pill bar, sending/receiving, receipts,
markdown, the collapsing header, and
the sticky composer — all locally. `Ctrl+C` stops the server and responder.

> Relay state persists between dev runs under `convergence-api/.dev-data/`
> (gitignored). Delete it to start from an empty transcript. Note: `server.js`
> binds port **8088** by hard-code, so free that port first if it's in use.

Run the browser (Playwright) UI checks with:

```bash
npm run test:gui   # real Chromium: rebrand, pills-only bar, select/toggle, collapse, composer
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (uptime, version) |
| POST | `/relay/:topic` | Publish a message to a topic |
| GET | `/relay/:topic` | Poll recent messages (optional `?since=` ISO timestamp) |
| GET | `/relay/:topic/stream` | SSE subscription (real-time push) |
| GET | `/relay` | List all active topics with stats |
| GET | `/channels` | Purpose-channel registry, each with its persisted enabled/disabled state |
| POST | `/channels/:id/enabled` | Enable/disable a channel (`{"enabled": true\|false}`); persists across restarts |
| GET | `/channel/:id/history` | C-pull "load full history" — reconstructs the channel's transcript from `events.jsonl` + session-review artifacts. 403 if the channel is disabled or its domain never ingests (`life`, e.g. guru). |

## Purpose-channels (garets-config#1051)

Agent Chat is organized into one channel per agent **purpose** (helper / tutor /
advisor / threads), not per machine — replacing the old `@aorus`/`@laptop`/`@all`
addressing. The channel list, domain classification (`life`/`work`/`shared`), and
default enable state are **registry-driven**: `channels.json` is a vendored
snapshot of garets-config's canonical `Get-RelayChannelRegistry`
(`lib/RelayResponder.ps1`), exported via `tools/Export-AgentChatChannels.ps1`.
Re-export + copy `channels.json` here whenever the garets-config registry changes.

- **guru** is `life`-domain, ships **disabled by default**, and its ingestion
  policy is always `none` (never pulled/ingested) — fail-closed local-only,
  per garets-config#908.
- **C-pull** ("load full history") sources v1 transcripts from `events.jsonl` +
  session-review markdown — see `history.js`. Configure `AGENT_EVENTS_ROOT` /
  `AGENT_SESSION_REVIEW_ROOT` to point at the mounted Copilot CLI session-state
  directories; missing/unmounted paths degrade to an empty transcript, never
  an error. No hard dependency on the (unbuilt) session ledger garets-config#1019.
- Channel tabs collapse on scroll-down and reveal on scroll-up; the composer
  (`#input-bar`) is sticky and always visible, at every scroll position,
  desktop and mobile.

## Agent Relay

In-memory pub/sub. Topics created on first use. Messages capped at 50 per topic (configurable).

**The relay is open** — no auth token is required today (auth enforcement is
tracked separately and not part of this add-on's current security posture).

Every published message's `body` is rendered server-side to sanitized HTML
(`bodyHtml`) via `render.js` (GFM markdown: bold/italic, links, lists,
tables, code, blockquotes) — `/chat` renders `bodyHtml` directly.

### Publish
```bash
curl -X POST http://homeassistant.local:8088/relay/agent-relay \
  -H "Content-Type: application/json" \
  -d '{"from":"garets-copilot@AORUS","body":"What is the SubstrateBE refresh schedule?","replyTo":"reply-abc123"}'
```

### Subscribe (SSE)
```bash
curl -N http://homeassistant.local:8088/relay/agent-relay/stream
```

### Poll
```bash
curl http://homeassistant.local:8088/relay/agent-relay
curl http://homeassistant.local:8088/relay/agent-relay?since=2026-07-13T12:00:00Z
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `github_token` | (empty) | GitHub PAT for future thread-board integration |
| `cards_repo` | `GaretAnderson/thread-board-cards` | Thread board cards repo |
| `relay_max_messages` | 50 | Max messages retained per topic |

## Environment variables (channels / C-pull)

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_EVENTS_ROOT` | (unset) | Root directory containing `<agent>/**/events.jsonl` session logs, for C-pull |
| `AGENT_SESSION_REVIEW_ROOT` | (unset) | Root directory containing `<agent>/*.md` session-review summaries |

## Port

Listens on **8088** (configurable in config.yaml).
