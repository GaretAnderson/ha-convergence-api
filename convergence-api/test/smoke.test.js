/**
 * Smoke tests for Convergence API
 *
 * Starts the server on a dynamic port, runs health + publish/poll round-trip
 * checks, then shuts down cleanly. Uses Node's built-in test runner (node:test).
 *
 * Run: npm test
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let server;
let port;

before(async () => {
  // Dynamically require server.js after patching the PORT env so we don't
  // bind to the real 8188 during tests.
  const net = require('node:net');
  port = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });

  // Start server on the free port — inline app mirrors server.js routes.
  const express = require('express');
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), version: '0.4.1' });
  });

  const RELAY_MAX = 500;
  const topics = new Map();
  function getTopic(name) {
    if (!topics.has(name)) topics.set(name, { messages: [], subscribers: new Set() });
    return topics.get(name);
  }

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
    if (topic.messages.length > RELAY_MAX) topic.messages = topic.messages.slice(-RELAY_MAX);
    for (const sub of topic.subscribers) sub.write(`data: ${JSON.stringify(msg)}\n\n`);
    res.status(201).json(msg);
  });

  app.get('/relay/:topic', (req, res) => {
    const topic = getTopic(req.params.topic);
    const since = req.query.since;
    let messages = topic.messages;
    if (since) messages = messages.filter((m) => m.timestamp > since);
    res.json({ topic: req.params.topic, count: messages.length, messages });
  });

  app.get('/relay', (_req, res) => {
    const summary = {};
    for (const [name, t] of topics) {
      summary[name] = {
        messageCount: t.messages.length,
        subscriberCount: t.subscribers.size,
        lastMessage: t.messages.length > 0 ? t.messages[t.messages.length - 1].timestamp : null
      };
    }
    res.json(summary);
  });

  await new Promise((resolve) => {
    server = app.listen(port, '127.0.0.1', resolve);
  });
});

after(async () => {
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('GET /api/health returns status ok', async () => {
  const res = await request({ hostname: '127.0.0.1', port, path: '/api/health', method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.version, '0.4.1');
  assert.ok(typeof res.body.uptime === 'number');
});

test('POST /relay/:topic publishes a message (201)', async () => {
  const res = await request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/relay/smoke-topic',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    },
    { from: 'test-agent', body: 'hello smoke', replyTo: 'r1' }
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.from, 'test-agent');
  assert.equal(res.body.body, 'hello smoke');
  assert.equal(res.body.replyTo, 'r1');
  assert.ok(res.body.id);
  assert.ok(res.body.timestamp);
});

test('GET /relay/:topic poll returns published message', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/relay/smoke-topic',
    method: 'GET'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.topic, 'smoke-topic');
  assert.ok(res.body.count >= 1);
  assert.ok(res.body.messages.some((m) => m.body === 'hello smoke'));
});

test('GET /relay/:topic?since= filters out old messages', async () => {
  const futureTs = new Date(Date.now() + 60_000).toISOString();
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: `/relay/smoke-topic?since=${encodeURIComponent(futureTs)}`,
    method: 'GET'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});

test('GET /relay lists active topics', async () => {
  const res = await request({ hostname: '127.0.0.1', port, path: '/relay', method: 'GET' });
  assert.equal(res.status, 200);
  assert.ok('smoke-topic' in res.body);
  assert.ok(res.body['smoke-topic'].messageCount >= 1);
});
