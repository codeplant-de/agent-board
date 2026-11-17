import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigError,
  configWarnings,
  isOverrideWarning,
  isSafeMode,
  loadConfig,
  loadConfigWarnings,
  parseConfig,
  readSecretFile,
  REMOVED_INTAKE,
} from './config.mts';

const valid = {
  repos: { 'cosuno/cosuno': '~/x' },
};

test('a valid config gets defaults', () => {
  const config = parseConfig(valid);
  assert.deepEqual(config.lanes, [{ name: 'general', skills: ['*'], slots: 3 }]);
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

test('a pipe is read whatever its mode: macOS shows 440 for the pipe behind /dev/stdin, and only a regular file is checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'));
  const fifo = join(dir, 'pipe');
  try {
    execFileSync('mkfifo', ['-m', '0666', fifo]);
    const writer = spawn('sh', ['-c', `echo piped > '${fifo}'`], { stdio: 'ignore' });
    assert.equal(readSecretFile(fifo, 'secret file'), 'piped\n');
    writer.kill();
  } finally {
    rmSync(dir, { recursive: true });
  }
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

test('a dirs entry takes label, repo, default and lane, and keeps what it is given', () => {
  const config = parseConfig({
    ...valid,
    lanes: { reviews: { skills: ['review-pr'], slots: 1 }, general: { skills: ['*'], slots: 1 } },
    dirs: {
      '/srv/a': { label: '  Board  ', repo: 'acme/board', default: true, lane: 'reviews' },
      '/srv/b': { label: 'Other' },
      '/srv/c': {},
    },
  });
  assert.deepEqual(config.dirs, [
    { path: '/srv/a', label: 'Board', repo: 'acme/board', default: true, lane: 'reviews' },
    { path: '/srv/b', label: 'Other' },
    { path: '/srv/c' },
  ]);
});

test('a dirs setting is folded into repos, defaultCwd and the lane cwd, and wins over the old key', () => {
  const lanes = {
    reviews: { skills: ['review-pr'], slots: 1, cwd: '/old/reviews' },
    general: { skills: ['*'], slots: 1 },
  };
  const config = parseConfig({
    ...valid,
    defaultCwd: '/old/default',
    repos: { 'acme/board': '/old/board', 'acme/other': '/srv/other' },
    lanes,
    dirs: { '/srv/a': { repo: 'acme/board', default: true, lane: 'reviews' } },
  });
  assert.deepEqual(config.repos, { 'acme/board': '/srv/a', 'acme/other': '/srv/other' });
  assert.equal(config.defaultCwd, '/srv/a');
  assert.deepEqual(
    config.lanes.map(({ name, cwd }) => [name, cwd]),
    [
      ['reviews', '/srv/a'],
      ['general', undefined],
    ],
  );
  const without = parseConfig({ ...valid, defaultCwd: '/old/default', lanes, dirs: { '/srv/a': { label: 'A' } } });
  assert.equal(without.defaultCwd, '/old/default');
  assert.equal(without.lanes[0]?.cwd, '/old/reviews');
});

test('a bad dirs setting is refused, pointing at the entry and the setting', () => {
  const lanes = { reviews: { skills: ['review-pr'], slots: 1 }, other: { skills: ['*'], slots: 1 } };
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ '/a': { label: '' } }, /dirs\["\/a"\]\.label must be a label of 1 to 64 characters/],
    [{ '/a': { label: '   ' } }, /\.label must be a label/],
    [{ '/a': { label: 'x'.repeat(65) } }, /\.label must be a label/],
    [{ '/a': { label: 'a\nb' } }, /\.label must be a label/],
    [{ '/a': { label: 1 } }, /\.label must be a label/],
    [{ '/a': { repo: 'board' } }, /\.repo must look like owner\/name/],
    [{ '/a': { repo: 'a/b/c' } }, /\.repo must look like owner\/name/],
    [{ '/a': { repo: 3 } }, /\.repo must look like owner\/name/],
    [{ '/a': { default: false } }, /\.default must be true \(leave the key out/],
    [{ '/a': { default: 'true' } }, /\.default must be true/],
    [{ '/a': { lane: 'nope' } }, /\.lane must name a lane of this config \(reviews, other\)/],
    [{ '/a': { lane: 4 } }, /\.lane must name a lane/],
    [{ '/a': { cwd: '/x' } }, /no setting "cwd" \(it takes label, repo, default, lane\)/],
    [{ '/a': { repo: 'o/n' }, '/b': { repo: 'o/n' } }, /both set repo "o\/n"/],
    [
      { '/a': { default: true }, '/b': { default: true } },
      /dirs\["\/a"\] and dirs\["\/b"\] are both the default directory/,
    ],
    [{ '/a': { lane: 'reviews' }, '/b': { lane: 'reviews' } }, /both set lane "reviews"/],
  ];
  for (const [dirs, message] of cases)
    assert.throws(
      () => parseConfig({ ...valid, lanes, dirs }),
      (error) => error instanceof ConfigError && message.test(error.message),
      JSON.stringify(dirs),
    );
  assert.doesNotThrow(() =>
    parseConfig({ ...valid, lanes, dirs: { '/a': { lane: 'reviews' }, '/b': { lane: 'other' } } }),
  );
});

