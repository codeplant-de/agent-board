import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VocabularyFeatures } from './index.mts';
import {
  announcedClientFeatures,
  BASELINE_SERVER_FEATURES,
  CLIENT_CAPABILITIES,
  clientVocabulary,
  ContractError,
  findUnknownVocabulary,
  neededServerFeature,
  parseClientFeatures,
  parseVersionFeatures,
  SERVER_FEATURE_LABELS,
  SERVER_FEATURES,
  VOCABULARY_FEATURES,
} from './index.mts';

// Existing values stand in for ones added after the baseline: a client that sends `status.backlog` knows `backlog`.
const ADDED: VocabularyFeatures = {
  status: { backlog: 'status.backlog' },
  kind: { event: 'note.event', polish: 'note.event' },
};

test('every server feature has a label, and the baseline is part of the list', () => {
  assert.deepEqual(Object.keys(SERVER_FEATURE_LABELS).sort(), [...SERVER_FEATURES].sort());
  for (const feature of BASELINE_SERVER_FEATURES) assert.ok(SERVER_FEATURES.includes(feature));
  assert.ok(SERVER_FEATURES.includes('task.configure'));
  assert.ok(!BASELINE_SERVER_FEATURES.includes('task.configure' as never));
});

test('a version answer without features has the baseline; a list is taken as it is; junk is refused', () => {
  assert.deepEqual(parseVersionFeatures({ contract: 9 }), new Set(BASELINE_SERVER_FEATURES));
  assert.deepEqual(parseVersionFeatures({ features: ['wait', 'future.thing'] }), new Set(['wait', 'future.thing']));
  assert.deepEqual(parseVersionFeatures({ features: [] }), new Set());
  for (const features of ['wait', [1], ['Has Space'], [''], ['x'.repeat(65)], Array.from({ length: 300 }, () => 'a')])
    assert.throws(() => parseVersionFeatures({ features }), ContractError, JSON.stringify(features).slice(0, 40));
});

test('today the client vocabulary is empty: every enum value is the baseline', () => {
  assert.deepEqual(VOCABULARY_FEATURES, {});
  assert.deepEqual(clientVocabulary(), []);
  assert.equal(findUnknownVocabulary({ status: 'waiting', kind: 'polish', priority: 'low' }, new Set()), undefined);
});

test('a client announces the capabilities of this build besides its vocabulary', () => {
  assert.deepEqual(announcedClientFeatures(), ['schedule.after']);
  assert.deepEqual(announcedClientFeatures(ADDED, ['b.cap', 'schedule.after']), [
    'b.cap',
    'note.event',
    'schedule.after',
    'status.backlog',
  ]);
  assert.deepEqual(CLIENT_CAPABILITIES, ['schedule.after']);
  assert.equal(parseClientFeatures(announcedClientFeatures().join(',')).has('schedule.after'), true);
});

test('the schedule capabilities of the server are named and labelled', () => {
  for (const name of ['task.held', 'schedule.crons', 'schedule.max-concurrent', 'schedule.after'] as const) {
    assert.ok(SERVER_FEATURES.includes(name), name);
    assert.ok(SERVER_FEATURE_LABELS[name].length > 0, name);
  }
});

test('the client vocabulary lists each feature of the table once', () => {
  assert.deepEqual(clientVocabulary(ADDED), ['note.event', 'status.backlog']);
});

test('a value that needs a feature the client did not send is found, and one it sent is not', () => {
  assert.deepEqual(findUnknownVocabulary({ status: 'backlog' }, new Set(), ADDED), {
    field: 'status',
    value: 'backlog',
    feature: 'status.backlog',
  });
  assert.equal(findUnknownVocabulary({ status: 'backlog' }, new Set(['status.backlog']), ADDED), undefined);
  assert.equal(findUnknownVocabulary({ status: 'todo', kind: 'comment' }, new Set(), ADDED), undefined);
  assert.equal(findUnknownVocabulary({ kind: 'polish' }, new Set(['note.event']), ADDED), undefined);
  assert.equal(findUnknownVocabulary({ kind: 'polish' }, new Set(), ADDED)?.feature, 'note.event');
  assert.equal(findUnknownVocabulary({ status: 5, kind: null }, new Set(), ADDED), undefined);
  assert.equal(findUnknownVocabulary({ status: 'toString' }, new Set(), ADDED), undefined);
});

test('the header is read leniently: capped, junk ignored, never an error', () => {
  assert.deepEqual(parseClientFeatures(undefined), new Set());
  assert.deepEqual(parseClientFeatures(''), new Set());
  assert.deepEqual(parseClientFeatures('status.backlog, note.event'), new Set(['status.backlog', 'note.event']));
  assert.deepEqual(parseClientFeatures(['a.b', 'c']), new Set(['a.b', 'c']));
  assert.deepEqual(parseClientFeatures(',, A B ,ok,\u0000x,<script>,a'), new Set(['ok', 'a']));
  assert.equal(parseClientFeatures(Array.from({ length: 500 }, (_, i) => `f${i}`).join(',')).size, 64);
  assert.equal(parseClientFeatures(`${'a,'.repeat(600)}late`).has('late'), false);
  assert.deepEqual(parseClientFeatures('x'.repeat(100_000)), new Set());
});

test('a sendable value names the server feature it needs', () => {
  const table = { status: { waiting: 'wait' }, priority: { low: 'events' } } as const;
  assert.equal(neededServerFeature({ status: 'waiting' }, table), 'wait');
  assert.equal(neededServerFeature({ status: 'todo', priority: 'low' }, table), 'events');
  assert.equal(neededServerFeature({ status: 'todo', priority: 'high' }, table), undefined);
  assert.equal(neededServerFeature({ status: 'waiting' }), undefined);
});

test('the server reads every name the CLI sends', () => {
  assert.equal(parseClientFeatures(clientVocabulary().join(',')).size, clientVocabulary().length);
});
