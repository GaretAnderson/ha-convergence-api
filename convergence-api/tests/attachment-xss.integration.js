// Probe test for issue #31 (PR #32 review): the `attachments[]` -> UI <img>
// path was NOT sanitized — a malicious sender could publish an attachment
// URL with a javascript:/data: scheme (or a quote/attribute-breakout string)
// and have it survive into `chat.html`'s rendered `<img>` element, unlike the
// already-safe `[[attach: url]]` markdown-token path (render.js).
//
// This proves the fix end-to-end, from the wire to the rendered DOM:
//  1. Server-side: POST /relay/:topic with malicious `attachments[]` entries
//     -> the stored/returned message's `attachments` array has them filtered
//     out entirely (server.js filters via render.js's isSafeAttachmentUrl).
//  2. Client-side: loading /chat renders that message with ZERO <img class="att">
//     elements for the malicious entries, and no attribute/script injection
//     (chat.html's buildAttachmentImg uses the same allowlist + DOM property
//     assignment, never string-concatenated HTML/inline onclick).
//  3. A legitimate root-relative attachment (an actual uploaded /files/ URL)
//     still renders normally alongside the rejected ones (no over-blocking).
//
// Run: node tests/attachment-xss.integration.js
// (requires: npm i, npx playwright install chromium)

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 8188;
const BASE = `http://localhost:${PORT}`;
const TEST_TOKEN = 'attachment-xss-test-token';
const TOKEN_KEY = 'agentChatRelayToken';

const SCHEME_REJECTED_ATTACHMENTS = [
  'javascript:alert(document.cookie)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml;base64,PHN2Zz4=',
  'vbscript:msgbox(1)',
  '//evil.example.com/x.png', // protocol-relative
];
// These are syntactically valid http(s) URLs (so the scheme allowlist lets
// them through both server-side filtering and client rendering) but carry
// quote/JS-breakout characters — the original bug shape from the review
// (chat.html's old imgTag() built `<img src="${src}" onclick="window.open('${src}')">`
// via string concatenation, so a `"` or `'` in the URL escaped the attribute/
// inline-script context). They must still render as an inert <img src=...>
// with no attribute/script injection now that chat.html uses DOM property
// assignment (img.src = ...) instead of string-built HTML/inline onclick.
const ATTRIBUTE_BREAKOUT_ATTACHMENTS = [
  'https://example.com/x.png" onerror="alert(1)',
  "https://example.com/x.png');alert(document.cookie);//",
];
const MALICIOUS_ATTACHMENTS = [...SCHEME_REJECTED_ATTACHMENTS, ...ATTRIBUTE_BREAKOUT_ATTACHMENTS];
const SAFE_ATTACHMENT = '/files/does-not-need-to-exist.png';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-xss-itest-'));
  const uploadDir = path.join(dataDir, 'files');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, UPLOAD_DIR: uploadDir, RELAY_TOKEN: TEST_TOKEN, RELAY_TOKEN_GRACE_HOURS: '0' },
    stdio: 'ignore',
  });
  const fail = (msg) => { console.error('FAIL:', msg); server.kill(); process.exit(1); };

  try {
    await waitForHealth();

    // --- Publish a message with malicious + one legitimate attachment URL ---
    const posted = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        from: 'attacker',
        to: ['@aorus'],
        body: 'attachment xss probe',
        attachments: [...MALICIOUS_ATTACHMENTS, SAFE_ATTACHMENT],
      });
      const req = http.request(`${BASE}/relay/agent-relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${TEST_TOKEN}` },
      }, res => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end(payload);
    });

    if (posted.status !== 201) fail(`expected 201 publishing the probe message, got ${posted.status}`);

    // 1. Server-side: scheme-rejected attachment URLs must never be
    //    persisted. Attribute-breakout URLs ARE valid http(s) URLs, so they
    //    pass the allowlist and are expected to survive storage — safety for
    //    those depends on the client rendering them via DOM APIs (step 2).
    const storedAttachments = posted.json.attachments || [];
    for (const bad of SCHEME_REJECTED_ATTACHMENTS) {
      if (storedAttachments.includes(bad)) fail(`malicious attachment URL survived server-side filtering: ${bad}`);
    }
    for (const breakout of ATTRIBUTE_BREAKOUT_ATTACHMENTS) {
      if (!storedAttachments.includes(breakout)) fail(`expected valid-but-hostile https URL to pass the scheme allowlist: ${breakout}`);
    }
    if (!storedAttachments.includes(SAFE_ATTACHMENT)) fail('legitimate root-relative attachment URL was incorrectly dropped');
    const expectedSurviving = ATTRIBUTE_BREAKOUT_ATTACHMENTS.length + 1;
    if (storedAttachments.length !== expectedSurviving) fail(`expected exactly ${expectedSurviving} surviving attachments, got ${storedAttachments.length}: ${JSON.stringify(storedAttachments)}`);

    // 2. Client-side: render /chat and confirm the DOM matches — zero <img>
    //    for the scheme-rejected entries, one each for the safe + breakout-
    //    attempt entries (rendered inertly), no injected script execution,
    //    and no page errors from malformed HTML/attribute breakout.
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    await ctx.addInitScript(({ key, token }) => localStorage.setItem(key, token), { key: TOKEN_KEY, token: TEST_TOKEN });
    const page = await ctx.newPage();

    let alertFired = false;
    page.on('dialog', async d => { alertFired = true; await d.dismiss(); });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    if (alertFired) fail('a script/dialog fired from the rendered attachment — XSS not neutralized');
    if (pageErrors.length) fail('page errors while rendering the probe message: ' + pageErrors.join('; '));

    const attImgSrcs = await page.evaluate((id) => {
      const el = document.querySelector(`.msg[data-id="${id}"]`);
      if (!el) return null;
      return Array.from(el.querySelectorAll('img.att')).map(img => img.getAttribute('src'));
    }, posted.json.id);

    if (attImgSrcs === null) fail('probe message was not rendered in the chat UI at all');
    if (attImgSrcs.length !== expectedSurviving) fail(`expected exactly ${expectedSurviving} rendered <img class="att">, got ${attImgSrcs.length}: ${JSON.stringify(attImgSrcs)}`);
    if (!attImgSrcs.some(s => s.includes(SAFE_ATTACHMENT))) fail(`no rendered <img> src points at the safe attachment: ${JSON.stringify(attImgSrcs)}`);
    for (const src of attImgSrcs) {
      if (/javascript:|data:|vbscript:/i.test(src)) fail(`rendered <img src> still carries a dangerous scheme: ${src}`);
    }

    // No onerror/onclick/inline-handler attributes should ever appear on the
    // rendered attachment images (DOM property assignment, not string HTML) —
    // this is the core proof that the attribute-breakout URLs above are inert.
    const attHasHandlerAttrs = await page.evaluate((id) => {
      const el = document.querySelector(`.msg[data-id="${id}"]`);
      return Array.from(el.querySelectorAll('img.att')).some(img =>
        Array.from(img.attributes).some(a => /^on/i.test(a.name)));
    }, posted.json.id);
    if (attHasHandlerAttrs) fail('rendered <img class="att"> carries an inline event-handler attribute');

    console.log(`PASS: ${SCHEME_REJECTED_ATTACHMENTS.length} dangerous-scheme attachment URLs filtered server-side; ${ATTRIBUTE_BREAKOUT_ATTACHMENTS.length} attribute-breakout URLs rendered inertly via DOM assignment; safe attachment rendered normally; no XSS fired`);
    await browser.close();
    server.kill();
    process.exit(0);
  } catch (e) {
    fail(e.message);
  }
})();
