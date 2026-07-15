# Convergence API

Always-on API add-on for Home Assistant. Provides:

- **Agent Relay** — real-time cross-machine messaging via SSE
- **Health endpoint** — uptime and version check

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (uptime, version) |
| POST | `/relay/:topic` | Publish a message to a topic |
| GET | `/relay/:topic` | Poll recent messages (optional `?since=` ISO timestamp) |
| GET | `/relay/:topic/stream` | SSE subscription (real-time push) |
| GET | `/relay` | List all active topics with stats |

## Agent Relay

In-memory pub/sub. Topics created on first use. Messages capped at 50 per topic (configurable).

### Publish
```bash
curl -X POST http://homeassistant.local:8188/relay/agent-relay \
  -H "Content-Type: application/json" \
  -d '{"from":"garets-copilot@AORUS","body":"What is the SubstrateBE refresh schedule?","replyTo":"reply-abc123"}'
```

### Subscribe (SSE)
```bash
curl -N http://homeassistant.local:8188/relay/agent-relay/stream
```

### Poll
```bash
curl http://homeassistant.local:8188/relay/agent-relay
curl http://homeassistant.local:8188/relay/agent-relay?since=2026-07-13T12:00:00Z
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `github_token` | (empty) | GitHub PAT for future thread-board integration |
| `cards_repo` | `GaretAnderson/thread-board-cards` | Thread board cards repo |
| `relay_max_messages` | 50 | Max messages retained per topic |

## Port

Listens on **8188** (configurable in config.yaml).
