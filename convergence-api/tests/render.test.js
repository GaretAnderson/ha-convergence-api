// Tests for render.js — sanitized markdown rendering of Agent Chat message
// bodies. Run with `npm test` (uses Node's built-in test runner).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMessageHtml, extractAttachments, imgTag, isSafeAttachmentUrl } = require('../render.js');

test('renders GFM tables as HTML tables', () => {
  const html = renderMessageHtml('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test('renders bare URLs as clickable, safe anchors', () => {
  const html = renderMessageHtml('see https://example.com/path for more');
  assert.match(html, /<a href="https:\/\/example\.com\/path" target="_blank" rel="noopener noreferrer">/);
});

test('renders [text](url) links as clickable, safe anchors', () => {
  const html = renderMessageHtml('[docs](https://example.com/docs)');
  assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test('renders bold, italic, inline code, lists, headings, blockquotes', () => {
  const html = renderMessageHtml(
    '**bold** _italic_ `code`\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n# Heading'
  );
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul>[\s\S]*<li>one<\/li>/);
  assert.match(html, /<ol>[\s\S]*<li>first<\/li>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<h1>Heading<\/h1>/);
});

test('renders fenced code blocks', () => {
  const html = renderMessageHtml('```js\nconst x = 1;\n```');
  assert.match(html, /<pre><code class="language-js">/);
});

test('plain text messages are unaffected beyond a paragraph wrap', () => {
  const html = renderMessageHtml('just plain text, nothing special');
  assert.equal(html, '<p>just plain text, nothing special</p>\n');
});

test('strips <script> tags entirely (no injection)', () => {
  const html = renderMessageHtml('<script>alert(1)</script>hello');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /hello/);
});

test('strips javascript: scheme from links', () => {
  const html = renderMessageHtml('[xss](javascript:alert(1))');
  assert.doesNotMatch(html, /javascript:/i);
});

test('strips event-handler attributes from raw HTML', () => {
  const html = renderMessageHtml('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /onerror/i);
});

test('extracts and strips [[attach: url]] tokens', () => {
  const { text, attachments } = extractAttachments('hello [[attach: https://example.com/pic.png]] world');
  assert.equal(text, 'hello  world');
  assert.deepEqual(attachments, ['https://example.com/pic.png']);
});

test('renders attachment tokens as sanitized <img> tags after the message text', () => {
  const html = renderMessageHtml('hello [[attach: https://example.com/pic.png]]');
  assert.match(html, /<p>hello<\/p>/);
  assert.match(html, /<img src="https:\/\/example\.com\/pic\.png" alt="attachment" class="chat-attachment" loading="lazy">/);
});

test('imgTag escapes attribute-breaking characters in the URL', () => {
  const html = imgTag('https://example.com/pic.png?a=1&b="x"');
  assert.doesNotMatch(html, /"x"/); // raw quote must be escaped
  assert.match(html, /&amp;b=&quot;x&quot;/);
});

test('imgTag rejects javascript: attachment URLs (no <img> emitted)', () => {
  assert.equal(imgTag('javascript:alert(1)'), '');
  assert.equal(imgTag('JaVaScRiPt:alert(1)'), '');
  assert.equal(imgTag(' javascript:alert(1)'), '');
});

test('imgTag rejects data: attachment URLs (no <img> emitted)', () => {
  assert.equal(imgTag('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(imgTag('data:image/svg+xml;base64,PHN2Zz4='), '');
});

test('imgTag rejects vbscript:, file:, and protocol-relative URLs', () => {
  assert.equal(imgTag('vbscript:msgbox(1)'), '');
  assert.equal(imgTag('file:///etc/passwd'), '');
  assert.equal(imgTag('//evil.com/x.png'), '');
});

test('imgTag rejects malformed/control-character URLs used to bypass scheme checks', () => {
  assert.equal(imgTag('java\tscript:alert(1)'), '');
  assert.equal(imgTag('   '), '');
  assert.equal(imgTag(''), '');
});

test('imgTag allows http(s) and root-relative /files URLs', () => {
  assert.match(imgTag('https://example.com/pic.png'), /<img src="https:\/\/example\.com\/pic\.png"/);
  assert.match(imgTag('http://example.com/pic.png'), /<img src="http:\/\/example\.com\/pic\.png"/);
  assert.match(imgTag('/files/pic.png'), /<img src="\/files\/pic\.png"/);
});

test('isSafeAttachmentUrl validates scheme/path allowlist directly', () => {
  assert.equal(isSafeAttachmentUrl('https://example.com/a.png'), true);
  assert.equal(isSafeAttachmentUrl('/files/a.png'), true);
  assert.equal(isSafeAttachmentUrl('javascript:alert(1)'), false);
  assert.equal(isSafeAttachmentUrl('data:image/png;base64,abc'), false);
  assert.equal(isSafeAttachmentUrl('//evil.com/a.png'), false);
});

test('renderMessageHtml drops malicious [[attach:]] tokens instead of injecting javascript: img src', () => {
  const html = renderMessageHtml('hello [[attach: javascript:alert(document.cookie)]]');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /<p>hello<\/p>/);
});

test('renderMessageHtml drops malicious [[attach:]] data: URL tokens', () => {
  const html = renderMessageHtml('hello [[attach: data:text/html,<script>alert(1)</script>]]');
  assert.doesNotMatch(html, /data:/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<script/i);
});
