'use strict';

const fsSync = require('fs');

// ─── Boot-crash hardening (issue #34, kept per #43) ─────────────────────────
// A prior release crashed on startup with *empty logs* — the container
// exited before anything reached the log, so root cause could never be
// pinned down. These handlers make that class of failure structurally
// impossible: any uncaught throw or rejection anywhere in the process
// (including at require()/module-init time, before app.listen()) is written
// *synchronously* to fd 2 with `fs.writeSync` — bypassing Node's normal
// async stdio stream, which can be buffered and lost if the process exits
// before it flushes — and then exits non-zero. A boot crash can now never be
// silent again.
function logFatal(context, err) {
  const msg = `[fatal] ${context}: ${err && err.stack ? err.stack : err}\n`;
  try { fsSync.writeSync(2, msg); } catch { /* fd 2 unavailable; nothing more we can do */ }
}

process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logFatal('unhandledRejection', reason);
  process.exit(1);
});

const express = require('express');
const { renderMessageHtml } = require('./render.js');
const { loadChannels, defaultVisible } = require('./channels.js');
const { loadChannelHistory } = require('./history.js');
const app = express();
// Keep the proven-live port mapping (issue #43) — do NOT switch to 8188.
const PORT = 8088;
// Ingress uses a separate internal port so the published relay port (8088, used
// by CLI tools + HA rest_command) doesn't collide with ingress_port — that
// collision breaks HA sidebar-panel injection.
const INGRESS_PORT = parseInt(process.env.INGRESS_PORT || '8099', 10);
const RELAY_MAX = parseInt(process.env.RELAY_MAX || '5000', 10);

app.use(express.json());

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: '0.9.5' });
});

// ─── Relay auth (issue #43) ──────────────────────────────────────────────────
// Auth enforcement is intentionally NOT wired here — the live relay is open
// (no token required) today, and shipping markdown rendering must not change
// that security posture. `auth.js` exists and is unit-tested for a future,
// separately-reviewed change that adds real enforcement; it stays unused by
// server.js until that change ships.

