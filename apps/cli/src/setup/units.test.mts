import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReportedFailure, UsageError } from '../cli.mts';
import { runBoard } from '../commands/program.mts';
import type { ProgramOptions } from '../commands/program-shared.mts';
import { restartUnits, showLogs } from './units.mts';
import type { LogsDeps, RestartDeps } from './units.mts';

const TASK = 'Zt0Test1';

interface Fixture {
  dir: string;
  unitDir: string;
  logDir: string;
  printed: string[];
  calls: string[];
  restartDeps: (overrides?: Partial<RestartDeps>) => RestartDeps;
  logsDeps: (overrides?: Partial<LogsDeps>) => LogsDeps;
}

function fixture(files: { units?: string[]; logs?: string[] } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'board-units-'));
  const unitDir = join(dir, 'units');
  const logDir = join(dir, 'logs');
  mkdirSync(unitDir);
  mkdirSync(logDir);
  for (const name of files.units ?? []) writeFileSync(join(unitDir, name), '');
  for (const name of files.logs ?? []) writeFileSync(join(logDir, name), '');
  const printed: string[] = [];
  const calls: string[] = [];
  return {
    dir,
    unitDir,
    logDir,
    printed,
    calls,
    restartDeps: (overrides) => ({
      unitDir,
      launchd: {
        home: dir,
        agentsDir: join(dir, 'LaunchAgents'),
        logDir,
        runDir: join(dir, 'run'),
        uid: 501,
        env: {},
        loaded: async () => true,
      },
      platform: 'linux',
      run: async (program, args) => void calls.push([program, ...args].join(' ')),
      print: (line) => printed.push(line),
      ...overrides,
    }),
    logsDeps: (overrides) => ({
      platform: 'linux',
      logDir,
      run: async (argv) => {
        calls.push(argv.join(' '));
        return 0;
      },
      ...overrides,
    }),
  };
}

const ALL_UNITS = [
  'agent-board-dispatch.service',
  'agent-board-dispatch.timer',
  'agent-board-listen.service',
  'agent-board-watch.service',
];

