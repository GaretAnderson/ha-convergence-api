// tests/channels.unit.js — Get-RelayChannelRegistry mirror (garets-config#1051 v1):
// registry-driven channels, guru disabled by default, fail-closed domain->policy.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadChannels, resolveIngestionPolicy, defaultVisible } = require('../channels.js');

test('loadChannels returns the vendored registry with helper/tutor/advisor/threads + guru', () => {
  const channels = loadChannels();
  const ids = channels.map((c) => c.id).sort();
  assert.deepEqual(ids, ['advisor', 'guru', 'helper', 'tutor', 'threads'].sort());
});

test('guru is disabled by default (life-domain, local-only, fail-closed)', () => {
  const channels = loadChannels();
  const guru = channels.find((c) => c.id === 'guru');
  assert.equal(guru.enabledByDefault, false);
  assert.equal(guru.domain, 'life');
  assert.equal(guru.ingestionPolicy, 'none');
});

test('helper/tutor/advisor/threads are enabled by default', () => {
  const channels = loadChannels();
  for (const id of ['helper', 'tutor', 'advisor', 'threads']) {
    const c = channels.find((x) => x.id === id);
    assert.equal(c.enabledByDefault, true, `${id} should be enabled by default`);
  }
});

test('helper channel subsumes @aorus/@laptop as legacy aliases', () => {
  const channels = loadChannels();
  const helper = channels.find((c) => c.id === 'helper');
  assert.ok(helper.aliases.includes('@aorus'));
  assert.ok(helper.aliases.includes('@laptop'));
});

test('defaultVisible() excludes guru but includes the other four', () => {
  const visible = defaultVisible(loadChannels());
  const ids = visible.map((c) => c.id);
  assert.ok(!ids.includes('guru'), 'guru must not be in the default-visible set');
  for (const id of ['helper', 'tutor', 'advisor', 'threads']) assert.ok(ids.includes(id));
});

test('resolveIngestionPolicy: domain classification deterministically selects ingestion policy', () => {
  assert.equal(resolveIngestionPolicy('life'), 'none');
  assert.equal(resolveIngestionPolicy('work'), 'work-gated');
  assert.equal(resolveIngestionPolicy('shared'), 'shared');
});

test('resolveIngestionPolicy fails closed (-> none) on an unrecognized domain', () => {
  assert.equal(resolveIngestionPolicy('bogus'), 'none');
  assert.equal(resolveIngestionPolicy(''), 'none');
  assert.equal(resolveIngestionPolicy(undefined), 'none');
  assert.equal(resolveIngestionPolicy(null), 'none');
});

test('resolveIngestionPolicy is case-insensitive', () => {
  assert.equal(resolveIngestionPolicy('SHARED'), 'shared');
  assert.equal(resolveIngestionPolicy('Work'), 'work-gated');
});
