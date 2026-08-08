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
