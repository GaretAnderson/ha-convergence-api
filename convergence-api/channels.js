// channels.js — Agent Chat purpose-channel registry (garets-config#1051 v1).
//
// This is a VENDORED SNAPSHOT of garets-config's canonical registry
// (lib/RelayResponder.ps1 Get-RelayChannelRegistry), exported via
// tools/Export-AgentChatChannels.ps1 into channels.json alongside this file.
// chat.html cannot invoke PowerShell at runtime, so the channel list, domain
// classification, and ingestion policy live here as a committed copy —
// re-export + re-copy channels.json whenever the garets-config registry
// changes. See garets-config#1051 for the design and the manual-sync
// rationale (mirrors the C-pull v1 "no hard #1019 dependency" pragmatism).
//
// Replaces/subsumes the old machine-based @aorus/@laptop/@all addressing
// (addressing.js) with one channel per agent PURPOSE.
'use strict';

const fs = require('fs');
const path = require('path');

const CHANNELS_FILE = path.join(__dirname, 'channels.json');

/**
 * Domain -> ingestion-policy mapping (garets-config#1051), fail-closed on any
 * unrecognized domain. Mirrors Resolve-RelayChannelIngestionPolicy in
 * garets-config lib/RelayResponder.ps1 — keep the two in sync.
 * @param {string} domain
 * @returns {'none'|'work-gated'|'shared'}
 */
function resolveIngestionPolicy(domain) {
  switch (String(domain || '').toLowerCase()) {
    case 'life': return 'none';
    case 'work': return 'work-gated';
    case 'shared': return 'shared';
    default: return 'none'; // fail-closed
  }
}

/**
 * Load the vendored channel registry. Falls back to a minimal built-in
 * registry (guru disabled) if channels.json is missing/corrupt, so the chat
 * UI never silently loses its fail-closed guru default.
 * @returns {Array<object>}
 */
function loadChannels() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    const channels = Array.isArray(raw.channels) ? raw.channels : [];
    if (channels.length) {
      return channels.map((c) => ({
        ...c,
        // Always recompute policy from domain here rather than trust the
        // vendored value blindly — fail-closed even if channels.json drifts.
        ingestionPolicy: resolveIngestionPolicy(c.domain)
      }));
    }
  } catch { /* fall through to built-in fallback below */ }
  return [
    { id: 'helper', label: 'Helper', domain: 'shared', enabledByDefault: true, handles: [], aliases: ['@aorus', '@laptop'] },
    { id: 'tutor', label: 'Tutor', domain: 'shared', enabledByDefault: true, handles: [], aliases: [] },
    { id: 'advisor', label: 'Advisor', domain: 'work', enabledByDefault: true, handles: [], aliases: [] },
    { id: 'threads', label: 'Threads', domain: 'shared', enabledByDefault: true, handles: [], aliases: [] },
    { id: 'guru', label: 'Guru', domain: 'life', enabledByDefault: false, handles: [], aliases: [] }
  ].map((c) => ({ ...c, ingestionPolicy: resolveIngestionPolicy(c.domain) }));
}

/**
 * Channels visible in the UI by default (guru excluded — fail-closed local-only).
 * @param {Array<object>} channels
 * @returns {Array<object>}
 */
function defaultVisible(channels) {
  return channels.filter((c) => c.enabledByDefault);
}

module.exports = { loadChannels, resolveIngestionPolicy, defaultVisible, CHANNELS_FILE };
