// Self-contained integration test for the chat PWA image/message features.
//
// Covers regressions and the feature set:
//  - paste MULTIPLE images -> multiple preview thumbnails (no "attached" confirmation)
//  - send -> message carries all images, each served 200 as a real image/png
//  - persistence -> a reload in a fresh browser context shows the same content (90d store)
//  - delete -> removing a message drops it from the server and other views
//
// Run: node tests/paste.integration.js   (requires: npm i, npx playwright install chromium)

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 8188;
const BASE = `http://localhost:${PORT}`;
// Auth (issue #29): the relay now requires a shared-secret token on every
// /relay* and /files/* request. Use a throwaway token for this test server
// and pre-seed it into each browser context's localStorage (matching the
// chat.html TOKEN_KEY) so the page doesn't block on a JS `prompt()` dialog.
const TEST_TOKEN = 'integration-test-token';
const TOKEN_KEY = 'agentChatRelayToken';
// Real 1x1 PNG (67 bytes) — unlike an 8-byte stub, this decodes in a browser.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${BASE}/api/health`, r => { r.resume(); resolve(); })
        .on('error', () => (Date.now() - start > timeoutMs ? reject(new Error('server did not start')) : setTimeout(tick, 200)));
    };
    tick();
  });
}

async function pasteImages(page, n) {
  await page.evaluate(({ b64, n }) => {
    for (let k = 0; k < n; k++) {
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], `p${k}.png`, { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(file);
      const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(evt, 'clipboardData', { value: dt });
      window.dispatchEvent(evt);
    }
  }, { b64: PNG_B64, n });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-itest-'));
  const uploadDir = path.join(dataDir, 'files');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, UPLOAD_DIR: uploadDir, RELAY_TOKEN: TEST_TOKEN },
    stdio: 'ignore',
  });
  const fail = (msg) => { console.error('FAIL:', msg); server.kill(); process.exit(1); };

  try {
    await waitForHealth();
    const browser = await chromium.launch();

    // --- Session 1: paste 2 images, verify no confirmation, send ---
    const ctx1 = await browser.newContext();
    // Pre-seed the relay token so chat.html's ensureToken() finds it already
    // set and never blocks on a JS prompt() dialog.
    await ctx1.addInitScript(({ key, token }) => localStorage.setItem(key, token), { key: TOKEN_KEY, token: TEST_TOKEN });
    const page = await ctx1.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    if (pageErrors.length) fail('page init errors: ' + pageErrors.join('; '));

    await pasteImages(page, 2);
    await page.waitForTimeout(1800);

    const thumbs = await page.evaluate(() => document.querySelectorAll('#preview .thumb').length);
    if (thumbs !== 2) fail(`expected 2 preview thumbnails, got ${thumbs}`);

    const hasConfirmation = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.msg')).some(m => /Image attached/i.test(m.textContent)));
    if (hasConfirmation) fail('the "Image attached" confirmation message should be gone');

    await page.fill('#msg-input', 'multi image test');
    await page.click('#send-btn');
    await page.waitForTimeout(1000);

    // Assert the RENDERED message shows each image exactly once (regression: double-render)
    const renderedImgs = await page.evaluate(() => {
      const msgs = document.querySelectorAll('#messages .msg');
      const last = msgs[msgs.length - 1];
      return last ? last.querySelectorAll('img.att').length : -1;
    });
    if (renderedImgs !== 2) fail(`rendered message should show 2 images exactly, got ${renderedImgs} (double-render?)`);

    const sent = await page.evaluate(async ({ base, token }) => {
      const j = await (await fetch(base + '/relay/agent-relay', { headers: { Authorization: 'Bearer ' + token } })).json();
      const m = j.messages[j.messages.length - 1];
      const urls = (m.attachments || []).slice();
      (m.body.match(/\[image: (\/files\/\S+)\]/g) || []).forEach(t => urls.push(t.match(/\[image: (\/files\/\S+)\]/)[1]));
      const uniq = [...new Set(urls)];
      const served = [];
      for (const u of uniq) { const r = await fetch(base + u + '?token=' + encodeURIComponent(token)); served.push({ status: r.status, bytes: (await r.arrayBuffer()).byteLength, type: r.headers.get('content-type') }); }
      return { id: m.id, imgCount: uniq.length, served };
    }, { base: BASE, token: TEST_TOKEN });

    if (sent.imgCount !== 2) fail(`sent message should carry 2 images, got ${sent.imgCount}`);
    for (const s of sent.served) {
      if (s.status !== 200 || s.type !== 'image/png' || s.bytes < 60) fail('served image invalid: ' + JSON.stringify(s));
    }

    // --- Session 2: persistence — fresh context shows the same message ---
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(({ key, token }) => localStorage.setItem(key, token), { key: TOKEN_KEY, token: TEST_TOKEN });
    const page2 = await ctx2.newPage();
    await page2.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(900);
    const seenInFresh = await page2.evaluate((id) => !!document.querySelector(`.msg[data-id="${id}"]`), sent.id);
    if (!seenInFresh) fail('persisted message not shown in a fresh browser context (persistence/cross-device)');

    // --- Delete — remove the message, verify gone from server ---
    await page2.evaluate((id) => document.querySelector(`.msg[data-id="${id}"] .del`).click(), sent.id);
    await page2.waitForTimeout(800);
    const stillOnServer = await page2.evaluate(async ({ base, id, token }) => {
      const j = await (await fetch(base + '/relay/agent-relay', { headers: { Authorization: 'Bearer ' + token } })).json();
      return j.messages.some(m => m.id === id);
    }, { base: BASE, id: sent.id, token: TEST_TOKEN });
    if (stillOnServer) fail('deleted message still present on the server');

    console.log(`PASS: multi-image(${sent.imgCount}) served ${sent.served.map(s => s.bytes + 'b').join(',')}; no confirmation; persisted across context; delete removed from server`);
    await browser.close();
    server.kill();
    process.exit(0);
  } catch (e) {
    fail(e.message);
  }
})();
