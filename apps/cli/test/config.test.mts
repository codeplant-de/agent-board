import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigError,
  configWarnings,
  isSafeMode,
  loadConfig,
  loadConfigWarnings,
  parseConfig,
  readSecretFile,
} from '../src/config.mts';

const valid = {
  repos: { 'cosuno/cosuno': '~/x' },
};

test('a valid config gets defaults', () => {
  const config = parseConfig(valid);
  assert.deepEqual(config.lanes, [{ name: 'general', skills: ['*'], slots: 3 }]);
  assert.deepEqual(config.intake, {
    prompt: '/review-pr {url} --auto',
    priority: 'normal',
  });
  assert.deepEqual(config.skills, {});
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

test('a machine name that is too long is refused with the limit, and one of 64 characters is accepted', () => {
  assert.throws(
    () => parseConfig({ ...valid, machine: 'm'.repeat(65) }),
    (error) =>
      error instanceof ConfigError && /1 to 64 characters/.test(error.message) && /65 characters/.test(error.message),
  );
  assert.equal(parseConfig({ ...valid, machine: 'm'.repeat(64) }).machine, 'm'.repeat(64));
  assert.throws(
    () => parseConfig({ ...valid, lanes: { ['l'.repeat(65)]: { skills: ['x'] } } }),
    (error) => error instanceof ConfigError && /1 to 64 characters/.test(error.message),
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

test('a missing config.json is the defaults only when the command allows it; any other problem is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'));
  try {
    const path = join(dir, 'config.json');
    assert.throws(() => loadConfig(path), /config file missing: .*run "board init"/);
    assert.deepEqual(loadConfig(path, { optionalConfig: true }).lanes, [{ name: 'general', skills: ['*'], slots: 3 }]);
    writeFileSync(path, '{ nope');
    assert.throws(() => loadConfig(path, { optionalConfig: true }), /not valid JSON/);
    writeFileSync(path, '{"lanes": 3}');
    assert.throws(() => loadConfig(path, { optionalConfig: true }), ConfigError);
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => loadConfig(path, { optionalConfig: true }), /cannot read the config file .* \(EISDIR\)/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a machine name is 1 to 64 characters, and a longer one says what the rule is and how long it was', () => {
  assert.equal(parseConfig({ machine: 'm'.repeat(64) }).machine, 'm'.repeat(64));
  assert.throws(
    () => parseConfig({ machine: 'm'.repeat(65) }),
    /machine must be a name of 1 to 64 characters: .*\(65 characters\)/,
  );
});

test('autoUpdate defaults to incompatible, takes the three modes and refuses anything else', () => {
  assert.equal(parseConfig(valid).autoUpdate, 'incompatible');
  for (const mode of ['incompatible', 'always', 'never'])
    assert.equal(parseConfig({ ...valid, autoUpdate: mode }).autoUpdate, mode);
  for (const bad of ['sometimes', true, null, 1])
    assert.throws(
      () => parseConfig({ ...valid, autoUpdate: bad }),
      /config: autoUpdate must be one of incompatible, always, never/,
    );
});

const EMPTY = { allowedTools: [], disallowedTools: [], env: [], mcpServers: [] };

test('a skills block is read per skill, keys are normalised like lanes, and cwd expands ~', () => {
  const config = parseConfig({
    ...valid,
    skills: {
      'pr-review:review-pr': { allowedTools: ['Read'], env: ['TOKEN'], mcpServers: ['shortcut'], cwd: '~/w' },
      '/grill': {},
    },
  });
  assert.deepEqual(Object.keys(config.skills), ['review-pr', 'grill']);
  assert.deepEqual(config.skills['grill'], EMPTY);
  const review = config.skills['review-pr'];
  assert.deepEqual(
    [review?.allowedTools, review?.disallowedTools, review?.env, review?.mcpServers],
    [['Read'], [], ['TOKEN'], ['shortcut']],
  );
  assert.ok(review?.cwd?.startsWith('/') && review.cwd.endsWith('/w') && !review.cwd.includes('~'));
});

test('a skills block that is wrong is refused, and a mistyped key never fails open', () => {
  const cases: [unknown, RegExp][] = [
    ['x', /skills must be an object/],
    [{ 'review-pr': [] }, /skills.review-pr must be an object/],
    [
      { 'review-pr': { disallowedTool: ['Bash(git push *)'] } },
      /skills.review-pr has the unknown key "disallowedTool"/,
    ],
    [{ 'review-pr': { allowedTools: 'Read' } }, /skills.review-pr.allowedTools must be a list of strings/],
    [{ 'review-pr': { mcpServers: [1] } }, /skills.review-pr.mcpServers must be a list of strings/],
    [{ 'review-pr': { env: ['A-B'] } }, /skills.review-pr.env names "A-B"/],
    [{ 'review-pr': { cwd: 'relative' } }, /skills.review-pr.cwd must be an absolute path/],
    [{ 'review-pr': { cwd: 3 } }, /skills.review-pr.cwd must be an absolute path/],
    [{ 'bad name': {} }, /skills key "bad name" is not a skill name/],
    [{ 'plugin:': {} }, /skills key "plugin:" is not a skill name/],
    [{ 'plugin:_x': {} }, /skills key "plugin:_x" is not a skill name/],
    [
      { 'review-pr': {}, 'pr-review:review-pr': {} },
      /skills.review-pr and skills.pr-review:review-pr are the same skill \("review-pr"\)/,
    ],
  ];
  for (const [skills, message] of cases)
    assert.throws(
      () => parseConfig({ ...valid, skills }),
      (error) => error instanceof ConfigError && message.test(error.message),
      message.source,
    );
});

test("the intake block's tool lists become the profile of the intake prompt's skill", () => {
  const config = parseConfig({
    ...valid,
    intake: {
      prompt: '/pr-review:review-pr {url}',
      allowedTools: ['Read'],
      disallowedTools: ['Bash(git push *)'],
      env: ['TOKEN'],
      mcpServers: ['shortcut'],
    },
  });
  assert.deepEqual(config.skills, {
    'review-pr': {
      allowedTools: ['Read'],
      disallowedTools: ['Bash(git push *)'],
      env: ['TOKEN'],
      mcpServers: ['shortcut'],
    },
  });
  assert.equal(config.intakeEnabled, true);
  assert.deepEqual(config.intake, { prompt: '/pr-review:review-pr {url}', priority: 'normal' });
  assert.throws(
    () => parseConfig({ ...valid, intake: { allowedTools: 'Read' } }),
    (error) => error instanceof ConfigError && /intake.allowedTools must be a list of strings/.test(error.message),
  );
});

test('an intake block without lists adds no profile, and a skills profile of the same skill stands alone', () => {
  const profile = { allowedTools: ['Read'] };
  const config = parseConfig({ ...valid, intake: { priority: 'high' }, skills: { 'review-pr': profile } });
  assert.deepEqual(config.skills, { 'review-pr': { ...EMPTY, allowedTools: ['Read'] } });
  assert.deepEqual(parseConfig({ ...valid, intake: {} }).skills, {});
});

test('intake lists and a skills profile for the same skill conflict', () => {
  assert.throws(
    () => parseConfig({ ...valid, intake: { allowedTools: ['Read'] }, skills: { 'pr-review:review-pr': {} } }),
    (error) =>
      error instanceof ConfigError &&
      /intake lists and skills.pr-review:review-pr both set the rules of "review-pr"/.test(error.message),
  );
  assert.doesNotThrow(() => parseConfig({ ...valid, intake: { allowedTools: ['Read'] }, skills: { other: {} } }));
});

test('intake lists under a prompt without a skill are refused instead of dropped', () => {
  assert.throws(
    () => parseConfig({ ...valid, intake: { prompt: 'review {url}', allowedTools: ['Read'] } }),
    (error) => error instanceof ConfigError && /intake.prompt must start with a \/skill/.test(error.message),
  );
  assert.doesNotThrow(() => parseConfig({ ...valid, intake: { prompt: 'review {url}' } }));
});

test('dirs is undefined without the key, and an empty object is a list that allows nothing', () => {
  assert.equal(parseConfig(valid).dirs, undefined);
  assert.equal('dirs' in parseConfig(valid), false);
  assert.deepEqual(parseConfig({ ...valid, dirs: {} }).dirs, []);
});

test('dirs keys are expanded and normalised, in config order', () => {
  const config = parseConfig({ ...valid, dirs: { '~/work': {}, '/srv/a/': {}, '/srv/b/../c': {} } });
  assert.deepEqual(config.dirs, [{ path: `${homedir()}/work` }, { path: '/srv/a' }, { path: '/srv/c' }]);
});

test('a bad dirs entry is refused with a pointed message', () => {
  const cases: [unknown, RegExp][] = [
    [[], /dirs must be an object/],
    ['/srv', /dirs must be an object/],
    [{ '/srv': true }, /dirs\["\/srv"\] must be an object/],
    [{ '/srv': [] }, /must be an object/],
    [{ '/srv': null }, /must be an object/],
    [{ relative: {} }, /absolute path/],
    [{ '/a\nb': {} }, /absolute path/],
    [{ ['/' + 'x'.repeat(4100)]: {} }, /absolute path/],
    [{ '/srv': { mode: 'rw' } }, /no setting "mode"/],
    [{ '/srv': {}, '/srv/': {} }, /the same directory/],
    [{ [`${homedir()}/w`]: {}, '~/w': {} }, /the same directory/],
  ];
  for (const [dirs, message] of cases)
    assert.throws(
      () => parseConfig({ ...valid, dirs }),
      (error) => error instanceof ConfigError && message.test(error.message),
      JSON.stringify(dirs).slice(0, 60),
    );
});

test('dirs holds at most 200 entries', () => {
  const dirs = (count: number): Record<string, object> =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`/srv/d${index}`, {}]));
  assert.equal(parseConfig({ ...valid, dirs: dirs(200) }).dirs?.length, 200);
  assert.throws(() => parseConfig({ ...valid, dirs: dirs(201) }), /more than 200/);
});

