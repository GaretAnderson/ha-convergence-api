# Convergence API

Always-on API add-on for Home Assistant. Provides:

- **Agent Relay** — real-time cross-machine messaging via SSE
- **Health endpoint** — uptime and version check

## API

For the live API surface, version, route list, schema, and retention details, query the relay directly:

```bash
curl http://homeassistant.local:8088/api/manifest
```

Use `/api/manifest` as the source of truth instead of copying route tables into documentation.

## Agent Relay

In-memory pub/sub. Topics created on first use. Messages capped at 50 per topic (configurable).

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
| `relay_max_messages` | 500 | Max messages retained per topic |

## Port

Listens on **8088** (configurable in config.yaml).