// ─── File Upload + Serving ───────────────────────────────────────────────────

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/files';
const DATA_DIR = process.env.DATA_DIR || path.dirname(UPLOAD_DIR);
const STORE_FILE = path.join(DATA_DIR, 'relay-messages.json');
const RETENTION_MS = parseInt(process.env.RETENTION_DAYS || '90', 10) * 86400000;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// POST /relay/upload — upload a file, get back a URL
app.post('/relay/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  const ext = (req.headers['content-type'] || 'application/octet-stream').split('/')[1] || 'bin';
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${id}.${ext.replace(/[^a-z0-9]/g, '')}`;
  const filepath = path.join(UPLOAD_DIR, filename);

  fs.writeFileSync(filepath, req.body);
  const url = `/files/${filename}`;
  console.log(`[upload] ${filename} (${req.body.length} bytes)`);
  res.status(201).json({ id, filename, url, size: req.body.length });
});

// GET /files/:filename — serve uploaded files
app.get('/files/:filename', (req, res) => {
  const filepath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'not found' });
  res.sendFile(filepath);
});

// ─── Chat PWA
// ─── Agent Relay ─────────────────────────────────────────────────────────────
// In-memory pub/sub with SSE push. Topics created on first use.

const topics = new Map(); // topic -> { messages: [], subscribers: Set<res> }

function getTopic(name) {
  if (!topics.has(name)) {
    topics.set(name, { messages: [], subscribers: new Set() });
  }
  return topics.get(name);
}

// ─── Purpose-channels (garets-config#1051 v1) ────────────────────────────────
// Registry-driven channel model — replaces/subsumes @aorus/@laptop addressing.
// Per-channel enable/disable persists across restarts (own small JSON file,
// same pattern as relay-messages.json below). A disabled channel never
// ingests: the history endpoint refuses to pull for it (see /channel/:id/history).

const CHANNEL_STATE_FILE = path.join(DATA_DIR, 'channel-state.json');
let channelState = {}; // channelId -> boolean (enabled override)

function loadChannelState() {
  try {
    if (fs.existsSync(CHANNEL_STATE_FILE)) {
      channelState = JSON.parse(fs.readFileSync(CHANNEL_STATE_FILE, 'utf8')) || {};
    }
  } catch (e) { console.error('[channels] state load failed:', e.message); }
}
function saveChannelState() {
  try { fs.writeFileSync(CHANNEL_STATE_FILE, JSON.stringify(channelState)); }
  catch (e) { console.error('[channels] state save failed:', e.message); }
}
loadChannelState();

function channelsWithState() {
  return loadChannels().map((c) => ({
    ...c,
    enabled: Object.prototype.hasOwnProperty.call(channelState, c.id) ? !!channelState[c.id] : !!c.enabledByDefault
  }));
}

// GET /channels — registry-driven channel list (garets-config#1051), each with
// its persisted enabled/disabled state. Guru ships disabled by default and
// stays absent from the default view unless explicitly enabled.
app.get('/channels', (_req, res) => {
  res.json({ channels: channelsWithState() });
});

// POST /channels/:id/enabled — toggle a channel; persists across restarts.
app.post('/channels/:id/enabled', (req, res) => {
  const all = loadChannels();
  const channel = all.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'unknown channel' });
  channelState[req.params.id] = !!req.body.enabled;
  saveChannelState();
  console.log(`[channels] ${req.params.id}: enabled=${channelState[req.params.id]}`);
  res.json({ id: req.params.id, enabled: channelState[req.params.id] });
});

// GET /channel/:id/history — C-pull "load full history" (garets-config#1051):
// reconstructs the channel's transcript from events.jsonl + session-review
// artifacts, v1 sourced with NO hard dependency on the session ledger #1019.
// A disabled channel ingests nothing — refuse the pull with 403.
app.get('/channel/:id/history', (req, res) => {
  const all = loadChannels();
  const channel = all.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'unknown channel' });
  const enabled = Object.prototype.hasOwnProperty.call(channelState, channel.id)
    ? !!channelState[channel.id]
    : !!channel.enabledByDefault;
  if (!enabled) return res.status(403).json({ error: 'channel disabled — ingests nothing' });
  if (channel.ingestionPolicy === 'none') return res.status(403).json({ error: 'channel domain never ingests (life/local-only)' });
  res.json(loadChannelHistory(channel));
});

// ─── Persistence (survives restarts; 90-day retention) ───────────────────────

function pruneMessages(topic) {
  const cutoff = Date.now() - RETENTION_MS;
  topic.messages = topic.messages.filter(m => new Date(m.timestamp).getTime() >= cutoff);
  if (topic.messages.length > RELAY_MAX) topic.messages = topic.messages.slice(-RELAY_MAX);
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = {};
      for (const [name, t] of topics) out[name] = t.messages;
      fs.writeFileSync(STORE_FILE, JSON.stringify(out));
    } catch (e) { console.error('[store] save failed:', e.message); }
  }, 400);
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const [name, msgs] of Object.entries(data)) {
      const t = getTopic(name);
      t.messages = Array.isArray(msgs) ? msgs : [];
      pruneMessages(t);
    }
    console.log('[store] loaded', Object.keys(data).length, 'topic(s)');
  } catch (e) { console.error('[store] load failed:', e.message); }
}

function pruneFiles() {
  const cutoff = Date.now() - RETENTION_MS;
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

loadStore();
// Hourly maintenance: age out messages + orphaned files
setInterval(() => {
  for (const t of topics.values()) pruneMessages(t);
  pruneFiles();
  saveStore();
}, 3600000);

// POST /relay/:topic — publish a message
app.post('/relay/:topic', (req, res) => {
  const topic = getTopic(req.params.topic);
  const body = req.body.body || '';
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    from: req.body.from || 'unknown',
    to: req.body.to || null,
    body,
    // Sanitized markdown rendering of `body` (issue #43), safe to insert via
    // innerHTML. Computed once at publish time so every consumer (poll, SSE,
    // /chat) gets identical rendering without re-parsing markdown client-side.
    bodyHtml: renderMessageHtml(body),
    attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
    replyTo: req.body.replyTo || null,
    metadata: req.body.metadata || {},
    receipts: { delivered: [], read: [] }
  };

  topic.messages.push(msg);
  pruneMessages(topic);
  saveStore();

  // Push to SSE subscribers
  for (const sub of topic.subscribers) {
    sub.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  console.log(`[relay] ${req.params.topic}: ${msg.from} -> "${msg.body.slice(0, 80)}"`);
  res.status(201).json(msg);
});

// GET /relay/:topic — poll recent messages
// Query params:
//   since=<ISO>   — messages strictly newer than this (responder polling; unpaged)
//   before=<id>   — only messages older than the message with this id (page back)
//   limit=<n>     — return at most the newest n of the (filtered) set
// Response includes `hasMore` = older messages exist beyond the returned window.
app.get('/relay/:topic', (req, res) => {
  const topic = getTopic(req.params.topic);
  const { since, before } = req.query;
  const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit, 10) || 0) : 0;

  let messages = topic.messages;
  if (since) messages = messages.filter(m => m.timestamp > since);
  if (before) {
    const idx = messages.findIndex(m => m.id === before);
    if (idx >= 0) messages = messages.slice(0, idx);
  }

  let hasMore = false;
  if (limit && messages.length > limit) {
    hasMore = true;
    messages = messages.slice(-limit);
  }

  res.json({ topic: req.params.topic, count: messages.length, messages, hasMore });
});

// DELETE /relay/:topic/:id — delete a message (notifies subscribers)
app.delete('/relay/:topic/:id', (req, res) => {
  const topic = getTopic(req.params.topic);
  const before = topic.messages.length;
  topic.messages = topic.messages.filter(m => m.id !== req.params.id);
  if (topic.messages.length === before) return res.status(404).json({ error: 'not found' });
  saveStore();
  for (const sub of topic.subscribers) {
    sub.write(`data: ${JSON.stringify({ deleted: req.params.id })}\n\n`);
  }
  console.log(`[relay] ${req.params.topic}: deleted ${req.params.id}`);
  res.json({ deleted: req.params.id });
});

// POST /relay/:topic/:id/receipt — acknowledge delivery/read of a message
app.post('/relay/:topic/:id/receipt', (req, res) => {
  const topic = getTopic(req.params.topic);
  const msg = topic.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'not found' });

  const agent = (req.body.from || req.body.agent || 'unknown').toString();
  const status = req.body.status === 'read' ? 'read' : 'delivered';
  if (!msg.receipts) msg.receipts = { delivered: [], read: [] };
  if (!Array.isArray(msg.receipts.delivered)) msg.receipts.delivered = [];
  if (!Array.isArray(msg.receipts.read)) msg.receipts.read = [];

  // A read receipt implies delivered too.
  if (!msg.receipts.delivered.includes(agent)) msg.receipts.delivered.push(agent);
  if (status === 'read' && !msg.receipts.read.includes(agent)) msg.receipts.read.push(agent);

  saveStore();
  const evt = { receipt: { id: msg.id, agent, status, receipts: msg.receipts } };
  for (const sub of topic.subscribers) {
    sub.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  console.log(`[relay] ${req.params.topic}: receipt ${status} for ${msg.id} by ${agent}`);
  res.json(evt.receipt);
});

// GET /relay/:topic/stream — SSE subscription
app.get('/relay/:topic/stream', (req, res) => {
  const topic = getTopic(req.params.topic);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send keepalive comment immediately
  res.write(': connected\n\n');

  topic.subscribers.add(res);
  console.log(`[relay] ${req.params.topic}: subscriber connected (${topic.subscribers.size} total)`);

  // Keepalive every 30s
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);

  req.on('close', () => {
    topic.subscribers.delete(res);
    clearInterval(keepalive);
    console.log(`[relay] ${req.params.topic}: subscriber disconnected (${topic.subscribers.size} remaining)`);
  });
});

// GET /relay — list all active topics
app.get('/relay', (_req, res) => {
  const summary = {};
  for (const [name, topic] of topics) {
    summary[name] = {
      messageCount: topic.messages.length,
      subscriberCount: topic.subscribers.size,
      lastMessage: topic.messages.length > 0
        ? topic.messages[topic.messages.length - 1].timestamp
        : null
    };
  }
  res.json(summary);
});



// ─── Chat PWA ────────────────────────────────────────────────────────────────

app.get('/chat', (_req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

// Ingress serves the addon at its root path — surface the chat there too so it
// appears as a native Home Assistant sidebar panel ("Agent Chat").
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});
// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Convergence API listening on port ${PORT}`);
  console.log(`  /api/health       — health check`);
  console.log(`  /relay/:topic     — publish (POST) / poll (GET)`);
  console.log(`  /relay/:topic/stream — SSE subscribe`);
  console.log(`  /channels         — purpose-channel registry (garets-config#1051)`);
  console.log(`  /channel/:id/history — C-pull full transcript (events.jsonl + session-review)`);
  console.log(`  /chat             — Agent Chat web UI (renders sanitized markdown)`);
  console.log(`  Relay max messages per topic: ${RELAY_MAX}`);
  console.log(`  Relay auth: OPEN (no relay_token enforcement — see issue #43)`);
}).on('error', (err) => {
  logFatal(`failed to bind relay port ${PORT}`, err);
  process.exit(1);
});

// Second listener for Home Assistant ingress (sidebar panel). Same app, distinct
// internal port so it doesn't collide with the published relay port.
if (INGRESS_PORT && INGRESS_PORT !== PORT) {
  app.listen(INGRESS_PORT, '0.0.0.0', () => {
    console.log(`Ingress (HA sidebar) listening on port ${INGRESS_PORT}`);
  }).on('error', (err) => {
    logFatal(`failed to bind ingress port ${INGRESS_PORT}`, err);
    process.exit(1);
  });
}
