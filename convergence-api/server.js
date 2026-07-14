const express = require('express');
const app = express();
const PORT = 8088;
const RELAY_MAX = parseInt(process.env.RELAY_MAX || '50', 10);

app.use(express.json());

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: '0.3.1' });
});

// ─── Agent Relay ─────────────────────────────────────────────────────────────
// In-memory pub/sub with SSE push. Topics created on first use.

const topics = new Map(); // topic -> { messages: [], subscribers: Set<res> }

function getTopic(name) {
  if (!topics.has(name)) {
    topics.set(name, { messages: [], subscribers: new Set() });
  }
  return topics.get(name);
}

// POST /relay/:topic — publish a message
app.post('/relay/:topic', (req, res) => {
  const topic = getTopic(req.params.topic);
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    from: req.body.from || 'unknown',
    body: req.body.body || '',
    replyTo: req.body.replyTo || null,
    metadata: req.body.metadata || {}
  };

  topic.messages.push(msg);
  if (topic.messages.length > RELAY_MAX) {
    topic.messages = topic.messages.slice(-RELAY_MAX);
  }

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



// ─── File Upload + Serving ───────────────────────────────────────────────────

const fs = require('fs');
const crypto = require('crypto');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/files';

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

// ─── Chat PWA ────────────────────────────────────────────────────────────────

const path = require('path');
app.get('/chat', (_req, res) => {
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
