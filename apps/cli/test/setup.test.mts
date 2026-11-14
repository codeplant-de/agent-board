import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
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
import { runBoard } from '../src/commands.mts';
import {
  parseExecStart,
  quoteExecArg,
  renderUnits,
  setup,
  treeProblem,
  ENABLE_COMMAND,
  UNIT_PATH,
} from '../src/setup.mts';
import type { SetupDeps } from '../src/setup.mts';

const command = (name: string): string[] => [
  '/opt/node/bin/node',
  '/opt/board/apps/cli/src/main.mts',
  'internal',
  name,
];

test('the rendered units are the ones the checkout shipped, with the lock path of bin/dispatch and bin/intake', () => {
  const units = Object.fromEntries(
    renderUnits({ flock: '/usr/bin/flock', command }).map((unit) => [unit.file, unit.text]),
  );
  assert.deepEqual(Object.keys(units), [
    'agent-board-dispatch.service',
    'agent-board-dispatch.timer',
    'agent-board-intake.service',
    'agent-board-intake.timer',
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
  assert.match(units['agent-board-intake.service'] ?? '', /Description=agent-board intake: review requests to tasks\n/);
  assert.match(
    units['agent-board-intake.service'] ?? '',
    /ExecStart=\/usr\/bin\/flock -n -E 75 %t\/agent-board-intake\.lock .* internal intake\nSuccessExitStatus=75\nTimeoutStartSec=300\n/,
  );
  assert.match(units['agent-board-intake.timer'] ?? '', /OnBootSec=5min\nOnUnitActiveSec=10min\nAccuracySec=30s\n/);
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
    platform: 'linux',
    which: (program) => `/usr/bin/${program}`,
    command: (name) => command(name),
    run: async (program, args) => void calls.push([program, ...args].join(' ')),
    print: (line) => printed.push(line),
    ...overrides,
  };
  return { dir, unitDir, printed, calls, deps };
}

test('setup writes four unit copies, reloads systemd and prints the enable line', async () => {
  const { dir, unitDir, printed, calls, deps } = fixture();
  try {
    await setup(deps, {});
    assert.deepEqual(readdirSync(unitDir).sort(), [
      'agent-board-dispatch.service',
      'agent-board-dispatch.timer',
      'agent-board-intake.service',
      'agent-board-intake.timer',
    ]);
    assert.deepEqual(calls, ['systemctl --user daemon-reload']);
    assert.ok(printed.some((line) => line.includes(ENABLE_COMMAND)));
    assert.equal(ENABLE_COMMAND, 'systemctl --user enable --now agent-board-dispatch.timer agent-board-intake.timer');
    for (const file of readdirSync(unitDir)) assert.equal(lstatSync(join(unitDir, file)).isSymbolicLink(), false);
    printed.length = 0;
    await setup(deps, {});
    assert.equal(printed.filter((line) => line.startsWith('unchanged ')).length, 4);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('setup --enable also enables and starts the timers', async () => {
  const { dir, calls, deps } = fixture();
  try {
    await setup(deps, { enable: true });
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user enable --now agent-board-dispatch.timer agent-board-intake.timer',
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('setup --print shows the units and changes nothing', async () => {
  const { dir, unitDir, printed, calls, deps } = fixture();
  try {
    await setup(deps, { print: true });
    assert.equal(printed.length, 4);
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

test('setup needs Linux and flock, and says so', async () => {
  const mac = fixture({ platform: 'darwin' });
  const noFlock = fixture({ which: () => undefined });
  try {
    await assert.rejects(setup(mac.deps, {}), /needs Linux; this is darwin/);
    await assert.rejects(setup(noFlock.deps, {}), /flock is not on PATH/);
  } finally {
    rmSync(mac.dir, { recursive: true });
    rmSync(noFlock.dir, { recursive: true });
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
    assert.deepEqual(readdirSync(join(dir, 'xdg', 'systemd', 'user')).length, 4);
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

test('with both timers enabled already, setup does not tell you to enable them', async () => {
  const { dir, printed, deps } = fixture({ timerEnabled: async () => true });
  const partly = fixture({ timerEnabled: async (timer) => timer.includes('dispatch') });
  try {
    await setup(deps, {});
    assert.ok(!printed.some((line) => line.includes('Enable the timers')));
    assert.ok(printed.some((line) => line.includes('enabled already')));
    await setup(partly.deps, {});
    assert.ok(partly.printed.some((line) => line.includes('Enable the timers')));
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(partly.dir, { recursive: true });
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
    assert.equal(readdirSync(unitDir).length, 4);
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
    symlinkSync(fileURLToPath(new URL('../bin/board', import.meta.url)), join(installDir, 'board'));
    assert.equal(treeProblem({ BOARD_INSTALL_DIR: installDir }), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
