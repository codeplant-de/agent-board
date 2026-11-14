import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, isSafeMode, parseConfig, readSecretFile } from '../src/config.mts';

const valid = {
  repos: { 'cosuno/cosuno': '~/x' },
};

test('a valid config gets defaults', () => {
  const config = parseConfig(valid);
  assert.deepEqual(config.lanes, [{ name: 'general', skills: ['*'], slots: 3 }]);
  assert.deepEqual(config.intake, {
    prompt: '/review-pr {url} --auto',
    priority: 'normal',
    allowedTools: [],
    disallowedTools: [],
    env: [],
    mcpServers: [],
  });
  assert.ok(config.defaultCwd.startsWith('/') && !config.defaultCwd.includes('~'));
  assert.deepEqual([config.pauseAfterMinutes, config.inactivityMinutes, config.maxRunHours], [5, 15, 6]);
  assert.ok(!config.repos['cosuno/cosuno']?.startsWith('~'));
});

test('invalid configs are refused with a pointed message', () => {
  const cases: [unknown, RegExp][] = [
    ['nope', /top level/],
    [{ ...valid, inactivityMinutes: 0 }, /inactivityMinutes/],
    [{ ...valid, lanes: { reviews: { skills: [] } } }, /skills must be a non-empty list/],
    [
      { ...valid, lanes: { a: { skills: ['review-pr'] }, b: { skills: ['/pr-review:review-pr'] } } },
      /in lanes a and b/,
    ],
    [{ ...valid, lanes: { a: { skills: ['*'] }, b: { skills: ['*'] } } }, /"\*" is in lanes a and b/],
    [{ ...valid, lanes: { 'a b': { skills: ['x'] } } }, /lane name/],
    [{ ...valid, lanes: { a: { skills: ['x'], slots: 0 } } }, /lanes.a.slots/],
    [{ ...valid, intake: { prompt: '/review-pr --auto' } }, /intake.prompt must be a prompt with \{url\}/],
    [{ ...valid, intake: { priority: 'asap' } }, /intake.priority must be one of/],
    [{ ...valid, defaultCwd: 'relative' }, /defaultCwd/],
    [{ ...valid, repos: { bad: '/x' } }, /owner\/name/],
  ];
  for (const [input, message] of cases)
    assert.throws(
      () => parseConfig(input),
      (error) => error instanceof ConfigError && message.test(error.message),
    );
});

test('only modes 600 and 400 pass', () => {
  assert.equal(isSafeMode(0o100600), true);
  assert.equal(isSafeMode(0o100400), true);
  for (const mode of [0o644, 0o640, 0o660, 0o700, 0o666]) assert.equal(isSafeMode(mode), false);
});

test('a secret file is refused unless owner-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'));
  const file = join(dir, 'secret');
  writeFileSync(file, 'x\n');
  chmodSync(file, 0o644);
  assert.throws(() => readSecretFile(file, 'secret file'), /mode 600 or 400, is 644/);
  chmodSync(file, 0o600);
  assert.equal(readSecretFile(file, 'secret file'), 'x\n');
  assert.throws(() => readSecretFile(join(dir, 'missing'), 'secret file'), /secret file missing/);
});

test('old keys of earlier versions are ignored', () => {
  const config = parseConfig({
    ...valid,
    backend: { command: ['~/bin/web-backend'] },
    labels: ['x'],
    intakeLabel: 'y',
    sandbox: {},
  });
  assert.equal(config.machine, parseConfig(valid).machine);
  assert.ok(!('backendCommand' in config));
});
