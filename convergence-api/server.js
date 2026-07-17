const express = require('express');
const app = express();
const PORT = 8088;
// Ingress uses a separate internal port so the published relay port (8088, used
// by CLI tools + HA rest_command) doesn't collide with ingress_port — that
// collision breaks HA sidebar-panel injection.
const INGRESS_PORT = parseInt(process.env.INGRESS_PORT || '8099', 10);
const RELAY_MAX = parseInt(process.env.RELAY_MAX || '5000', 10);

app.use(express.json());

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: '0.6.1' });
});

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
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    from: req.body.from || 'unknown',
    to: req.body.to || null,
    body: req.body.body || '',
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
app.get('/relay/:topic', (req, res) => {
  const topic = getTopic(req.params.topic);
  const since = req.query.since; // ISO timestamp filter
  let messages = topic.messages;
  if (since) {
    messages = messages.filter(m => m.timestamp > since);
  }
  res.json({ topic: req.params.topic, count: messages.length, messages });
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
  console.log(`  Relay max messages per topic: ${RELAY_MAX}`);
});

// Second listener for Home Assistant ingress (sidebar panel). Same app, distinct
// internal port so it doesn't collide with the published relay port.
if (INGRESS_PORT && INGRESS_PORT !== PORT) {
  app.listen(INGRESS_PORT, '0.0.0.0', () => {
    console.log(`Ingress (HA sidebar) listening on port ${INGRESS_PORT}`);
  });
}