test('a misspelt key at any level is a warning naming the nearest known key, not an error', () => {
  const raw = {
    ...valid,
    inactivityMinuts: 60,
    lane: { reviews: { skills: ['review-pr'] } },
    lanes: { reviews: { skills: ['review-pr'], slot: 2 } },
    intake: { allowedTool: ['Read'] },
  };
  assert.doesNotThrow(() => parseConfig(raw));
  assert.deepEqual(configWarnings(raw), [
    'unknown key "inactivityMinuts", ignored; did you mean "inactivityMinutes"?',
    'unknown key "lane", ignored; did you mean "lanes"?',
    'unknown key "lanes.reviews.slot", ignored; did you mean "lanes.reviews.slots"?',
    'unknown key "intake.allowedTool", ignored; did you mean "intake.allowedTools"?',
  ]);
});

test('an unknown key close to no known one lists the keys of its level', () => {
  assert.deepEqual(configWarnings({ backend: { command: ['/x'] } }), [
    'unknown key "backend", ignored; known here: machine, lanes, defaultCwd, pauseAfterMinutes, inactivityMinutes, maxRunHours, autoUpdate, intake, skills, repos, dirs',
  ]);
});

test('a config with only known keys, or no object at all, has no warnings', () => {
  assert.deepEqual(configWarnings(valid), []);
  assert.deepEqual(configWarnings({ dirs: { '/srv/a': {} } }), []);
  assert.deepEqual(configWarnings({ lanes: { a: { skills: ['*'], slots: 2, cwd: '~' } }, intake: { env: ['X'] } }), []);
  for (const raw of [undefined, null, [], 'x']) assert.deepEqual(configWarnings(raw), []);
});

test('loadConfigWarnings reads the file and is quiet when it is missing or broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-warn-'));
  try {
    const path = join(dir, 'config.json');
    assert.deepEqual(loadConfigWarnings(path), []);
    writeFileSync(path, '{ nope');
    assert.deepEqual(loadConfigWarnings(path), []);
    writeFileSync(path, '{"maxRunHour": 2}');
    assert.deepEqual(loadConfigWarnings(path), ['unknown key "maxRunHour", ignored; did you mean "maxRunHours"?']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