test('a dirs setting over a different old path is a warning; the same path is none', () => {
  const raw = {
    repos: { 'acme/board': '/old/board', 'acme/same': '~/same' },
    defaultCwd: '/old/default',
    lanes: { reviews: { skills: ['review-pr'], cwd: '/old/reviews' }, deep: { skills: ['x'], cwd: '/srv/lane' } },
    dirs: {
      '/srv/a': { repo: 'acme/board', default: true, lane: 'reviews' },
      [`${homedir()}/same`]: { repo: 'acme/same' },
      '/srv/lane': { lane: 'deep' },
    },
  };
  assert.deepEqual(configWarnings(raw), [
    'repos.acme/board is overridden by dirs["/srv/a"].repo',
    'defaultCwd is overridden by dirs["/srv/a"].default',
    'lanes.reviews.cwd is overridden by dirs["/srv/a"].lane',
  ]);
  assert.deepEqual(
    configWarnings({ ...raw, repos: {}, defaultCwd: undefined, lanes: { reviews: { skills: ['x'] } } }),
    [],
  );
  assert.equal(isOverrideWarning('repos.a/b is overridden by dirs["/x"].repo'), true);
  assert.equal(isOverrideWarning('unknown key "x", ignored'), false);
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
  };
  assert.doesNotThrow(() => parseConfig(raw));
  assert.deepEqual(configWarnings(raw), [
    'unknown key "inactivityMinuts", ignored; did you mean "inactivityMinutes"?',
    'unknown key "lane", ignored; did you mean "lanes"?',
    'unknown key "lanes.reviews.slot", ignored; did you mean "lanes.reviews.slots"?',
  ]);
});

test('an unknown key close to no known one lists the keys of its level', () => {
  assert.deepEqual(configWarnings({ backend: { command: ['/x'] } }), [
    'unknown key "backend", ignored; known here: machine, lanes, defaultCwd, pauseAfterMinutes, inactivityMinutes, maxRunHours, autoUpdate, agents, repos, dirs, usageLimits',
  ]);
});

