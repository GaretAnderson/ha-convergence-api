// Self-contained integration test for the chat PWA image-paste flow.
//
// Regression guard for the bug where pasting an image did nothing because the
// #preview / #attach-btn / #file-input elements were missing from the body, so
// script init threw on a null addEventListener and the paste handler never bound.
//
// Proves the full chain: paste -> preview shows -> upload 201 -> send (button)
// -> message carries [image: url] -> served 200 as a real image/png.
//
// Run: node tests/paste.integration.js   (requires: npm i, npx playwright install chromium)

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 8088;
const BASE = `http://localhost:${PORT}`;
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

(async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-itest-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, UPLOAD_DIR: uploadDir },
    stdio: 'ignore',
  });

  const fail = (msg) => { console.error('FAIL:', msg); server.kill(); process.exit(1); };

  try {
    await waitForHealth();
    const browser = await chromium.launch();
    const page = await browser.newContext().then(c => c.newPage());
    const uploads = [];
    page.on('response', async r => { if (r.url().includes('/relay/upload')) uploads.push(r.status()); });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    if (pageErrors.length) fail('page init errors: ' + pageErrors.join('; '));

    // Simulate clipboard image paste
    await page.evaluate((b64) => {
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'pasted.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(file);
      const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(evt, 'clipboardData', { value: dt });
      window.dispatchEvent(evt);
    }, PNG_B64);
    await page.waitForTimeout(1500);

    const previewShown = await page.evaluate(() => {
      const p = document.getElementById('preview');
      return p && getComputedStyle(p).display === 'block';
    });
    if (!previewShown) fail('preview did not become visible after paste');
    if (!uploads.includes(201)) fail('paste did not upload (no 201): ' + JSON.stringify(uploads));

    // Send via the button (regression: override-after-bind lost the attachment on click)
    await page.fill('#msg-input', 'paste integration test');
    await page.click('#send-btn');
    await page.waitForTimeout(1000);

    const served = await page.evaluate(async (base) => {
      const j = await (await fetch(base + '/relay/agent-relay')).json();
      const withImg = j.messages.filter(m => /\[image: (\/files\/\S+)\]/.test(m.body || ''));
      if (!withImg.length) return null;
      const url = withImg[withImg.length - 1].body.match(/\[image: (\/files\/\S+)\]/)[1];
      const ir = await fetch(base + url);
      return { status: ir.status, bytes: (await ir.arrayBuffer()).byteLength, type: ir.headers.get('content-type') };
    }, BASE);

    if (!served) fail('sent message did not carry an image attachment');
    if (served.status !== 200) fail('served image status ' + served.status);
    if (served.type !== 'image/png') fail('served type ' + served.type);
    if (served.bytes < 60) fail('served image too small (' + served.bytes + 'b) — likely a stub, not a real png');

    console.log('PASS: paste -> preview -> upload 201 -> send(button) -> served', served.bytes + 'b', served.type);
    await browser.close();
    server.kill();
    process.exit(0);
  } catch (e) {
    fail(e.message);
  }
})();
