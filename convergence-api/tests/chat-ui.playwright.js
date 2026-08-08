// tests/chat-ui.playwright.js — GUI behavior tests for garets-config#1051 v1:
//   1. Composer (#input-bar) is ALWAYS visible at every scroll position
//      (desktop + mobile viewport), fixing the pre-#1051 plain-flex bug.
//   2. Channel tab header (#channel-tabs) hides on scroll-down, reveals on
//      scroll-up.
// Runs the real server + a real Chromium page (via Playwright) against a
// synthetic backlog of messages so #messages has enough height to scroll.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');

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

async function seedMessages(n) {
  for (let i = 0; i < n; i++) {
    await post(`http://127.0.0.1:${PORT}/relay/agent-relay`, {
      from: i % 2 === 0 ? 'garets-helper@aorus' : 'phone',
      to: 'garets-helper@aorus',
      body: `Test message #${i} — some padding text so the bubble has real height and the transcript actually scrolls. `.repeat(4)
    });
  }
}

async function withServerAndPage(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-api-playwright-'));
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, UPLOAD_DIR: path.join(dataDir, 'files'), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let browser;
  try {
    await waitForHealth();
    await seedMessages(20);
    browser = await chromium.launch();
    await fn(browser);
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function isInViewport(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0 && r.height > 0;
  });
}

test('composer (#input-bar) is always visible at scrollTop=0, mid-scroll, and bottom — desktop', async () => {
  await withServerAndPage(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT}/chat`);
    await page.waitForSelector('#messages .msg');

    await page.$eval('#messages', (el) => { el.scrollTop = 0; });
    assert.equal(await isInViewport(page, '#input-bar'), true, 'composer must be visible at scrollTop=0');

    await page.$eval('#messages', (el) => { el.scrollTop = el.scrollHeight / 2; });
    assert.equal(await isInViewport(page, '#input-bar'), true, 'composer must be visible mid-scroll');

    await page.$eval('#messages', (el) => { el.scrollTop = el.scrollHeight; });
    assert.equal(await isInViewport(page, '#input-bar'), true, 'composer must be visible at the bottom');

    await page.close();
  });
});

test('composer (#input-bar) is always visible at scrollTop=0, mid-scroll, and bottom — mobile viewport', async () => {
  await withServerAndPage(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } }); // iPhone-ish
    await page.goto(`http://127.0.0.1:${PORT}/chat`);
    await page.waitForSelector('#messages .msg');

    await page.$eval('#messages', (el) => { el.scrollTop = 0; });
    assert.equal(await isInViewport(page, '#input-bar'), true, 'mobile: composer visible at top');

    await page.$eval('#messages', (el) => { el.scrollTop = el.scrollHeight / 2; });
    assert.equal(await isInViewport(page, '#input-bar'), true, 'mobile: composer visible mid-scroll');

    await page.$eval('#messages', (el) => { el.scrollTop = el.scrollHeight; });
    assert.equal(await isInViewport(page, '#input-bar'), true, 'mobile: composer visible at bottom');

    await page.close();
  });
});

