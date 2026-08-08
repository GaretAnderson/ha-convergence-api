// tests/history.unit.js — C-pull "load full history" (garets-config#1051 v1):
// reconstructs a channel transcript from events.jsonl + session-review
// artifacts, with NO hard dependency on the (unbuilt) session ledger #1019.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEventsJsonl,
  findFiles,
  loadChannelHistory,
  agentIdentitiesForChannel
} = require('../history.js');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('parseEventsJsonl extracts user.message/assistant.message events, skipping malformed lines', () => {
  const dir = mkTmpDir('events-');
  const file = path.join(dir, 'events.jsonl');
  const lines = [
    JSON.stringify({ type: 'user.message', user_content: 'hi there', timestamp: '2026-01-01T00:00:00Z' }),
    '',
    'not json at all',
    JSON.stringify({ type: 'tool.execution_start', timestamp: '2026-01-01T00:00:01Z' }),
    JSON.stringify({ type: 'assistant.message', assistant_content: 'hello!', timestamp: '2026-01-01T00:00:02Z' })
  ];
  fs.writeFileSync(file, lines.join('\n'));
  try {
    const msgs = parseEventsJsonl(file);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].from, 'user');
    assert.equal(msgs[0].body, 'hi there');
    assert.equal(msgs[1].from, 'assistant');
    assert.equal(msgs[1].body, 'hello!');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseEventsJsonl returns [] for a missing file (degrades gracefully, never throws)', () => {
  const msgs = parseEventsJsonl(path.join(os.tmpdir(), 'definitely-does-not-exist-events.jsonl'));
  assert.deepEqual(msgs, []);
});

test('findFiles recursively locates events.jsonl and degrades to [] when root is missing', () => {
  const dir = mkTmpDir('sessions-');
  const sub = path.join(dir, 'session-state', 'abc123');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'events.jsonl'), '{}');
  try {
    const found = findFiles(dir, 'events.jsonl');
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith('events.jsonl'));
    assert.deepEqual(findFiles(path.join(dir, 'nope'), 'events.jsonl'), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agentIdentitiesForChannel maps known channel ids to CLI agent identities', () => {
  assert.deepEqual(agentIdentitiesForChannel({ id: 'helper' }), ['garets-helper']);
  assert.deepEqual(agentIdentitiesForChannel({ id: 'tutor' }), ['garets-tutor']);
  assert.deepEqual(agentIdentitiesForChannel({ id: 'guru' }), ['garets-guru']);
});

test('loadChannelHistory reconstructs a full transcript from events.jsonl under AGENT_EVENTS_ROOT (v1: no #1019 dependency)', () => {
  const root = mkTmpDir('agent-events-root-');
  const prevRoot = process.env.AGENT_EVENTS_ROOT;
  process.env.AGENT_EVENTS_ROOT = root;
  // Force a fresh require so the module re-reads the env var.
  delete require.cache[require.resolve('../history.js')];
  const freshHistory = require('../history.js');
  try {
    const sessionDir = path.join(root, 'garets-helper', 'session-state', 'sess-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), [
      JSON.stringify({ type: 'user.message', user_content: 'what is #1051 about?', timestamp: '2026-08-01T10:00:00Z' }),
      JSON.stringify({ type: 'assistant.message', assistant_content: 'purpose-channels for agent chat', timestamp: '2026-08-01T10:00:05Z' })
    ].join('\n'));

    const result = freshHistory.loadChannelHistory({ id: 'helper', handles: ['garets-helper@aorus'] });
    assert.equal(result.channel, 'helper');
    assert.equal(result.count, 2);
    assert.equal(result.messages[0].from, 'user');
    assert.equal(result.messages[0].class, 'live');
    assert.equal(result.messages[1].from, 'assistant');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (prevRoot === undefined) delete process.env.AGENT_EVENTS_ROOT; else process.env.AGENT_EVENTS_ROOT = prevRoot;
    delete require.cache[require.resolve('../history.js')];
  }
});

test('loadChannelHistory degrades to an empty transcript (not an error) when the events root is unmounted/missing', () => {
  const prevRoot = process.env.AGENT_EVENTS_ROOT;
  process.env.AGENT_EVENTS_ROOT = path.join(os.tmpdir(), 'nonexistent-agent-events-root-xyz');
  delete require.cache[require.resolve('../history.js')];
  const freshHistory = require('../history.js');
  try {
    const result = freshHistory.loadChannelHistory({ id: 'tutor', handles: ['tutor'] });
    assert.equal(result.count, 0);
    assert.deepEqual(result.messages, []);
  } finally {
    if (prevRoot === undefined) delete process.env.AGENT_EVENTS_ROOT; else process.env.AGENT_EVENTS_ROOT = prevRoot;
    delete require.cache[require.resolve('../history.js')];
  }
});
