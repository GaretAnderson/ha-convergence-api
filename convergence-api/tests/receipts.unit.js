// Unit test for the delivery-receipt rendering in chat.html.
//
// Agent Chat shows delivery receipts as per-recipient colored names inline
// (teal = read, grey = delivered-not-yet-read) instead of an ambiguous ✓/✓✓
// that required a hover to see WHO received a message. This test extracts the
// real shipped `stripHandle`/`receiptView` functions out of chat.html and
// exercises them directly — no browser/dependencies required.
//
// Run: node tests/receipts.unit.js

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'chat.html'), 'utf8');
const start = html.indexOf('function stripHandle');
const end = html.indexOf('function ticksSpan');
if (start < 0 || end < 0) throw new Error('receipt functions not found in chat.html');
const src = html.slice(start, end);

// Same shape as chat.html's escapeHtml, without needing a DOM.
const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// eslint-disable-next-line no-eval
eval(src); // defines stripHandle() and receiptView()

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); failures++; }
  else { console.log('ok: ' + msg); }
}

// Delivered to both machines, only aorus has read (the live "REPORT IN!" case).
let v = receiptView({ receipts: { delivered: ['@laptop', '@aorus'], read: ['@aorus'] } });
assert(v.html.includes('<span class="rcpt delivered">laptop</span>'), 'unread recipient rendered grey (delivered)');
assert(v.html.includes('<span class="rcpt read">aorus</span>'), 'read recipient rendered teal (read)');
assert(v.html.includes(', '), 'multiple recipients are comma-separated');
assert(v.title === 'Delivered: laptop, aorus \u00b7 Read: aorus', 'tooltip retains full detail: ' + v.title);

// Both recipients read.
v = receiptView({ receipts: { delivered: ['@aorus', '@laptop'], read: ['@aorus', '@laptop'] } });
assert((v.html.match(/rcpt read/g) || []).length === 2, 'both names teal when both have read');

// Sent but not delivered anywhere yet.
v = receiptView({ receipts: { delivered: [], read: [] } });
assert(v.html === '<span class="rcpt sent">sent</span>' && v.title === 'Sent', 'sent state before any delivery');

// Missing receipts object.
v = receiptView({});
assert(v.html.includes('sent'), 'missing receipts falls back to sent');

// A hostile handle must be HTML-escaped.
v = receiptView({ receipts: { delivered: ['@<b>x'], read: [] } });
assert(v.html.includes('&lt;b&gt;x') && !v.html.includes('<b>x'), 'recipient handle is HTML-escaped');

// @ prefix stripped for display.
assert(stripHandle('@aorus') === 'aorus' && stripHandle('aorus') === 'aorus', 'stripHandle removes a leading @');

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\nALL PASS');
