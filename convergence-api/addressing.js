// addressing.js — Agent Chat recipient addressing (garets-config#901 Phase 1).
//
// Message model: `to` is a string array of handles. A single string is still
// accepted on input for back-compat with legacy senders/messages and is
// normalized to a one-element array before storage. There is no `@all`
// broadcast handle — it has been removed entirely; the composer no longer
// offers it and a literal "@all" recipient is treated as an ordinary
// (non-matching-everyone) handle.
//
// Ported from GaretAnderson/homeassistant PR #71 (addons/convergence-api).
'use strict';

// The addressable handles offered by the composer's multi-select. Phase 2
// (garets-config#901) will extend/rename this list (per-agent handles,
// garets-helper rename) — kept intentionally small for Phase 1.
const HANDLES = ['@aorus', '@laptop', '@ha-assist'];

/**
 * Normalize a raw `to` value (string, string array, null/undefined) from a
 * publish request into a clean string array: trims each entry, drops
 * empty/falsy entries, and de-duplicates case-insensitively while preserving
 * the first-seen casing and order.
 * @param {unknown} to
 * @returns {string[]}
 */
function normalizeRecipients(to) {
  const raw = Array.isArray(to) ? to : (to === null || to === undefined ? [] : [to]);
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (entry === null || entry === undefined) continue;
    const handle = `${entry}`.trim();
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

/**
 * True if `handle` is a member of a message's recipients (case-insensitive).
 * Accepts either the normalized array form or a legacy single-string `to`.
 * @param {{ to?: unknown }} msg
 * @param {string} handle
 * @returns {boolean}
 */
function isAddressedTo(msg, handle) {
  if (!msg || !handle) return false;
  const recipients = normalizeRecipients(msg.to);
  const target = handle.trim().toLowerCase();
  return recipients.some((r) => r.toLowerCase() === target);
}

module.exports = { HANDLES, normalizeRecipients, isAddressedTo };
