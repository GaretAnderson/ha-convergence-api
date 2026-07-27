// Tests for addressing.js — Agent Chat multi-recipient addressing
// (garets-config#901 Phase 1). Run with `npm test` (Node's built-in test
// runner).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HANDLES, normalizeRecipients, isAddressedTo } = require('../addressing.js');

test('HANDLES offers no @all broadcast option', () => {
  assert.ok(Array.isArray(HANDLES) && HANDLES.length > 0);
  assert.ok(!HANDLES.includes('@all'));
});

test('normalizeRecipients wraps a legacy single string into a one-element array', () => {
  assert.deepEqual(normalizeRecipients('@aorus'), ['@aorus']);
});

test('normalizeRecipients passes an array through, trimming and dropping empties', () => {
  assert.deepEqual(normalizeRecipients(['@aorus', ' @laptop ', '', null, undefined]), ['@aorus', '@laptop']);
});

test('normalizeRecipients de-duplicates case-insensitively, keeping first-seen casing', () => {
  assert.deepEqual(normalizeRecipients(['@aorus', '@AORUS', '@Aorus']), ['@aorus']);
});

test('normalizeRecipients returns an empty array for null/undefined/empty', () => {
  assert.deepEqual(normalizeRecipients(null), []);
  assert.deepEqual(normalizeRecipients(undefined), []);
  assert.deepEqual(normalizeRecipients([]), []);
  assert.deepEqual(normalizeRecipients(''), []);
});

test('isAddressedTo matches membership in a multi-recipient array, case-insensitively', () => {
  const msg = { to: ['@aorus', '@laptop'] };
  assert.equal(isAddressedTo(msg, '@aorus'), true);
  assert.equal(isAddressedTo(msg, '@AORUS'), true);
  assert.equal(isAddressedTo(msg, '@laptop'), true);
  assert.equal(isAddressedTo(msg, '@ha-assist'), false);
});

test('isAddressedTo matches a legacy single-string `to` (back-compat)', () => {
  assert.equal(isAddressedTo({ to: '@aorus' }, '@aorus'), true);
  assert.equal(isAddressedTo({ to: '@AORUS' }, '@aorus'), true);
  assert.equal(isAddressedTo({ to: '@laptop' }, '@aorus'), false);
});

test('isAddressedTo returns false for unaddressed messages', () => {
  assert.equal(isAddressedTo({ to: '' }, '@aorus'), false);
  assert.equal(isAddressedTo({ to: [] }, '@aorus'), false);
  assert.equal(isAddressedTo({}, '@aorus'), false);
});

test('isAddressedTo no longer treats a literal "@all" recipient as matching every handle', () => {
  assert.equal(isAddressedTo({ to: '@all' }, '@aorus'), false);
  assert.equal(isAddressedTo({ to: ['@all'] }, '@aorus'), false);
  assert.equal(isAddressedTo({ to: '@all' }, '@all'), true); // it's just an ordinary literal handle now
});

test('a message addressed to N handles is delivered to exactly those N (delivery semantics)', () => {
  const msg = { to: ['@aorus', '@ha-assist'] };
  const allHandles = ['@aorus', '@laptop', '@ha-assist'];
  const delivered = allHandles.filter((h) => isAddressedTo(msg, h));
  assert.deepEqual(delivered, ['@aorus', '@ha-assist']);
});
