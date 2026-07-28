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
//
// Deploy-order transition (issue #31 review): once a token IS configured,
// old/existing clients that haven't been updated to send it yet (and a phone
// UI that hasn't prompted+stored a token on first load) would otherwise be
// hard-401'd the instant the operator sets `relay_token`, before they've had
// a chance to roll out client-side support. `options.graceUntil()` — an
// epoch-ms deadline supplied by the caller (see server.js's
// `relay_token_grace_hours` option) — lets unauthenticated/invalid-token
// requests through *for a bounded window* instead, logging each one so the
// grace window's real usage is visible and the operator knows when it's
// safe to let it lapse. After the deadline (or if no grace window is
// configured), enforcement is strict again. This never weakens the
// fails-closed guarantee above — an unset token still always 503s.
function createRelayAuthMiddleware(getToken, options = {}) {
  const graceUntilFn = typeof options.graceUntil === 'function'
    ? options.graceUntil
    : () => options.graceUntil || 0;

  return function requireRelayAuth(req, res, next) {
    const token = typeof getToken === 'function' ? getToken() : getToken;
    if (!token) {
      res.status(503).json({ error: 'relay auth not configured — set the relay_token add-on option' });
      return;
    }

    const supplied = extractToken(req);
    if (supplied && timingSafeEqualStr(supplied, token)) {
      next();
      return;
    }

    const graceUntil = graceUntilFn();
    if (graceUntil && Date.now() < graceUntil) {
      console.warn(
        `[relay] WARNING: allowing request without a valid token through the auth transition grace window ` +
        `(expires ${new Date(graceUntil).toISOString()}) — ${req.method} ${req.originalUrl || req.url}`
      );
      res.set('X-Relay-Auth-Grace', 'active');
      next();
      return;
    }

    // Clear 401 with remediation guidance rather than a bare rejection, so
    // stuck clients/operators know exactly how to fix it.
    res.set('WWW-Authenticate', 'Bearer realm="agent-relay"');
    res.status(401).json({
      error: 'unauthorized — missing or invalid relay token',
      hint:
        'Send Authorization: Bearer <token> (CLI/PowerShell clients) or ?token=<token> ' +
        '(browser/SSE/<img> requests). In the chat UI, set/update the token via the 🔑 button.'
    });
  };
}

module.exports = { timingSafeEqualStr, extractToken, createRelayAuthMiddleware };
