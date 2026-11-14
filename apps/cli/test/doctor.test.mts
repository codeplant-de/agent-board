import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeDataKey } from '@agent-board/shared';
import { DATA_KEY, KEYS, OWNER } from './helpers.mts';
import { BackendError } from '../src/backend.mts';
import { formatResult, hasFailure, runChecks } from '../src/doctor.mts';
import type { CheckResult, DoctorDeps } from '../src/doctor.mts';
import { renderUnits } from '../src/setup.mts';

const CONFIG_DIR = '/home/me/.config/agent-board';
const UNIT_DIR = '/home/me/.config/systemd/user';
const TOKEN = 'abm_secretsecretsecret';
const KEY_TEXT = encodeDataKey(DATA_KEY);

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
    whichInUnits: (program) => `/usr/bin/${program}`,
    home: '/home/me',
    systemctl: async () => 0,
    verifyServer: async () => ({ owner: OWNER, keyId: KEYS.keyId }),
    ...overrides,
  };
}

const GOOD = {
  [`${CONFIG_DIR}/web.json`]: { text: '{"url": "https://board.example.com"}' },
  [`${CONFIG_DIR}/env`]: { text: `AGENT_BOARD_TOKEN=${TOKEN}\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`, mode: 0o100600 },
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
  const results = await runChecks(machine(boardOnly, { which: () => undefined, whichInUnits: () => undefined }));
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
  const unauthorised = await run(new BackendError('version: bad token', 401, true));
  assert.match(unauthorised?.message ?? '', /refused the token/);
  const serverOlder = await run(
    Object.assign(new BackendError('the board server is older than this CLI: it speaks contract 4, the CLI needs 7'), {
      contractMismatch: 'server-older' as const,
    }),
  );
  assert.match(serverOlder?.hint ?? '', /update the board server/);
  const cliOlder = await run(
    Object.assign(new BackendError('this CLI is older than the board server: it speaks contract 7, the server has 8'), {
      contractMismatch: 'cli-older' as const,
    }),
  );
  assert.match(cliOlder?.hint ?? '', /update this CLI: "board self-update"/);
  // Words the server wrote must not pick the hint.
  const quoted = await run(
    new BackendError(
      'get-task: error from the board server (HTTP 500): "this CLI is older than the board server"',
      500,
      true,
    ),
  );
  assert.match(quoted?.hint ?? '', /check the URL/);
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
        whichInUnits: (program) => (program === 'gh' ? undefined : `/usr/bin/${program}`),
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

test('a 401 or 404 that is not the API answering (a login proxy) is not "refused" or "older"', async () => {
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
  const proxy401 = await run(
    new BackendError('version: the server answered 401 without JSON (is /api/machine routed past the login?)', 401),
  );
  assert.doesNotMatch(proxy401?.message ?? '', /refused the token/);
  assert.match(proxy401?.message ?? '', /without JSON/);
  const proxy404 = await run(
    new BackendError('version: the server answered 404 without JSON (is /api/machine routed past the login?)', 404),
  );
  assert.match(proxy404?.message ?? '', /without JSON/);
  assert.match(proxy404?.hint ?? '', /check the URL/);
});

// The unit file of the checkout that shipped before `board setup` (apps/cli/systemd/agent-board-dispatch.service at 6e89da6^).
const OLD_UNIT = `[Unit]
Description=agent-board dispatcher: one tick

[Service]
Type=oneshot
# bin/_node finds Node; PATH is for flock, gh, claude and systemd-run.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# bin/dispatch takes the lock itself; exit 75 means another tick holds it, which is not a failure.
ExecStart=%h/workspace/agent-board/apps/cli/bin/dispatch
SuccessExitStatus=75
TimeoutStartSec=110
`;

test('an old-style unit whose %h path no longer exists fails, and passes while the checkout is there', async () => {
  const oldUnits = {
    [`${UNIT_DIR}/agent-board-dispatch.service`]: { text: OLD_UNIT },
    [`${UNIT_DIR}/agent-board-dispatch.timer`]: { text: '[Timer]\n' },
  };
  const gone = await runChecks(machine({ ...GOOD, ...oldUnits }));
  const failed = gone.find((result) => result.name === 'agent-board-dispatch.service command');
  assert.equal(failed?.level, 'fail');
  assert.match(failed?.message ?? '', /\/home\/me\/workspace\/agent-board\/apps\/cli\/bin\/dispatch no longer exists/);
  const present = new Set([
    ...Object.keys(GOOD),
    ...Object.keys(oldUnits),
    CONFIG_DIR,
    UNIT_DIR,
    '/home/me/workspace/agent-board/apps/cli/bin/dispatch',
  ]);
  const there = await runChecks(machine({ ...GOOD, ...oldUnits }, { exists: (path) => present.has(path) }));
  assert.equal(levels(there)['agent-board-dispatch.service command'], 'ok');
});

test('a tool on the shell PATH but not on the units PATH is a failure that says where it is', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  const results = await runChecks(
    machine(
      { ...GOOD, ...units },
      {
        which: (program) => (program === 'claude' ? '/home/me/.nvm/bin/claude' : `/usr/bin/${program}`),
        whichInUnits: (program) => (program === 'claude' ? undefined : `/usr/bin/${program}`),
      },
    ),
  );
  const claude = results.find((result) => result.name === 'tool claude');
  assert.equal(claude?.level, 'fail');
  assert.match(
    claude?.message ?? '',
    /\/home\/me\/\.nvm\/bin\/claude, on your shell's PATH but not on the units' \(\/home\/me\/\.local\/bin:/,
  );
  assert.match(claude?.hint ?? '', /ln -s \/home\/me\/\.nvm\/bin\/claude ~\/\.local\/bin\/claude/);
});

const envWith = (text: string) => ({ [`${CONFIG_DIR}/env`]: { text, mode: 0o100600 } });

test('the data key must be set and well-formed, and is never printed', async () => {
  const missing = await runChecks(machine({ ...GOOD, ...envWith(`AGENT_BOARD_TOKEN=${TOKEN}\n`) }));
  const missingKey = missing.find((result) => result.name === 'data key');
  assert.equal(missingKey?.level, 'fail');
  assert.match(missingKey?.hint ?? '', /Settings page.*board init/);
  assert.equal(
    missing.some((result) => result.name === 'board key'),
    false,
    'no key to compare',
  );
  const damaged = `${KEY_TEXT}-damaged`;
  const malformed = await runChecks(
    machine({ ...GOOD, ...envWith(`AGENT_BOARD_TOKEN=${TOKEN}\nAGENT_BOARD_DATA_KEY=${damaged}\n`) }),
  );
  assert.equal(malformed.find((result) => result.name === 'data key')?.level, 'fail');
  const printed = [...missing, ...malformed, ...(await runChecks(machine(GOOD)))].map(formatResult).join('\n');
  assert.ok(!printed.includes(KEY_TEXT) && !printed.includes(damaged));
});

test('the board has a key and this machine holds the same one, or the check fails with the way out', async () => {
  const ok = await runChecks(machine(GOOD));
  assert.equal(ok.find((result) => result.name === 'board key')?.level, 'ok');
  assert.match(ok.find((result) => result.name === 'board key')?.message ?? '', new RegExp(`id ${KEYS.keyId}`));

  const noKey = await runChecks(machine(GOOD, { verifyServer: async () => ({ owner: OWNER, keyId: null }) }));
  const board = noKey.find((result) => result.name === 'board key');
  assert.equal(board?.level, 'fail');
  assert.match(board?.hint ?? '', /set up encryption in the browser first/);

  const other = '0123456789abcdef';
  const different = await runChecks(machine(GOOD, { verifyServer: async () => ({ owner: OWNER, keyId: other }) }));
  const mismatch = different.find((result) => result.name === 'board key');
  assert.equal(mismatch?.level, 'fail');
  assert.match(
    mismatch?.message ?? '',
    new RegExp(`different data key \\(id ${KEYS.keyId}\\) than the board's \\(id ${other}\\)`),
  );
  assert.match(mismatch?.hint ?? '', /copy the current key from the board's Settings page/);
  assert.ok(!formatResult(mismatch as CheckResult).includes(KEY_TEXT));
  assert.ok(hasFailure(different));
});

test('a board with no key yet says so even when env has no key either, and the hints fit each case', async () => {
  const results = await runChecks(
    machine(
      { ...GOOD, ...envWith(`AGENT_BOARD_TOKEN=${TOKEN}\n`) },
      { verifyServer: async () => ({ owner: OWNER, keyId: null }) },
    ),
  );
  const board = results.find((result) => result.name === 'board key');
  assert.equal(board?.level, 'fail');
  assert.match(board?.hint ?? '', /set up encryption in the browser first/);
  assert.match(results.find((result) => result.name === 'data key')?.hint ?? '', /asks for the key only/);
  const noToken = await runChecks(machine({ ...GOOD, ...envWith(`AGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`) }));
  assert.match(noToken.find((result) => result.name === 'token')?.hint ?? '', /asks for the token only/);
  const other = await runChecks(
    machine(GOOD, { verifyServer: async () => ({ owner: OWNER, keyId: '0123456789abcdef' }) }),
  );
  assert.match(
    other.find((result) => result.name === 'board key')?.hint ?? '',
    /board init --force": it keeps the URL and the token/,
  );
});
