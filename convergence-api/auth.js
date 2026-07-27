// auth.js — shared-secret auth for the Agent Relay (issue #29 / homeassistant#70).
//
// The relay is the HA-action broker on the LAN/Tailscale surface; every
// /relay* route must require a shared secret so anonymous network access
// can't read or post into agent-to-agent / HA Assist chat (opsec issue #24).
//
// The token is accepted as either:
//   - `Authorization: Bearer <token>` header (CLI/PowerShell clients — see
//     garets-config PR #965's `Get-AgentRelayAuthHeaders`)
//   - `?token=<token>` query param (needed for browser `EventSource`/SSE and
//     plain `<img src>` tags, neither of which can set custom headers — this
//     is also the phone-UI token path so the chat page keeps working)
//
// Ported/adapted from GaretAnderson/homeassistant PR #74, refactored into a
// standalone, unit-testable module (the fork inlined this in server.js).
'use strict';

const crypto = require('crypto');

// Constant-time string comparison to avoid timing attacks on the token check.
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Pulls the caller-supplied token from a request: `Authorization: Bearer …`
// header takes precedence, falling back to `?token=`.
function extractToken(req) {
  const header = (req.get ? req.get('authorization') : req.headers && req.headers.authorization) || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return '';
}

// Builds an Express middleware that requires a valid token, resolved lazily
// via `getToken()` on every request (so a token set after the process starts,
// e.g. via HA options reload, is picked up without a restart).
//
// Fails CLOSED: if no token is configured, every request is rejected (503)
// rather than the relay silently running open — a fresh/misconfigured
// install can never reproduce the original unauthenticated exposure.
function createRelayAuthMiddleware(getToken) {
  return function requireRelayAuth(req, res, next) {
    const token = typeof getToken === 'function' ? getToken() : getToken;
    if (!token) {
      res.status(503).json({ error: 'relay auth not configured — set the relay_token add-on option' });
      return;
    }
    const supplied = extractToken(req);
    if (!supplied || !timingSafeEqualStr(supplied, token)) {
      res.status(401).json({ error: 'unauthorized — missing or invalid relay token' });
      return;
    }
    next();
  };
}

module.exports = { timingSafeEqualStr, extractToken, createRelayAuthMiddleware };
