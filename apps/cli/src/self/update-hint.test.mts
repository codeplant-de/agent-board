import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBoard } from '../commands/program.mts';
import type { ProgramOptions } from '../commands/program.mts';
import type { LinkingContext } from '../cli.mts';
import { HINT_EVERY_MS, updateHint } from './update-hint.mts';
import { CONFIG, fakeBackend, fakeUpdateState, linkTo, task } from '../__tests__/helpers/fakes.mts';

const NOW = new Date('2026-01-01T12:00:00Z');

const base = { advertised: '0.7.0', version: '0.6.0', now: NOW, interactive: true };

test('a newer advertised release gets one line, once per 24 hours', () => {
  const state = fakeUpdateState();
  const line = updateHint({ ...base, state });
  assert.match(line ?? '', /^board 0\.7\.0 is available \(this is 0\.6\.0\); run /);
  assert.equal(state.shown, undefined, 'only the caller that printed it marks it shown');
  state.markHintShown(NOW);
  assert.equal(updateHint({ ...base, state }), undefined);
  const later = new Date(NOW.getTime() + HINT_EVERY_MS);
  assert.ok(updateHint({ ...base, state, now: later }));
});

test('nothing for an equal, older or unknown release, a checkout of the same base, or a non-interactive caller', () => {
  for (const advertised of ['0.6.0', '0.5.9', undefined])
    assert.equal(updateHint({ ...base, advertised, state: fakeUpdateState() }), undefined, String(advertised));
  assert.equal(updateHint({ ...base, version: '0.7.0-dev', state: fakeUpdateState() }), undefined);
  const state = fakeUpdateState();
  assert.equal(updateHint({ ...base, interactive: false, state }), undefined);
  assert.equal(state.shown, undefined);
});

test('a checkout is told to pull, and compares as its base version', () => {
  const line = updateHint({ ...base, version: '0.6.0-dev', state: fakeUpdateState() });
  assert.match(line ?? '', /\(this is 0\.6\.0-dev\); run "git pull"/);
});

function run(overrides: ProgramOptions, advertised: string | null = '0.9.0') {
  const err: string[] = [];
  const state = fakeUpdateState();
  const context = (dryRun: boolean): LinkingContext => ({
    config: CONFIG,
    backend: fakeBackend([task({ id: 'abc' })]),
    dryRun,
    taskLink: linkTo,
    print: () => undefined,
    serverCli: () => advertised ?? undefined,
  });
  const go = (argv: string[]) =>
    runBoard(argv, {
      env: {},
      context,
      version: '0.6.0',
      stderrIsTty: true,
      updateState: state,
      now: () => NOW,
      writeOut: () => undefined,
      writeErr: (text) => err.push(text),
      ...overrides,
    });
  return { err, go, state };
}

test('a command that reached the board prints the hint on stderr after it ran, once', async () => {
  const { err, go } = run({});
  await go(['tasks']);
  assert.deepEqual(err, [
    'board 0.9.0 is available (this is 0.6.0); run "git pull" and "pnpm install" in the checkout\n',
  ]);
  await go(['tasks']);
  assert.equal(err.length, 1);
});

test('no hint without a terminal, inside a run, or when the board named no release', async () => {
  const piped = run({ stderrIsTty: false });
  await piped.go(['tasks']);
  const inRun = run({ env: { AGENT_BOARD_TASK: 'abc' } });
  await inRun.go(['tasks']);
  const silent = run({}, null);
  await silent.go(['tasks']);
  assert.deepEqual([...piped.err, ...inRun.err, ...silent.err], []);
  assert.equal(piped.state.shown, undefined);
});
