// tests/channels.integration.js — server-level integration for purpose-channels
// (garets-config#1051 v1): GET /channels, per-channel enable/disable persists
// across restart, and a disabled channel's C-pull refuses to ingest.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 8088;
const BOOT_TIMEOUT_MS = 15000;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timed out')));
  });
}

function post(url, jsonBody) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(jsonBody);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timed out')));
    req.end(payload);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await get(`http://127.0.0.1:${PORT}/api/health`);
      if (res.statusCode === 200) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not come up in time');
}

function startServer(env) {
  return spawn(process.execPath, [SERVER_PATH], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('GET /channels returns the registry-driven channel list with guru disabled by default', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-channels-'));
  const child = startServer({ UPLOAD_DIR: path.join(dataDir, 'files'), DATA_DIR: dataDir });
  try {
    await waitForHealth();
    const res = await get(`http://127.0.0.1:${PORT}/channels`);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    const ids = data.channels.map((c) => c.id).sort();
    assert.deepEqual(ids, ['advisor', 'guru', 'helper', 'tutor', 'threads'].sort());
    const guru = data.channels.find((c) => c.id === 'guru');
    assert.equal(guru.enabled, false, 'guru must be disabled by default');
    const helper = data.channels.find((c) => c.id === 'helper');
    assert.equal(helper.enabled, true);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('per-channel enable/disable persists across a server restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-persist-'));
  let child = startServer({ UPLOAD_DIR: path.join(dataDir, 'files'), DATA_DIR: dataDir });
  try {
    await waitForHealth();
    // Enable guru explicitly.
    const toggled = await post(`http://127.0.0.1:${PORT}/channels/guru/enabled`, { enabled: true });
    assert.equal(toggled.statusCode, 200);
    assert.equal(JSON.parse(toggled.body).enabled, true);

    child.kill('SIGTERM');
    await sleep(300);

    child = startServer({ UPLOAD_DIR: path.join(dataDir, 'files'), DATA_DIR: dataDir });
    await waitForHealth();
    const res = await get(`http://127.0.0.1:${PORT}/channels`);
    const data = JSON.parse(res.body);
    const guru = data.channels.find((c) => c.id === 'guru');
    assert.equal(guru.enabled, true, 'enabled override must survive a restart');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a disabled channel ingests nothing — /channel/:id/history refuses with 403', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-disabled-'));
  const child = startServer({ UPLOAD_DIR: path.join(dataDir, 'files'), DATA_DIR: dataDir });
  try {
    await waitForHealth();
    // guru is disabled by default and is life-domain (ingestionPolicy 'none') —
    // both reasons independently refuse the pull.
    const res = await get(`http://127.0.0.1:${PORT}/channel/guru/history`);
    assert.equal(res.statusCode, 403);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('C-pull "load full history" reconstructs a transcript for an enabled shared channel', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-history-'));
  const eventsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-events-'));
  const sessionDir = path.join(eventsRoot, 'garets-tutor', 'session-state', 'sess-42');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), [
    JSON.stringify({ type: 'user.message', user_content: 'teach me DuckDB', timestamp: '2026-08-01T09:00:00Z' }),
    JSON.stringify({ type: 'assistant.message', assistant_content: 'sure, start with SELECT', timestamp: '2026-08-01T09:00:05Z' })
  ].join('\n'));

  const child = startServer({
    UPLOAD_DIR: path.join(dataDir, 'files'),
    DATA_DIR: dataDir,
    AGENT_EVENTS_ROOT: eventsRoot
  });
  try {
    await waitForHealth();
    const res = await get(`http://127.0.0.1:${PORT}/channel/tutor/history`);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.count, 2);
    assert.equal(data.messages[0].body, 'teach me DuckDB');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(eventsRoot, { recursive: true, force: true });
  }
});
