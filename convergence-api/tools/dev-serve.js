#!/usr/bin/env node
'use strict';
// tools/dev-serve.js — local dev harness for the garets-chat UI (issue #46).
//
// Boots server.js on :8088 AND a single "echo responder" so you can validate
// the look AND live behavior in a real browser before pushing to HAOS — without
// the full multi-agent prod deployment. The responder subscribes to the
// `agent-relay` topic over SSE and, for every message you send from the chat:
//   1. posts a delivery+read receipt as itself (so the inline receipt names
//      light up teal — proves the receipt path),
//   2. replies with a markdown message that echoes your text and reports the
//      `to` it was addressed with (proves each channel tab wires `to` correctly
//      and that server-side markdown rendering works).
//
// It replies as the agent implied by the message's `to` (helper/tutor/…), so
// switching tabs feels like talking to different agents. Guru stays gated.
//
// Usage:  npm run dev        (from convergence-api/)  then open the printed URL.
// Ctrl+C to stop; the server child is torn down with it.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = parseInt(process.env.DEV_PORT || '8088', 10);
const HOST = '127.0.0.1';
const TOPIC = 'agent-relay';
const BASE = `http://${HOST}:${PORT}`;
// Persist relay state between dev runs so your test transcript survives a
// restart. Gitignored (see .gitignore: convergence-api/.dev-data/).
const DATA_DIR = path.join(__dirname, '..', '.dev-data');

fs.mkdirSync(DATA_DIR, { recursive: true });

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
  });
}

function post(pathname, json) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(json);
    const req = http.request(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await get(`${BASE}/api/health`); if (r.status === 200) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server did not answer /api/health on ${BASE} within ${timeoutMs}ms`);
}

// Map the outgoing `to` (set by the active channel tab) to a friendly responder
// identity, so each tab feels like a different agent during validation.
function responderFor(to) {
  const list = Array.isArray(to) ? to.map(String) : (to ? [String(to)] : []);
  const hay = list.join(' ').toLowerCase();
  if (!list.length) return 'garets-helper@dev';            // home / broadcast
  if (hay.includes('tutor')) return 'garets-tutor@dev';
  if (hay.includes('advisor')) return 'garets-advisor@dev';
  if (hay.includes('threads')) return 'garets-threads@dev';
  if (hay.includes('guru')) return 'garets-guru@dev';       // (gated in UI, but honor if forced)
  return 'garets-helper@dev';                               // helper aliases (@aorus/@laptop) or anything else
}

function isFromResponder(from) {
  return typeof from === 'string' && from.endsWith('@dev');
}

async function handleUserMessage(msg) {
  if (!msg || isFromResponder(msg.from)) return;      // never reply to our own replies
  if (msg.metadata && msg.metadata.devResponder) return;
  const responder = responderFor(msg.to);

  // 1) Receipt: mark the user's message delivered + read by the responder.
  try {
    await post(`/relay/${TOPIC}/${encodeURIComponent(msg.id)}/receipt`, { from: responder, status: 'read' });
  } catch { /* best-effort */ }

  // 2) Reply, exercising markdown rendering + reporting the addressed `to`.
  const echo = String(msg.body || '').slice(0, 400);
  const toStr = JSON.stringify(msg.to);
  const body = [
    `**${responder}** (dev responder) received your message on \`to=${toStr}\`.`,
    '',
    `> ${echo || '(empty)'}`,
    '',
    'Rendering check: **bold**, *italic*, `code`, and a [link](https://example.com).',
    '- list item one',
    '- list item two'
  ].join('\n');

  try {
    await post(`/relay/${TOPIC}`, {
      from: responder,
      to: msg.from,
      body,
      replyTo: msg.id,
      metadata: { devResponder: true }
    });
  } catch (e) { console.error('[dev-responder] reply failed:', e.message); }
}

// Minimal SSE client (Node has no EventSource). Parses `data: {json}\n\n`
// frames from the relay stream and dispatches message events to the responder.
function startResponder() {
  const req = http.get(`${BASE}/relay/${TOPIC}/stream`, (res) => {
    console.log(`[dev-responder] subscribed to ${TOPIC} (status ${res.statusCode})`);
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;       // skip ": keepalive" comments
          const json = line.slice(5).trim();
          if (!json) continue;
          let evt;
          try { evt = JSON.parse(json); } catch { continue; }
          if (evt.deleted || evt.receipt) continue;       // ignore delete/receipt echoes
          handleUserMessage(evt);
        }
      }
    });
    res.on('end', () => console.log('[dev-responder] stream ended'));
  });
  req.on('error', (e) => {
    console.error('[dev-responder] stream error, retrying in 1s:', e.message);
    setTimeout(startResponder, 1000);
  });
}

function tryOpenBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* non-fatal: the URL is printed below regardless */ }
}

(async () => {
  console.log(`[dev-serve] starting server.js on ${BASE} (data: ${DATA_DIR}) …`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, UPLOAD_DIR: path.join(DATA_DIR, 'files'), INGRESS_PORT: '0' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  server.on('exit', (code) => { console.log(`[dev-serve] server exited (${code})`); process.exit(code || 0); });

  const shutdown = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await waitForHealth();
  } catch (e) {
    console.error(`[dev-serve] ${e.message}`);
    console.error('[dev-serve] If port 8088 is already in use, free it first — server.js binds 8088 by hard-code.');
    shutdown();
    return;
  }

  startResponder();

  const url = `${BASE}/chat`;
  console.log('\n' + '='.repeat(64));
  console.log('  garets-chat dev harness is live.');
  console.log(`  Open:  ${url}`);
  console.log('  A single echo-responder replies to whatever you send so you');
  console.log('  can validate tabs, sending/receiving, receipts, markdown,');
  console.log('  the collapsing header, and the sticky composer.');
  console.log('  Ctrl+C to stop.');
  console.log('='.repeat(64) + '\n');
  tryOpenBrowser(url);
})();
