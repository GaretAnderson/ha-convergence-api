// Tests for auth.js — shared-secret relay auth (issue #29 / #24). Run with
// `npm test` (Node's built-in test runner).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timingSafeEqualStr, extractToken, createRelayAuthMiddleware } = require('../auth.js');

function mockReq({ authorization, query } = {}) {
  const headers = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return {
    headers,
    get(name) { return headers[name.toLowerCase()]; },
    query: query || {}
  };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('timingSafeEqualStr matches identical strings', () => {
  assert.equal(timingSafeEqualStr('secret123', 'secret123'), true);
});

test('timingSafeEqualStr rejects mismatched strings of the same length', () => {
  assert.equal(timingSafeEqualStr('secret123', 'secret124'), false);
});

test('timingSafeEqualStr rejects strings of different length (no throw)', () => {
  assert.equal(timingSafeEqualStr('short', 'muchlongersecret'), false);
});

test('extractToken reads a Bearer authorization header', () => {
  const req = mockReq({ authorization: 'Bearer abc123' });
  assert.equal(extractToken(req), 'abc123');
});

test('extractToken is case-insensitive on the Bearer scheme', () => {
  const req = mockReq({ authorization: 'bearer abc123' });
  assert.equal(extractToken(req), 'abc123');
});

test('extractToken falls back to ?token= query param (phone UI / SSE / <img>)', () => {
  const req = mockReq({ query: { token: 'abc123' } });
  assert.equal(extractToken(req), 'abc123');
});

test('extractToken prefers the Authorization header over the query param', () => {
  const req = mockReq({ authorization: 'Bearer header-token', query: { token: 'query-token' } });
  assert.equal(extractToken(req), 'header-token');
});

test('extractToken returns empty string when no token is supplied', () => {
  assert.equal(extractToken(mockReq()), '');
});

test('requireRelayAuth fails closed (503) when no token is configured', () => {
  const middleware = createRelayAuthMiddleware(() => '');
  const req = mockReq({ authorization: 'Bearer anything' });
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
});

test('requireRelayAuth rejects (401) a missing token when configured', () => {
  const middleware = createRelayAuthMiddleware(() => 'the-secret');
  const req = mockReq();
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireRelayAuth rejects (401) an incorrect token', () => {
  const middleware = createRelayAuthMiddleware(() => 'the-secret');
  const req = mockReq({ authorization: 'Bearer wrong' });
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireRelayAuth calls next() for a valid Authorization header token', () => {
  const middleware = createRelayAuthMiddleware(() => 'the-secret');
  const req = mockReq({ authorization: 'Bearer the-secret' });
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('requireRelayAuth calls next() for a valid ?token= query param', () => {
  const middleware = createRelayAuthMiddleware(() => 'the-secret');
  const req = mockReq({ query: { token: 'the-secret' } });
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('requireRelayAuth re-reads the token on every call (picks up late config)', () => {
  let current = '';
  const middleware = createRelayAuthMiddleware(() => current);
  const req = mockReq({ authorization: 'Bearer now-set' });
  const res1 = mockRes();
  middleware(req, res1, () => {});
  assert.equal(res1.statusCode, 503); // not configured yet

  current = 'now-set';
  const res2 = mockRes();
  let nextCalled = false;
  middleware(req, res2, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
