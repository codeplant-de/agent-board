import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runBoard } from '../commands/program.mts';
import {
  parseExecStart,
  quoteExecArg,
  renderUnits,
  setup,
  treeProblem,
  ENABLE_COMMAND,
  UNIT_PATH,
  whichOnPath,
} from './setup.mts';
import type { SetupDeps } from './setup.mts';

const command = (name: string): string[] => [
  '/opt/node/bin/node',
  '/opt/board/apps/cli/src/main.mts',
  'internal',
  name,
];

test('the rendered units are the ones the checkout shipped, with the lock path of bin/dispatch', () => {
  const units = Object.fromEntries(
    renderUnits({ flock: '/usr/bin/flock', command }).map((unit) => [unit.file, unit.text]),
  );
  assert.deepEqual(Object.keys(units), [
    'agent-board-dispatch.service',
    'agent-board-dispatch.timer',
    'agent-board-listen.service',
  ]);
  assert.equal(
    units['agent-board-dispatch.service'],
    `[Unit]
Description=agent-board dispatcher: one tick

[Service]
Type=oneshot
# PATH is for gh, claude and systemd-run.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# The lock keeps one run at a time, whoever starts it; exit 75 means another run holds it, which is not a failure.
ExecStart=/usr/bin/flock -n -E 75 %t/agent-board-dispatch.lock /opt/node/bin/node /opt/board/apps/cli/src/main.mts internal dispatch
SuccessExitStatus=75
TimeoutStartSec=110
`,
  );
  assert.equal(
    units['agent-board-dispatch.timer'],
    `[Unit]
Description=agent-board dispatcher every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=10s

[Install]
WantedBy=timers.target
`,
  );
  assert.equal(
    units['agent-board-listen.service'],
    `[Unit]
Description=agent-board listener: dispatch as soon as the board says tasks changed
# The listener exits when the board no longer serves this CLI, until the CLI is updated; systemd must keep restarting it, not give up.
StartLimitIntervalSec=0

[Service]
Type=simple
# PATH is for the gh, claude and systemd-run that the dispatch ticks it starts use.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node/bin/node /opt/board/apps/cli/src/main.mts internal listen
Restart=always
RestartSec=10
# Stopping signals the listener only; it waits for a running tick, which systemd then no longer cuts off midway.
KillMode=mixed
# Long enough for a tick to reach its limit and grace; systemd's 90 s default would kill one midway.
TimeoutStopSec=130

[Install]
WantedBy=default.target
`,
  );
});

test('arguments with spaces, quotes, % and $ are quoted the way systemd reads them', () => {
  assert.equal(quoteExecArg('/opt/node/bin/node'), '/opt/node/bin/node');
  assert.equal(quoteExecArg('/home/my user/board/main.mts'), '"/home/my user/board/main.mts"');
  assert.equal(quoteExecArg('/odd/50%/x'), '/odd/50%%/x');
  assert.equal(quoteExecArg('/a"b'), '"/a\\"b"');
  assert.equal(quoteExecArg('/a$b'), '/a$$b');
  assert.throws(() => quoteExecArg('/a\nb'), /line break/);
  for (const path of ['/home/my user/x y/main.mts', '/odd/50%/x', '/a"b\\c', '/a$b']) {
    const [unit] = renderUnits({ flock: '/usr/bin/flock', command: () => ['/n', path] });
    assert.deepEqual(parseExecStart(unit?.text ?? ''), [
      '/usr/bin/flock',
      '-n',
      '-E',
      '75',
      '%t/agent-board-dispatch.lock',
      '/n',
      path,
    ]);
  }
});

function fixture(overrides: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-setup-test-'));
  const unitDir = join(dir, 'xdg', 'systemd', 'user');
  const printed: string[] = [];
  const calls: string[] = [];
  const deps: SetupDeps = {
    unitDir,
    launchd: {
      home: '/Users/me',
      agentsDir: join(dir, 'LaunchAgents'),
      logDir: join(dir, 'logs'),
      runDir: join(dir, 'run'),
      uid: 501,
      env: {},
      loaded: async () => false,
    },
    platform: 'linux',
    which: (program) => `/usr/bin/${program}`,
    command: (name) => command(name),
    run: async (program, args) => void calls.push([program, ...args].join(' ')),
    print: (line) => printed.push(line),
    ...overrides,
  };
  return { dir, unitDir, printed, calls, deps };
}