test('a config with only known keys, or no object at all, has no warnings', () => {
  assert.deepEqual(configWarnings(valid), []);
  assert.deepEqual(configWarnings({ dirs: { '/srv/a': {} } }), []);
  assert.deepEqual(configWarnings({ lanes: { a: { skills: ['*'], slots: 2, cwd: '~' } } }), []);
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

const REVIEWER = {
  description: 'Reviews a PR.',
  prompt: 'You review.',
  tools: ['Read', 'Bash'],
  allowedTools: ['Bash(gh pr view *)'],
  disallowedTools: ['Bash(git push *)'],
  mcpServers: ['shortcut'],
  env: ['CIRCLECI_TOKEN'],
  model: 'opus',
};

test('a config without agents has none', () => {
  assert.deepEqual(parseConfig({}).agents, {});
});

test('an agent is read with every key it takes', () => {
  assert.deepEqual(parseConfig({ agents: { reviewer: REVIEWER } }).agents, { reviewer: REVIEWER });
});

test('an agent needs only a description and tools, and the rest is empty', () => {
  assert.deepEqual(parseConfig({ agents: { 'a-1': { description: 'd', tools: ['Read'] } } }).agents, {
    'a-1': { description: 'd', tools: ['Read'], allowedTools: [], disallowedTools: [], env: [], mcpServers: [] },
  });
});

// What parseConfig says about the agents it could not read.
const failing = (make: () => ReturnType<typeof parseConfig>, expected: RegExp, message?: string): void =>
  assert.match(Object.values(make().agentErrors).join('\n'), expected, message);

test('one agent that cannot be read does not stop the config: the others and the rest load, and the reason is kept by name', () => {
  const config = parseConfig({
    repos: { 'a/b': '/x' },
    agents: { good: REVIEWER, broken: { ...REVIEWER, disallowedTool: [] }, Bad: REVIEWER },
  });
  assert.deepEqual(Object.keys(config.agents), ['good']);
  assert.deepEqual(Object.keys(config.agentErrors), ['broken', 'Bad']);
  assert.match(config.agentErrors['broken'] ?? '', /agents\.broken has no key "disallowedTool"/);
  assert.deepEqual(Object.keys(config.repos), ['a/b']);
  assert.throws(() => parseConfig({ agents: { a: REVIEWER }, defaultCwd: 'rel' }), /defaultCwd/);
});

test('agents is an object of objects named by lowercase names of at most 32 characters', () => {
  const agent = { description: 'd', tools: ['Read'] };
  for (const bad of [[], 'x', null]) assert.throws(() => parseConfig({ agents: bad }), /agents must be an object/);
  for (const name of ['Reviewer', '-a', 'a_b', 'a b', '', 'a'.repeat(33), 'ü'])
    failing(() => parseConfig({ agents: { [name]: agent } }), /agent name .* must be lowercase letters/, name);
  assert.deepEqual(
    parseConfig({ agents: { ['a'.repeat(32)]: agent, '0': agent, constructor: agent } }).agentErrors,
    {},
  );
  failing(() => parseConfig({ agents: { a: 'x' } }), /agents\.a must be an object/);
});

test('an unknown key in an agent is an error, with the nearest known key', () => {
  failing(
    () => parseConfig({ agents: { a: { ...REVIEWER, disallowedTool: ['Bash(rm *)'] } } }),
    /agents\.a has no key "disallowedTool"; did you mean "disallowedTools"\?/,
  );
  failing(
    () => parseConfig({ agents: { a: { ...REVIEWER, zzzzzzzz: 1 } } }),
    /no key "zzzzzzzz"; it takes description/,
  );
});

test('an agent needs a description and a non-empty tools list of plain tool names', () => {
  const { description: _d, ...noDescription } = REVIEWER;
  const { tools: _t, ...noTools } = REVIEWER;
  failing(() => parseConfig({ agents: { a: noDescription } }), /agents\.a\.description must be a non-empty string/);
  failing(() => parseConfig({ agents: { a: { ...REVIEWER, description: ' ' } } }), /description/);
  failing(() => parseConfig({ agents: { a: noTools } }), /agents\.a\.tools must be a non-empty list of tool names/);
  failing(() => parseConfig({ agents: { a: { ...REVIEWER, tools: [] } } }), /non-empty list of tool names/);
  failing(() => parseConfig({ agents: { a: { ...REVIEWER, tools: ['Read', 5] } } }), /tools must be a list of strings/);
  failing(
    () => parseConfig({ agents: { a: { ...REVIEWER, tools: ['Bash(git status)'] } } }),
    /tools names "Bash\(git status\)", which is not a tool name; rules with arguments belong in allowedTools/,
  );
  failing(() => parseConfig({ agents: { a: { ...REVIEWER, tools: ['-x'] } } }), /not a tool name/);
  assert.deepEqual(
    parseConfig({ agents: { a: { ...REVIEWER, tools: ['mcp__shortcut__get_story', 'Edit'] } } }).agentErrors,
    {},
  );
});

test("an agent's other keys are type-checked", () => {
  const bad = (override: Record<string, unknown>) => parseConfig({ agents: { a: { ...REVIEWER, ...override } } });
  failing(() => bad({ prompt: 3 }), /agents\.a\.prompt must be a string/);
  failing(() => bad({ model: 'bad model!' }), /agents\.a\.model must be a model name/);
  failing(() => bad({ model: 3 }), /model name/);
  failing(() => bad({ allowedTools: 'Bash' }), /agents\.a\.allowedTools must be a list of strings/);
  failing(() => bad({ disallowedTools: [1] }), /agents\.a\.disallowedTools must be a list of strings/);
  failing(() => bad({ allowedTools: ['--debug'] }), /take tool rules, not "--debug"/);
  failing(() => bad({ disallowedTools: [' '] }), /take tool rules/);
  failing(() => bad({ mcpServers: 'shortcut' }), /agents\.a\.mcpServers must be a list of strings/);
  failing(() => bad({ mcpServers: [''] }), /mcpServers must name servers/);
  failing(() => bad({ env: ['1BAD'] }), /agents\.a\.env names "1BAD", which is not a variable name/);
  failing(() => bad({ env: 'X' }), /agents\.a\.env must be a list of strings/);
});

test('agents is a known top-level key, so it draws no warning', () => {
  assert.deepEqual(configWarnings({ agents: {} }), []);
});

test('an intake key is ignored with a warning that names the replacement, whatever it holds', () => {
  for (const intake of [{}, { agent: 'reviewer', prompt: 'no url' }, { priority: 'asap' }, 'nope']) {
    const raw = { ...valid, intake };
    assert.doesNotThrow(() => parseConfig(raw), 'a config error would stop dispatch on a machine that has the old key');
    assert.deepEqual(configWarnings(raw), [REMOVED_INTAKE]);
  }
  assert.match(REMOVED_INTAKE, /board example github-reviews.*agents\.<name>/);
  assert.equal('intake' in parseConfig({ ...valid, intake: {} }), false);
});

const limited = (usageLimits: unknown) => parseConfig({ ...valid, usageLimits });

test('usageLimits is absent by default, and a limit without a priority holds all but urgent', () => {
  assert.equal(parseConfig(valid).usageLimits, undefined);
  assert.equal('usageLimits' in parseConfig(valid), false);
  assert.deepEqual(limited({ fiveHour: 80 }).usageLimits, { fiveHour: 80, priority: 'urgent' });
  assert.deepEqual(limited({}).usageLimits, { priority: 'urgent' });
  assert.deepEqual(limited({ fiveHour: 1, sevenDay: 100, priority: 'normal' }).usageLimits, {
    fiveHour: 1,
    sevenDay: 100,
    priority: 'normal',
  });
});

test('usageLimits refuses wrong types and ranges, and says why low is refused', () => {
  for (const [input, message] of [
    ['80', /usageLimits must be an object/],
    [{ fiveHour: 0 }, /usageLimits.fiveHour must be a whole percent from 1 to 100/],
    [{ fiveHour: 101 }, /usageLimits.fiveHour/],
    [{ sevenDay: 80.5 }, /usageLimits.sevenDay/],
    [{ sevenDay: '80' }, /usageLimits.sevenDay/],
    [{ priority: 'low' }, /priority must not be low.*nothing would be held/],
    [{ priority: 'soon' }, /priority must be one of urgent, high, normal/],
    [{ priority: 3 }, /priority must be one of/],
  ] as const) {
    assert.throws(
      () => limited(input),
      (error) => error instanceof ConfigError && message.test(error.message),
      JSON.stringify(input),
    );
  }
});

test('an unknown key inside usageLimits is a warning, and usageLimits itself is known', () => {
  assert.deepEqual(configWarnings({ ...valid, usageLimits: { fiveHour: 80 } }), []);
  const warnings = configWarnings({ ...valid, usageLimits: { fivehour: 80 } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /usageLimits\.fivehour.*fiveHour/);
});
