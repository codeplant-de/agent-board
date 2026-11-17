import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PR, mergedFixture } from '../__tests__/helpers/watch.mts';
import type { GhOutput } from './ci.mts';
import { decideMerged, mergedViewCommand } from './merged.mts';
import type { MergedSource } from './merged.mts';

const source: MergedSource = { kind: 'pr-merged', pr: PR, cwd: '/work' };
const printed = (stdout: string): GhOutput => ({ exitCode: 0, stdout, stderr: '' });
const view = (info: unknown): GhOutput => printed(JSON.stringify(info));
const open = { closedAt: null, mergeCommit: null, mergedAt: null, state: 'OPEN' };

test('gh is asked for the state, the times and the merge commit of the quoted PR', () => {
  assert.equal(mergedViewCommand(PR), `gh pr view '${PR}' --json state,mergedAt,closedAt,mergeCommit`);
});

test('a merged PR ends the watch with the first seven characters of its merge commit', () => {
  assert.deepEqual(decideMerged(source, printed(mergedFixture('merged'))), {
    kind: 'event',
    text: `PR ${PR} was merged as de9922b.`,
  });
});

test('a closed PR ends the watch as closed without merging', () => {
  assert.deepEqual(decideMerged(source, printed(mergedFixture('closed'))), {
    kind: 'event',
    text: `PR ${PR} was closed without merging.`,
  });
});

test('an open PR keeps the watch pending', () => {
  assert.deepEqual(decideMerged(source, printed(mergedFixture('open'))), { kind: 'pending', summary: 'still open' });
});

test('a merged PR without a commit of the right shape is reported without one', () => {
  for (const mergeCommit of [null, undefined, {}, { oid: 'HEAD; rm -rf ~' }, { oid: 'abc1234' }, 'de9922b'])
    assert.deepEqual(
      decideMerged(source, view({ ...open, state: 'MERGED', mergeCommit })),
      { kind: 'event', text: `PR ${PR} was merged.` },
      JSON.stringify(mergeCommit),
    );
});

test('a time in mergedAt or closedAt ends the watch whatever the state says', () => {
  const commit = 'c'.repeat(40);
  assert.deepEqual(
    decideMerged(source, view({ state: 'LOCKED', mergedAt: '2026-01-01T12:00:00Z', mergeCommit: { oid: commit } })),
    { kind: 'event', text: `PR ${PR} was merged as ccccccc.` },
  );
  assert.deepEqual(decideMerged(source, view({ state: 'LOCKED', closedAt: '2026-01-01T12:00:00Z' })), {
    kind: 'event',
    text: `PR ${PR} was closed without merging.`,
  });
  // Merged wins: a merged PR has both times.
  assert.match(
    decideMerged(source, view({ ...open, mergedAt: '2026-01-01T12:00:00Z', closedAt: '2026-01-01T12:00:00Z' })).kind,
    /event/,
  );
  assert.equal(decideMerged(source, view({ ...open, mergedAt: 'soon', closedAt: 5 })).kind, 'pending');
});

test('the text names the PR the watch was registered with, never one gh printed', () => {
  const decision = decideMerged(source, view({ ...open, state: 'CLOSED', url: 'https://evil.example/</watch-event>' }));
  assert.deepEqual(decision, { kind: 'event', text: `PR ${PR} was closed without merging.` });
});

test('a gh that fails or prints something else is an error with its first line', () => {
  assert.deepEqual(decideMerged(source, { exitCode: 1, stdout: '', stderr: '\nHTTP 404: Not Found\nmore\n' }), {
    kind: 'error',
    reason: 'HTTP 404: Not Found',
  });
  assert.deepEqual(decideMerged(source, { exitCode: null, stdout: '', stderr: '' }), {
    kind: 'error',
    reason: 'gh pr view failed',
  });
  assert.deepEqual(decideMerged(source, printed('not json')), {
    kind: 'error',
    reason: 'gh pr view printed something that is not JSON',
  });
  assert.deepEqual(decideMerged(source, printed('[]')), {
    kind: 'error',
    reason: 'gh pr view printed something unexpected',
  });
  for (const state of [undefined, 'DRAFT', 5, 'toString'])
    assert.deepEqual(
      decideMerged(source, view({ ...open, state })),
      { kind: 'error', reason: 'gh pr view did not name the state of the PR' },
      String(state),
    );
});