test('setup writes three unit copies, reloads systemd and prints the enable line', async () => {
  const { dir, unitDir, printed, calls, deps } = fixture();
  try {
    await setup(deps, {});
    assert.deepEqual(readdirSync(unitDir).sort(), [
      'agent-board-dispatch.service',
      'agent-board-dispatch.timer',
      'agent-board-listen.service',
    ]);
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user try-restart agent-board-listen.service',
    ]);
    assert.ok(printed.some((line) => line.includes(ENABLE_COMMAND)));
    assert.equal(ENABLE_COMMAND, 'systemctl --user enable --now agent-board-dispatch.timer agent-board-listen.service');
    for (const file of readdirSync(unitDir)) assert.equal(lstatSync(join(unitDir, file)).isSymbolicLink(), false);
    printed.length = 0;
    await setup(deps, {});
    assert.equal(printed.filter((line) => line.startsWith('unchanged ')).length, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('setup restarts a running listener when it wrote a changed unit, and only then', async () => {
  const { dir, printed, calls, deps } = fixture();
  try {
    await setup(deps, {});
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user try-restart agent-board-listen.service',
    ]);
    assert.ok(printed.some((line) => line.startsWith('restarted agent-board-listen.service')));
    calls.length = 0;
    await setup(deps, {});
    assert.deepEqual(calls, ['systemctl --user daemon-reload'], 'unchanged units restart nothing');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('setup --enable also enables and starts the timers and the listener', async () => {
  const { dir, calls, deps } = fixture();
  try {
    await setup(deps, { enable: true });
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user try-restart agent-board-listen.service',
      'systemctl --user enable --now agent-board-dispatch.timer agent-board-listen.service',
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('setup --print shows the units and changes nothing', async () => {
  const { dir, unitDir, printed, calls, deps } = fixture();
  try {
    await setup(deps, { print: true });
    assert.equal(printed.length, 3);
    assert.match(printed[0] ?? '', /^# .*agent-board-dispatch\.service\n\[Unit\]/);
    assert.deepEqual(calls, []);
    assert.throws(() => readdirSync(unitDir));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an installed unit that differs is replaced by a copy, and the difference is shown', async () => {
  const { dir, unitDir, printed, deps } = fixture();
  try {
    mkdirSync(unitDir, { recursive: true });
    const target = join(dir, 'old-dispatch.service');
    writeFileSync(target, '[Service]\nExecStart=/home/me/workspace/agent-board/apps/cli/bin/dispatch\n');
    symlinkSync(target, join(unitDir, 'agent-board-dispatch.service'));
    await setup(deps, {});
    const installed = join(unitDir, 'agent-board-dispatch.service');
    assert.equal(lstatSync(installed).isSymbolicLink(), false);
    assert.match(readFileSync(installed, 'utf8'), /ExecStart=\/usr\/bin\/flock/);
    assert.match(readFileSync(target, 'utf8'), /bin\/dispatch/, 'the link target is not written through');
    assert.ok(printed.includes('~ agent-board-dispatch.service differs from what setup writes:'));
    assert.ok(printed.includes('    - ExecStart=/home/me/workspace/agent-board/apps/cli/bin/dispatch'));
    assert.ok(printed.some((line) => line.startsWith('    + ExecStart=/usr/bin/flock')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('setup needs Linux or macOS, and flock or lockf, and says so', async () => {
  const other = fixture({ platform: 'freebsd' });
  const noFlock = fixture({ which: () => undefined });
  const noLockf = fixture({ platform: 'darwin', which: () => undefined });
  try {
    await assert.rejects(setup(other.deps, {}), /needs Linux with systemd or macOS; this is freebsd/);
    await assert.rejects(setup(noFlock.deps, {}), /flock is not on PATH/);
    await assert.rejects(setup(noLockf.deps, {}), /lockf is not on PATH/);
  } finally {
    for (const f of [other, noFlock, noLockf]) rmSync(f.dir, { recursive: true });
  }
});

test('board setup goes through the command line into a temp unit dir and is refused inside a run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-setup-test-'));
  const calls: string[] = [];
  const options = {
    env: {
      XDG_CONFIG_HOME: join(dir, 'xdg'),
      AGENT_BOARD_CONFIG_DIR: join(dir, 'cfg'),
      BOARD_INSTALL_DIR: join(dir, 'bin'),
    },
    writeOut: () => undefined,
    platform: 'linux',
    which: (program: string) => `/usr/bin/${program}`,
    runSystem: async (program: string, args: string[]) => void calls.push([program, ...args].join(' ')),
    systemctlCode: async () => 1,
  };
  try {
    await runBoard(['setup'], options);
    assert.equal(readdirSync(join(dir, 'xdg', 'systemd', 'user')).length, 3);
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user try-restart agent-board-listen.service',
    ]);
    mkdirSync(join(dir, 'cfg'));
    writeFileSync(join(dir, 'cfg', 'config.json'), '{"intake": {}, "lanes": 3}');
    calls.length = 0;
    await runBoard(['setup'], options);
    assert.equal(
      readdirSync(join(dir, 'xdg', 'systemd', 'user')).length,
      3,
      'a config the CLI cannot read does not stop setup',
    );
    assert.deepEqual(calls, ['systemctl --user daemon-reload']);
    await assert.rejects(
      runBoard(['setup'], { ...options, env: { ...options.env, AGENT_BOARD_TASK: 'Zt0Test1' } }),
      /not available inside a board run/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the units run with the PATH setup exports, and doctor looks tools up on it', () => {
  const [service] = renderUnits({ flock: '/usr/bin/flock', command });
  assert.ok(service?.text.includes(`Environment=PATH=${UNIT_PATH}\n`));
  assert.equal(UNIT_PATH, '%h/.local/bin:/usr/local/bin:/usr/bin:/bin');
});

test('with the timers and the listener enabled already, setup does not tell you to enable them', async () => {
  const { dir, printed, deps } = fixture({ unitEnabled: async () => true });
  const partly = fixture({ unitEnabled: async (unit) => unit.includes('dispatch') });
  const noListener = fixture({ unitEnabled: async (unit) => unit.endsWith('.timer') });
  try {
    await setup(deps, {});
    assert.ok(!printed.some((line) => line.includes('Enable the timer')));
    assert.ok(printed.some((line) => line.includes('enabled already')));
    await setup(partly.deps, {});
    assert.ok(partly.printed.some((line) => line.includes('Enable the timer and the listener')));
    await setup(noListener.deps, {});
    assert.ok(noListener.printed.some((line) => line.includes('Enable the timer and the listener')));
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(partly.dir, { recursive: true });
    rmSync(noListener.dir, { recursive: true });
  }
});

test('setup from a tree that is not the installed one refuses without --force, and warns with it', async () => {
  const problem = 'this checkout (/scratch/apps/cli) is not the one /home/me/.local/bin/board runs (/live/apps/cli)';
  const { dir, unitDir, printed, calls, deps } = fixture({ treeProblem: () => problem });
  try {
    await assert.rejects(setup(deps, {}), /not the one .* runs .*add --force/);
    assert.throws(() => readdirSync(unitDir), 'nothing was written');
    assert.deepEqual(calls, []);
    await setup(deps, { print: true });
    assert.equal(calls.length, 0, '--print changes nothing and needs no --force');
    await setup(deps, { force: true });
    assert.ok(printed.includes(`warning: ${problem}`));
    assert.equal(readdirSync(unitDir).length, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the tree check compares this checkout with where the installed board resolves to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-tree-test-'));
  try {
    assert.equal(
      treeProblem({ BOARD_INSTALL_DIR: join(dir, 'none') }),
      undefined,
      'nothing installed: nothing to take over',
    );
    const elsewhere = join(dir, 'elsewhere', 'apps', 'cli', 'bin');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'board'), '#!/bin/sh\n');
    const installDir = join(dir, 'bin');
    mkdirSync(installDir);
    symlinkSync(join(elsewhere, 'board'), join(installDir, 'board'));
    assert.match(treeProblem({ BOARD_INSTALL_DIR: installDir }) ?? '', /is not the one .*runs/);
    rmSync(join(installDir, 'board'));
    symlinkSync(fileURLToPath(new URL('../../bin/board', import.meta.url)), join(installDir, 'board'));
    assert.equal(treeProblem({ BOARD_INSTALL_DIR: installDir }), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a binary run from the temp directory is not installed without --force; one elsewhere is', () => {
  const inTemp = join(realpathSync(tmpdir()), 'download', 'board');
  assert.match(treeProblem({}, { compiled: true, execPath: inTemp }) ?? '', /runs from .*in the temp directory/);
  assert.equal(treeProblem({}, { compiled: true, execPath: '/home/me/.local/bin/board' }), undefined);
});

test('setup renders, writes and enables only dispatch and the listener', async () => {
  const { dir, unitDir, printed, calls, deps } = fixture();
  try {
    await setup(deps, { enable: true });
    assert.deepEqual(readdirSync(unitDir).sort(), [
      'agent-board-dispatch.service',
      'agent-board-dispatch.timer',
      'agent-board-listen.service',
    ]);
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user try-restart agent-board-listen.service',
      'systemctl --user enable --now agent-board-dispatch.timer agent-board-listen.service',
    ]);
    assert.ok(printed.includes('enabled and started the dispatch timer and the listener'));
    assert.ok(printed.every((line) => !line.includes('intake')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const OLD_INTAKE_UNITS = ['agent-board-intake.service', 'agent-board-intake.timer'];

test('setup disables and stops the timer of the removed intake, deletes its units, and says so', async () => {
  const { dir, unitDir, printed, calls, deps } = fixture();
  try {
    mkdirSync(unitDir, { recursive: true });
    for (const file of OLD_INTAKE_UNITS) writeFileSync(join(unitDir, file), 'old\n');
    await setup(deps, {});
    assert.deepEqual(readdirSync(unitDir).sort(), [
      'agent-board-dispatch.service',
      'agent-board-dispatch.timer',
      'agent-board-listen.service',
    ]);
    assert.deepEqual(calls.slice(0, 2), [
      'systemctl --user disable --now agent-board-intake.timer',
      'systemctl --user stop agent-board-intake.service',
    ]);
    assert.ok(calls.indexOf('systemctl --user daemon-reload') > 1, 'the reload comes after the removal');
    const note = printed.find((line) => line.startsWith('removed '));
    assert.ok(note?.includes(join(unitDir, 'agent-board-intake.service')) && note.includes('github-reviews'));
    printed.length = 0;
    calls.length = 0;
    await setup(deps, {});
    assert.ok(
      printed.every((line) => !line.startsWith('removed ')),
      'nothing is left to remove the second time',
    );
    assert.ok(calls.every((call) => !call.includes('intake')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the units of the removed intake are deleted even when systemctl cannot disable or stop them', async () => {
  const { dir, unitDir, deps } = fixture({
    run: async (_program, args) => {
      if (args.includes('disable') || args.includes('stop')) throw new Error('unit not loaded');
    },
  });
  try {
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, 'agent-board-intake.timer'), 'old\n');
    await setup(deps, {});
    assert.ok(!readdirSync(unitDir).some((file) => file.includes('intake')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('setup --print and a refused foreign tree leave the units of the removed intake alone', async () => {
  const { dir, unitDir, calls, deps } = fixture();
  const foreign = fixture({ treeProblem: () => 'this checkout is not the installed one' });
  try {
    for (const where of [unitDir, foreign.unitDir]) {
      mkdirSync(where, { recursive: true });
      writeFileSync(join(where, 'agent-board-intake.timer'), 'old\n');
    }
    await setup(deps, { print: true });
    await assert.rejects(setup(foreign.deps, {}), /add --force/);
    assert.ok(readdirSync(unitDir).includes('agent-board-intake.timer'));
    assert.ok(readdirSync(foreign.unitDir).includes('agent-board-intake.timer'));
    assert.deepEqual(calls, []);
    assert.deepEqual(foreign.calls, []);
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(foreign.dir, { recursive: true });
  }
});

test('whichOnPath finds only an executable file on the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-which-'));
  try {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(dir, 'plain'), '', { mode: 0o644 });
    assert.equal(whichOnPath('tool', `/nowhere::${dir}`), join(dir, 'tool'));
    assert.equal(whichOnPath('plain', dir), undefined);
    assert.equal(whichOnPath('tool', undefined), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

function macFixture(overrides: Partial<SetupDeps> = {}, loaded: (name: string) => boolean = () => false) {
  const base = fixture({ platform: 'darwin', ...overrides });
  const calls = base.calls;
  const deps: SetupDeps = { ...base.deps, launchd: { ...base.deps.launchd, loaded: async (name) => loaded(name) } };
  return { ...base, deps, calls, agentsDir: deps.launchd.agentsDir };
}

test('on macOS setup writes the two agents and the directories, and prints the bootstrap lines instead of loading', async () => {
  const { dir, printed, calls, deps, agentsDir } = macFixture();
  try {
    await setup(deps, {});
    assert.deepEqual(readdirSync(agentsDir).sort(), [
      'de.codeplant.agent-board.dispatch.plist',
      'de.codeplant.agent-board.listen.plist',
    ]);
    for (const file of readdirSync(agentsDir)) {
      assert.equal(lstatSync(join(agentsDir, file)).isSymbolicLink(), false);
      assert.equal(lstatSync(join(agentsDir, file)).mode & 0o777, 0o644);
    }
    assert.equal(lstatSync(deps.launchd.runDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(deps.launchd.logDir).mode & 0o777, 0o700);
    assert.deepEqual(calls, [], 'nothing is loaded without --enable');
    assert.ok(printed.some((line) => line.startsWith('Load the agents when you are ready:')));
    assert.ok(
      printed.some((line) =>
        line.includes(`launchctl bootstrap gui/501 '${join(agentsDir, 'de.codeplant.agent-board.listen.plist')}'`),
      ),
    );
    assert.match(
      readFileSync(join(agentsDir, 'de.codeplant.agent-board.dispatch.plist'), 'utf8'),
      /<string>\/usr\/bin\/lockf<\/string>/,
    );
    printed.length = 0;
    await setup(deps, {});
    assert.equal(printed.filter((line) => line.startsWith('unchanged ')).length, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on macOS --enable boots each agent out (a failure is fine) and in again', async () => {
  const { dir, calls, deps, agentsDir } = macFixture({
    run: async (program, args) => {
      calls.push([program, ...args].join(' '));
      if (args[0] === 'bootout') throw new Error('not loaded');
    },
  });
  try {
    await setup(deps, { enable: true });
    assert.deepEqual(calls, [
      'launchctl bootout gui/501/de.codeplant.agent-board.dispatch',
      `launchctl bootstrap gui/501 ${join(agentsDir, 'de.codeplant.agent-board.dispatch.plist')}`,
      'launchctl bootout gui/501/de.codeplant.agent-board.listen',
      `launchctl bootstrap gui/501 ${join(agentsDir, 'de.codeplant.agent-board.listen.plist')}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on macOS an agent that is loaded is loaded again only when its file changed', async () => {
  const { dir, printed, calls, deps } = macFixture({}, () => true);
  try {
    await setup(deps, {});
    assert.equal(calls.filter((call) => call.includes('bootstrap')).length, 2, 'new files: both reloaded');
    assert.ok(printed.some((line) => line.includes('loaded already')));
    calls.length = 0;
    await setup(deps, {});
    assert.deepEqual(calls, [], 'nothing changed, nothing restarts');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on macOS --print and a foreign tree behave as on Linux', async () => {
  const { dir, printed, calls, deps, agentsDir } = macFixture();
  const foreign = macFixture({ treeProblem: () => 'this checkout is not the installed one' });
  try {
    await setup(deps, { print: true });
    assert.ok(printed.every((line) => !line.startsWith('wrote ')));
    assert.ok(printed[0]?.startsWith(`# ${agentsDir}/`));
    assert.deepEqual(calls, []);
    await assert.rejects(setup(foreign.deps, {}), /add --force to install these agents anyway/);
    assert.throws(() => readdirSync(foreign.agentsDir), 'nothing was written');
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(foreign.dir, { recursive: true });
  }
});

test('board setup on macOS goes through the command line into a temp home', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-setup-mac-test-'));
  const calls: string[] = [];
  const options = {
    env: {
      HOME: join(dir, 'home'),
      AGENT_BOARD_CONFIG_DIR: join(dir, 'cfg'),
      AGENT_BOARD_STATE_DIR: join(dir, 'state'),
      BOARD_INSTALL_DIR: join(dir, 'bin'),
    },
    writeOut: () => undefined,
    platform: 'darwin',
    which: (program: string) => `/usr/bin/${program}`,
    runSystem: async (program: string, args: string[]) => void calls.push([program, ...args].join(' ')),
    agentLoaded: async () => false,
  };
  try {
    await runBoard(['setup', '--enable'], options);
    assert.deepEqual(readdirSync(join(dir, 'home', 'Library', 'LaunchAgents')).length, 2);
    assert.equal(calls.length, 4);
    const plist = readFileSync(
      join(dir, 'home', 'Library', 'LaunchAgents', 'de.codeplant.agent-board.dispatch.plist'),
      'utf8',
    );
    assert.ok(plist.includes(`${join(dir, 'state', 'run')}/agent-board-dispatch.lock`));
    assert.ok(plist.includes(`<key>AGENT_BOARD_STATE_DIR</key>`), 'the state directory the shell chose is passed on');
    assert.ok(plist.includes(`${join(dir, 'state', 'logs')}/launchd.dispatch.log`));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
