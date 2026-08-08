// history.js — C-pull "load full history" (garets-config#1051 v1).
//
// Reconstructs a purpose-channel's full transcript from the agent's EXISTING
// Copilot CLI session logs:
//   - events.jsonl   — the per-session, append-only, crash-proof event log the
//                       wrapper already reads for resume (user.message /
//                       assistant.message events carry the actual conversation).
//   - session-review artifacts — markdown summaries written by the
//                       session-review skill on session exit.
//
// Deliberately NO hard dependency on the (designed, unbuilt) session ledger
// #1019 — see garets-config#1051's resolved design decision. #1019 becomes a
// drop-in upgrade of this source later (swap the reader, keep the endpoint
// contract), not a gate on shipping v1.
//
// Directory convention (overridable via env for the real deployment — the
// exact host mount path is a follow-up ops task, see garets-config#1051
// follow-ups): AGENT_EVENTS_ROOT/<agent>/**/events.jsonl and
// AGENT_SESSION_REVIEW_ROOT/<agent>/*.md, where <agent> is the CLI agent
// identity backing the channel's handle(s) (e.g. "garets-helper", "garets-tutor").
'use strict';

const fs = require('fs');
const path = require('path');

const EVENTS_ROOT = process.env.AGENT_EVENTS_ROOT || '';
const SESSION_REVIEW_ROOT = process.env.AGENT_SESSION_REVIEW_ROOT || '';

/**
 * Recursively find files matching `filename` under `root`, up to `maxDepth`.
 * Returns [] if root doesn't exist or isn't readable — never throws, so a
 * missing/unmounted directory degrades to an empty transcript instead of a
 * 500.
 * @param {string} root
 * @param {string} filename
 * @param {number} maxDepth
 * @returns {string[]}
 */
function findFiles(root, filename, maxDepth = 4) {
  const out = [];
  if (!root) return out;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name === filename) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Parse an events.jsonl file into transcript entries: one per user.message /
 * assistant.message event, oldest-first. Malformed/blank lines are skipped,
 * never fatal.
 * @param {string} eventsPath
 * @returns {Array<{from:string, body:string, timestamp:string}>}
 */
function parseEventsJsonl(eventsPath) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (!evt || !evt.type) continue;
    if (evt.type === 'user.message' && evt.user_content) {
      out.push({ from: 'user', body: String(evt.user_content), timestamp: evt.timestamp || null });
    } else if (evt.type === 'assistant.message' && evt.assistant_content) {
      out.push({ from: 'assistant', body: String(evt.assistant_content), timestamp: evt.timestamp || null });
    }
  }
  return out;
}

/**
 * Load session-review markdown summaries for an agent (the "B" ambient
 * summaries — rendered here as part of the pulled transcript too, so
 * "load full history" is a complete picture even without a live sweep).
 * @param {string} agent
 * @returns {Array<{from:string, body:string, timestamp:string}>}
 */
function loadSessionReviewSummaries(agent) {
  const out = [];
  if (!SESSION_REVIEW_ROOT || !agent) return out;
  const dir = path.join(SESSION_REVIEW_ROOT, agent);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    const p = path.join(dir, f);
    let body;
    try { body = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let mtime = null;
    try { mtime = fs.statSync(p).mtime.toISOString(); } catch { /* ignore */ }
    out.push({ from: 'session-review', body, timestamp: mtime, sourceFile: f });
  }
  return out;
}

/**
 * Reconstruct the full transcript for a channel's agent(s): every
 * events.jsonl under that agent's event root, plus session-review summaries,
 * merged and sorted oldest-first. Returns an empty transcript (not an error)
 * when nothing is found — e.g. events root not mounted, or agent has no
 * sessions yet.
 * @param {{id:string, handles?:string[]}} channel
 * @returns {{channel:string, count:number, messages:Array<object>}}
 */
function loadChannelHistory(channel) {
  const agents = agentIdentitiesForChannel(channel);
  const messages = [];
  for (const agent of agents) {
    const agentRoot = EVENTS_ROOT ? path.join(EVENTS_ROOT, agent) : '';
    for (const ep of findFiles(agentRoot, 'events.jsonl')) {
      for (const m of parseEventsJsonl(ep)) messages.push({ ...m, class: 'live', agent });
    }
    for (const m of loadSessionReviewSummaries(agent)) messages.push({ ...m, class: 'swept-summary', agent });
  }
  messages.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  return { channel: channel.id, count: messages.length, messages };
}

/**
 * Map a channel's handles (e.g. "garets-helper@aorus", "tutor") to bare CLI
 * agent identities (e.g. "garets-helper", "garets-tutor") used as the
 * directory name under AGENT_EVENTS_ROOT / AGENT_SESSION_REVIEW_ROOT.
 * @param {{id:string, handles?:string[]}} channel
 * @returns {string[]}
 */
function agentIdentitiesForChannel(channel) {
  const KNOWN = { helper: 'garets-helper', tutor: 'garets-tutor', advisor: 'garets-advisor', guru: 'garets-guru' };
  if (KNOWN[channel.id]) return [KNOWN[channel.id]];
  const handles = Array.isArray(channel.handles) ? channel.handles : [];
  const bare = new Set();
  for (const h of handles) bare.add(String(h).split('@')[0]);
  return [...bare];
}

module.exports = { loadChannelHistory, parseEventsJsonl, findFiles, loadSessionReviewSummaries, agentIdentitiesForChannel };
