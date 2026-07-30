// tests/smoke.test.js — startup smoke test (issue #34, updated for #43).
//
// v0.8.1 crashed on startup (container reported cpu=0%, empty logs; the
// relay port never bound) and that reached the live add-on because nothing
// ever actually started the server and checked it came up. This test is the
// regression guard: it spawns `node server.js` as a real child process (the
// same way `run.sh`'s `exec node server.js` does), waits for it to bind the
// relay port, and asserts `/api/health` responds. If the server throws
// anywhere during require()/module-init or fails to bind, this test fails
// loudly instead of a boot-crash silently reaching production again.
//
// Issue #43: the live relay is OPEN (no relay_token enforcement) and must
// stay that way — this test asserts a POST to /relay/:topic with no token at
// all succeeds (201) and comes back with server-rendered markdown (bodyHtml),
// proving the markdown wiring is live at boot without reintroducing the
// fail-closed 503 behavior a prior attempt shipped.
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
const POLL_INTERVAL_MS = 150;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
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
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
    req.end(payload);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for the health endpoint to respond, polling until BOOT_TIMEOUT_MS
// elapses or the child process exits (whichever comes first).
async function waitForHealth(child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let childExited = false;
  let childExitInfo = null;
  child.on('exit', (code, signal) => {
    childExited = true;
    childExitInfo = { code, signal };
  });

  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(
        `server process exited before binding port ${PORT} ` +
        `(code=${childExitInfo.code}, signal=${childExitInfo.signal})`
      );
    }
    try {
      const res = await get(`http://127.0.0.1:${PORT}/api/health`);
      if (res.statusCode === 200) return JSON.parse(res.body);
    } catch {
      // Not up yet — keep polling until the deadline.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`server did not bind port ${PORT} / answer /api/health within ${BOOT_TIMEOUT_MS}ms`);
}

test('server boots, binds port 8088, answers /api/health, and keeps the relay OPEN with markdown rendering wired', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-smoke-'));
  const stdout = [];
  const stderr = [];

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      UPLOAD_DIR: path.join(dataDir, 'files'),
      DATA_DIR: dataDir
      // Deliberately no RELAY_TOKEN / relay_token option: the relay must
      // stay open (no fail-close) per issue #43.
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  try {
    const health = await waitForHealth(child);
    assert.equal(health.status, 'ok');
    assert.equal(typeof health.uptime, 'number');
    assert.equal(typeof health.version, 'string');

    // Relay must accept a publish with NO token/auth at all — no 401/503.
    const posted = await post(`http://127.0.0.1:${PORT}/relay/smoke-test`, {
      from: 'smoke-test',
      body: '**bold** and a [link](https://example.com)'
    });
    assert.equal(posted.statusCode, 201, 'relay must stay OPEN — no fail-close when relay_token is unset');
    const msg = JSON.parse(posted.body);
    assert.match(msg.bodyHtml, /<strong>bold<\/strong>/, 'bodyHtml must contain server-rendered markdown');
    assert.match(msg.bodyHtml, /<a href="https:\/\/example\.com"/, 'bodyHtml must render links');

    // /chat must serve the Agent Chat UI so it can render that markdown.
    const chat = await get(`http://127.0.0.1:${PORT}/chat`);
    assert.equal(chat.statusCode, 200, '/chat must be reachable to render markdown');
  } catch (err) {
    const out = Buffer.concat(stdout).toString('utf8');
    const errOut = Buffer.concat(stderr).toString('utf8');
    throw new Error(
      `${err.message}\n--- stdout ---\n${out}\n--- stderr ---\n${errOut}`
    );
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