test('channel tab header hides on scroll-down and reveals on scroll-up', async () => {
  await withServerAndPage(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT}/chat`);
    await page.waitForSelector('#messages .msg');
    await page.waitForSelector('#channel-tabs button');

    // Start at the top: header must be visible (nothing to hide from).
    await page.$eval('#messages', (el) => { el.scrollTop = 0; });
    await page.waitForTimeout(50);
    let collapsed = await page.$eval('#channel-tabs', (el) => el.classList.contains('collapsed'));
    assert.equal(collapsed, false, 'header must be visible at scrollTop=0');

    // Scroll DOWN progressively (dispatch real scroll events) -> header hides.
    await page.$eval('#messages', (el) => {
      el.scrollTop = 50; el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(30);
    await page.$eval('#messages', (el) => {
      el.scrollTop = 300; el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(50);
    collapsed = await page.$eval('#channel-tabs', (el) => el.classList.contains('collapsed'));
    assert.equal(collapsed, true, 'header must hide on scroll-down');

    // Scroll UP -> header reveals again.
    await page.$eval('#messages', (el) => {
      el.scrollTop = 150; el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(50);
    collapsed = await page.$eval('#channel-tabs', (el) => el.classList.contains('collapsed'));
    assert.equal(collapsed, false, 'header must reveal on scroll-up');

    await page.close();
  });
});

test('channel selector is a pills-only bar (brand + conn dot + solid/outline pills, no checkboxes) — issue #46', async () => {
  await withServerAndPage(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT}/chat`);
    await page.waitForSelector('#channel-tabs button.pill');

    // Rebrand: title + header read "garets-chat", not "Agent Chat".
    assert.equal(await page.title(), 'garets-chat', 'document title must read garets-chat');
    const headerText = await page.$eval('#chat-header h1', (el) => el.textContent.trim());
    assert.equal(headerText, 'garets-chat', 'header must read garets-chat');

    // Brand sits on the pill row with a connection dot indicator and is the
    // active "home" by default.
    const brand = await page.$eval('#channel-tabs h1.brand', (el) => ({
      text: el.textContent.trim(), active: el.classList.contains('active'),
      hasDot: !!el.querySelector('#conn-dot.conn-dot')
    }));
    assert.equal(brand.text, 'garets-chat', 'brand must read garets-chat');
    assert.equal(brand.active, true, 'brand (home) must be active on load');
    assert.equal(brand.hasDot, true, 'brand must carry a connection dot indicator');

    // Pills for each channel (helper/tutor/...), each with an availability dot.
    const pills = await page.$$eval('#channel-tabs button.pill[data-id]', (els) =>
      els.map((e) => ({ id: e.getAttribute('data-id'), enabled: e.classList.contains('enabled'),
        disabled: e.classList.contains('disabled'), hasAvail: !!e.querySelector('.avail') })));
    const ids = pills.map((p) => p.id);
    assert.ok(ids.includes('helper'), 'helper must be a pill');
    assert.ok(ids.includes('tutor'), 'tutor must be a pill');
    assert.ok(pills.every((p) => p.hasAvail), 'every pill must have a responder-availability dot');

    // Enabled channels render solid (.enabled); no channel uses a checkbox.
    assert.equal(pills.find((p) => p.id === 'helper').enabled, true, 'helper (enabled) must be a solid pill');
    const anyCheckbox = await page.$$eval('#chat-header input[type=checkbox]', (els) => els.length);
    assert.equal(anyCheckbox, 0, 'there must be NO checkboxes anywhere in the header');
    const managePanel = await page.$('#channel-manage');
    assert.equal(managePanel, null, 'the separate manage/checkbox panel must be gone');

    await page.close();
  });
});

test('clicking a pill selects it (and clicking the active pill toggles it off) — issue #46', async () => {
  await withServerAndPage(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT}/chat`);
    await page.waitForSelector('#channel-tabs button.pill');
    // Reveal the bar (seeded backlog auto-scrolls -> header collapses).
    await page.$eval('#messages', (el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(50);

    // Click tutor -> tutor becomes the active pill, brand no longer active.
    await page.click('#channel-tabs button.pill[data-id="tutor"]');
    await page.waitForTimeout(100);
    let tutorActive = await page.$eval('#channel-tabs button.pill[data-id="tutor"]', (el) => el.classList.contains('active'));
    let brandActive = await page.$eval('#channel-tabs h1.brand', (el) => el.classList.contains('active'));
    assert.equal(tutorActive, true, 'clicking tutor makes it the active pill');
    assert.equal(brandActive, false, 'brand is no longer the active home');

    // Click the active tutor pill again -> it disables (outline) and home is active again.
    await page.$eval('#messages', (el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(50);
    await page.click('#channel-tabs button.pill[data-id="tutor"]');
    await page.waitForTimeout(150);   // setChannelEnabled awaits a POST before re-render
    const tutorState = await page.$eval('#channel-tabs button.pill[data-id="tutor"]', (el) => ({
      enabled: el.classList.contains('enabled'), active: el.classList.contains('active') }));
    brandActive = await page.$eval('#channel-tabs h1.brand', (el) => el.classList.contains('active'));
    assert.equal(tutorState.enabled, false, 'clicking the active pill disables it (outline)');
    assert.equal(tutorState.active, false, 'the disabled pill is no longer active');
    assert.equal(brandActive, true, 'home (brand) is active again after toggling off');

    await page.close();
  });
});

test('guru is domain-gated (life) — appears as a disabled outline pill by default — issue #46', async () => {
  await withServerAndPage(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT}/chat`);
    await page.waitForSelector('#channel-tabs button.pill');

    const guru = await page.$('#channel-tabs button.pill[data-id="guru"]');
    assert.ok(guru, 'guru still appears as a pill (all pills always shown)');
    const state = await page.$eval('#channel-tabs button.pill[data-id="guru"]', (el) => ({
      enabled: el.classList.contains('enabled'), disabled: el.classList.contains('disabled'),
      active: el.classList.contains('active'), title: el.getAttribute('title') || '' }));
    assert.equal(state.enabled, false, 'guru must be disabled by default (fail-closed, local-only)');
    assert.equal(state.disabled, true, 'guru renders as an outline (disabled) pill');
    assert.equal(state.active, false, 'guru is not active by default');
    assert.match(state.title, /life/, 'guru pill tooltip preserves its life-domain classification');

    await page.close();
  });
});