test('restart without names restarts the timer and both services, not the oneshot service', async () => {
  const { dir, printed, calls, restartDeps } = fixture({ units: ALL_UNITS });
  try {
    await restartUnits(restartDeps(), []);
    assert.deepEqual(calls, [
      'systemctl --user restart agent-board-dispatch.timer',
      'systemctl --user restart agent-board-listen.service',
      'systemctl --user restart agent-board-watch.service',
    ]);
    assert.equal(printed.length, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('restart skips what is not installed, with the hint, and fails when nothing was restarted', async () => {
  const { dir, printed, calls, restartDeps } = fixture({ units: ['agent-board-listen.service'] });
  try {
    await restartUnits(restartDeps(), ['listen', 'watch']);
    assert.deepEqual(calls, ['systemctl --user restart agent-board-listen.service']);
    assert.match(printed.join('\n'), /agent-board-watch\.service is not installed in .*board setup --enable/);
    calls.length = 0;
    await assert.rejects(restartUnits(restartDeps(), ['watch']), ReportedFailure);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a failing restart is reported and the rest still restart', async () => {
  const { dir, printed, calls, restartDeps } = fixture({ units: ALL_UNITS });
  try {
    const run: RestartDeps['run'] = async (program, args) => {
      calls.push([program, ...args].join(' '));
      if (args.includes('agent-board-listen.service')) throw new Error('systemctl failed: boom');
    };
    await assert.rejects(restartUnits(restartDeps({ run }), []), ReportedFailure);
    assert.equal(calls.length, 3);
    assert.match(printed.join('\n'), /could not restart agent-board-listen\.service: systemctl failed: boom/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on macOS the listener and the watch agent are kicked with -k and the dispatch agent without', async () => {
  const { dir, printed, calls, restartDeps } = fixture();
  try {
    await restartUnits(restartDeps({ platform: 'darwin' }), []);
    assert.deepEqual(calls, [
      'launchctl kickstart gui/501/de.codeplant.agent-board.dispatch',
      'launchctl kickstart -k gui/501/de.codeplant.agent-board.listen',
      'launchctl kickstart -k gui/501/de.codeplant.agent-board.watch',
    ]);
    assert.equal(printed.length, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an agent launchd has not loaded gets the bootstrap line', async () => {
  const { dir, printed, calls, restartDeps } = fixture();
  try {
    const base = restartDeps({ platform: 'darwin' });
    const deps = { ...base, launchd: { ...base.launchd, loaded: async (name: string) => name !== 'watch' } };
    await restartUnits(deps, []);
    assert.equal(calls.length, 2);
    assert.match(
      printed.join('\n'),
      /de\.codeplant\.agent-board\.watch is not loaded; run "board setup --enable", or load it with: launchctl bootstrap gui\/501 .*de\.codeplant\.agent-board\.watch\.plist/,
    );
    await assert.rejects(
      restartUnits({ ...deps, launchd: { ...deps.launchd, loaded: async () => false } }, ['listen']),
      ReportedFailure,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('restart refuses a system without worker units', async () => {
  const { dir, restartDeps } = fixture();
  try {
    await assert.rejects(restartUnits(restartDeps({ platform: 'freebsd' }), []), /no worker units/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('logs on Linux reads the journal of the selected services', async () => {
  const { dir, calls, logsDeps } = fixture();
  try {
    await showLogs(logsDeps(), undefined, { lines: '100' });
    await showLogs(logsDeps(), 'listen', { lines: '20', follow: true, since: '1 hour ago' });
    assert.deepEqual(calls, [
      'journalctl --user --no-pager -n 100 -u agent-board-dispatch.service -u agent-board-listen.service -u agent-board-watch.service',
      'journalctl --user --no-pager -n 20 -f --since=1 hour ago -u agent-board-listen.service',
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("logs exits with the program's status", async () => {
  const { dir, logsDeps } = fixture();
  try {
    await assert.rejects(
      showLogs(logsDeps({ run: async () => 3 }), 'watch', { lines: '5' }),
      (error) => error instanceof ReportedFailure && error.exitCode === 3,
    );
    await assert.rejects(
      showLogs(logsDeps({ run: async () => undefined }), 'watch', { lines: '5' }),
      /could not start/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('logs on macOS tails the launchd logs and names a missing one', async () => {
  const { dir, logDir, calls, logsDeps } = fixture({ logs: ['launchd.dispatch.log', 'launchd.listen.log'] });
  try {
    await showLogs(logsDeps({ platform: 'darwin' }), 'listen', { lines: '7', follow: true });
    assert.deepEqual(calls, [`tail -n 7 -f ${join(logDir, 'launchd.listen.log')}`]);
    await assert.rejects(
      showLogs(logsDeps({ platform: 'darwin' }), undefined, { lines: '100' }),
      new RegExp(`${join(logDir, 'launchd.watch.log').replaceAll('.', '\\.')} does not exist`),
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a task id tails its log file on both platforms, and a missing log says so', async () => {
  const { dir, logDir, calls, logsDeps } = fixture({ logs: [`${TASK}.log`] });
  try {
    await showLogs(logsDeps(), TASK, { lines: '50' });
    await showLogs(logsDeps({ platform: 'darwin' }), TASK, { lines: '50', follow: true });
    const file = join(logDir, `${TASK}.log`);
    assert.deepEqual(calls, [`tail -n 50 ${file}`, `tail -n 50 -f ${file}`]);
    await assert.rejects(showLogs(logsDeps(), 'Other1', { lines: '50' }), /this machine has no log for task Other1/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('logs validates its flags and its target before anything runs', async () => {
  const { dir, calls, logsDeps } = fixture({ logs: [`${TASK}.log`] });
  try {
    for (const lines of ['0', '-1', '1.5', 'x', '', '99999999', '5; rm']) {
      await assert.rejects(showLogs(logsDeps(), 'listen', { lines }), UsageError, lines);
    }
    for (const since of ['', '$(id)', 'a;b', 'x'.repeat(41), 'a\nb']) {
      await assert.rejects(showLogs(logsDeps(), 'listen', { lines: '5', since }), UsageError, since);
    }
    await assert.rejects(showLogs(logsDeps({ platform: 'darwin' }), 'listen', { lines: '5', since: '1h' }), UsageError);
    await assert.rejects(showLogs(logsDeps(), TASK, { lines: '5', since: '1h' }), UsageError);
    for (const target of ['../etc/passwd', 'intake', '-n', 'a b']) {
      await assert.rejects(showLogs(logsDeps(), target, { lines: '5' }), UsageError, target);
    }
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

function go(argv: string[], dir: string, overrides: ProgramOptions): Promise<void> {
  return runBoard(argv, {
    env: {
      XDG_CONFIG_HOME: join(dir, 'xdg'),
      XDG_STATE_HOME: join(dir, 'state'),
      AGENT_BOARD_CONFIG_DIR: join(dir, 'cfg'),
    },
    platform: 'linux',
    writeOut: () => undefined,
    writeErr: () => undefined,
    ...overrides,
  });
}

test('board restart and board logs run through the program with injected processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-units-'));
  try {
    const unitDir = join(dir, 'xdg', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    for (const name of ALL_UNITS) writeFileSync(join(unitDir, name), '');
    const calls: string[] = [];
    const lines: string[] = [];
    const overrides: ProgramOptions = {
      runSystem: async (program, args) => void calls.push([program, ...args].join(' ')),
      runInherited: async (argv) => {
        calls.push(argv.join(' '));
        return 0;
      },
      writeOut: (text) => lines.push(text),
    };
    await go(['restart', 'watch'], dir, overrides);
    await go(['logs', 'dispatch', '-n', '5'], dir, overrides);
    assert.deepEqual(calls, [
      'systemctl --user restart agent-board-watch.service',
      'journalctl --user --no-pager -n 5 -u agent-board-dispatch.service',
    ]);
    await assert.rejects(go(['restart', 'bogus'], dir, overrides), /bogus/);
    const inRun = { ...overrides, env: { AGENT_BOARD_TASK: TASK, XDG_CONFIG_HOME: join(dir, 'xdg') } };
    await assert.rejects(go(['restart'], dir, inRun), /not available inside a board run/);
    await go(['logs', 'listen', '-n', '1'], dir, inRun);
    assert.equal(calls.length, 3, 'logs is read-only and runs inside a board run');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
