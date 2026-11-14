import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError } from '../src/backend.mts';
import { formatResult, hasFailure, runChecks } from '../src/doctor.mts';
import type { CheckResult, DoctorDeps } from '../src/doctor.mts';
import { renderUnits } from '../src/setup.mts';

const CONFIG_DIR = '/home/me/.config/agent-board';
const UNIT_DIR = '/home/me/.config/systemd/user';
const TOKEN = 'abm_secretsecretsecret';

function machine(
  files: Record<string, { text: string; mode?: number }>,
  overrides: Partial<DoctorDeps> = {},
): DoctorDeps {
  const dirs = new Set([CONFIG_DIR, UNIT_DIR]);
  const present = new Set([...Object.keys(files), ...dirs]);
  return {
    configDir: CONFIG_DIR,
    unitDir: UNIT_DIR,
    nodeVersion: '24.1.0',
    readText: (path) => files[path]?.text,
    mode: (path) => (path in files ? (files[path]?.mode ?? 0o644) : undefined),
    exists: (path) => present.has(path),
    isDirectory: (path) => dirs.has(path),
    which: (program) => `/usr/bin/${program}`,
    systemctl: async () => 0,
    verifyServer: async () => undefined,
    ...overrides,
  };
}

const GOOD = {
  [`${CONFIG_DIR}/web.json`]: { text: '{"url": "https://board.example.com"}' },
  [`${CONFIG_DIR}/env`]: { text: `AGENT_BOARD_TOKEN=${TOKEN}\n`, mode: 0o100600 },
  [`${CONFIG_DIR}/config.json`]: { text: '{"machine": "box"}' },
};

const levels = (results: CheckResult[]): Record<string, string> =>
  Object.fromEntries(results.map((result) => [result.name, result.level]));

function unitFiles(command: string[]): Record<string, { text: string }> {
  return Object.fromEntries(
    renderUnits({ flock: '/usr/bin/flock', command: () => command }).map((unit) => [
      `${UNIT_DIR}/${unit.file}`,
      { text: unit.text },
    ]),
  );
}

test('a worker machine in order passes every check', async () => {
  const results = await runChecks(
    machine(
      { ...GOOD, ...unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']) },
      {
        exists: () => true,
      },
    ),
  );
  assert.ok(
    results.every((result) => result.level === 'ok'),
    results
      .filter((r) => r.level !== 'ok')
      .map(formatResult)
      .join('\n'),
  );
  assert.equal(hasFailure(results), false);
});

test('a board-only machine has warnings, not failures, for config.json, tools and units', async () => {
  const { [`${CONFIG_DIR}/config.json`]: _config, ...boardOnly } = GOOD;
  const results = await runChecks(machine(boardOnly, { which: () => undefined }));
  const found = levels(results);
  assert.equal(found['config.json'], 'warn');
  assert.equal(found['tool claude'], 'warn');
  assert.equal(found['units'], 'warn');
  assert.equal(hasFailure(results), false);
});

test('nothing set up fails with a hint for each missing piece', async () => {
  const results = await runChecks({ ...machine({}), isDirectory: () => false });
  const found = levels(results);
  assert.equal(found['config dir'], 'fail');
  assert.equal(found['web.json'], 'fail');
  assert.equal(found['env'], 'fail');
  assert.ok(results.filter((result) => result.level === 'fail').every((result) => result.hint?.includes('board init')));
  assert.equal(
    results.some((result) => result.name === 'server'),
    false,
    'no server check without credentials',
  );
});

test('the env file must be mode 600 or 400, and the token is never printed', async () => {
  const wide = await runChecks(
    machine({ ...GOOD, [`${CONFIG_DIR}/env`]: { text: `AGENT_BOARD_TOKEN=${TOKEN}`, mode: 0o100644 } }),
  );
  assert.equal(levels(wide)['env mode'], 'fail');
  assert.ok(wide.find((result) => result.name === 'env mode')?.hint?.startsWith('chmod 600'));
  const noToken = await runChecks(machine({ ...GOOD, [`${CONFIG_DIR}/env`]: { text: 'OTHER=1\n', mode: 0o100600 } }));
  assert.equal(levels(noToken)['token'], 'fail');
  const all = [...wide, ...(await runChecks(machine(GOOD)))].map(formatResult).join('\n');
  assert.ok(!all.includes(TOKEN));
});

test('the server check tells unreachable, unauthorised and a contract mismatch apart', async () => {
  const run = async (error: Error): Promise<CheckResult | undefined> =>
    (
      await runChecks(
        machine(GOOD, {
          verifyServer: async () => {
            throw error;
          },
        }),
      )
    ).find((result) => result.name === 'server');
  const unauthorised = await run(new BackendError('version: bad token', 401));
  assert.match(unauthorised?.message ?? '', /refused the token/);
  const older = await run(
    new BackendError(
      'the board server is older than this CLI: it speaks contract 4, the CLI needs 5; update the board',
    ),
  );
  assert.match(older?.hint ?? '', /update the older side/);
  const unreachable = await run(new BackendError('cannot reach https://board.example.com: fetch failed'));
  assert.match(unreachable?.hint ?? '', /check the URL/);
  assert.equal(levels(await runChecks(machine(GOOD)))['server'], 'ok');
});

test('a config.json that does not parse is a failure, a missing Node 24 too', async () => {
  const broken = await runChecks(machine({ ...GOOD, [`${CONFIG_DIR}/config.json`]: { text: '{ nope' } }));
  assert.equal(levels(broken)['config.json'], 'fail');
  const old = await runChecks(machine(GOOD, { nodeVersion: '22.3.0' }));
  assert.equal(levels(old)['node'], 'fail');
  const bun = await runChecks(machine(GOOD, { nodeVersion: undefined }));
  assert.equal('node' in levels(bun), false);
});

test('with units installed a missing tool or a vanished program fails; a disabled timer only warns', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  const present = new Set([
    ...Object.keys(GOOD),
    ...Object.keys(units),
    CONFIG_DIR,
    UNIT_DIR,
    '/usr/bin/flock',
    '/usr/bin/node',
  ]);
  const results = await runChecks(
    machine(
      { ...GOOD, ...units },
      {
        exists: (path) => present.has(path),
        which: (program) => (program === 'gh' ? undefined : `/usr/bin/${program}`),
        systemctl: async (args) => (args.includes('is-enabled') ? 1 : 0),
      },
    ),
  );
  const found = levels(results);
  assert.equal(found['tool gh'], 'fail');
  assert.equal(found['agent-board-dispatch.service command'], 'fail');
  assert.match(
    results.find((result) => result.name === 'agent-board-dispatch.service command')?.message ?? '',
    /\/opt\/board\/main\.mts/,
  );
  assert.equal(found['agent-board-dispatch.timer state'], 'warn');
  assert.ok(hasFailure(results));
});

test('a missing unit file of an installed pair is a failure', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  delete units[`${UNIT_DIR}/agent-board-intake.timer`];
  const results = await runChecks(machine({ ...GOOD, ...units }));
  const missing = results.find((result) => result.name === 'unit agent-board-intake.timer');
  assert.equal(missing?.level, 'fail');
});

test('a result prints as one line with its hint under it', () => {
  assert.equal(formatResult({ name: 'x', level: 'ok', message: 'fine' }), '✓ x: fine');
  assert.equal(formatResult({ name: 'x', level: 'fail', message: 'bad', hint: 'fix it' }), '✗ x: bad\n    → fix it');
  assert.equal(formatResult({ name: 'x', level: 'warn', message: 'hm' }), '! x: hm');
});
