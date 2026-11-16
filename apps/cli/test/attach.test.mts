import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Task } from '@agent-board/shared';
import { ReportedFailure, UsageError } from '../src/cli.mts';
import type { LinkingContext } from '../src/cli.mts';
import { renderThread } from '../src/commands/board.mts';
import type { Spawner } from '../src/commands/board.mts';
import { runBoard } from '../src/commands/program.mts';
import { CONFIG, fakeBackend, linkTo, SESSION, task } from './helpers.mts';

const ID = 'Zt0Test1';

interface Spawn {
  command: string;
  args: string[];
  cwd: string;
}

function setup(overrides: Partial<Task>, { exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-attach-'));
  const backend = fakeBackend([
    task({ id: ID, status: 'needs-me', sessionId: SESSION, machine: CONFIG.machine, workdir: dir, ...overrides }),
  ]);
  const printed: string[] = [];
  const spawns: Spawn[] = [];
  const spawnClaude: Spawner = async (command, args, { cwd }) => {
    spawns.push({ command, args, cwd });
    return exitCode;
  };
  const go = (argv: string[], env: Record<string, string> = {}) =>
    runBoard(argv, {
      env,
      spawnClaude,
      context: (dryRun): LinkingContext => ({
        config: CONFIG,
        backend,
        dryRun,
        taskLink: linkTo,
        print: (line) => printed.push(line),
      }),
    });
  return { dir, printed, spawns, go, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('attach resumes the session in the task directory, forked with --fork', async () => {
  const { dir, spawns, go, cleanup } = setup({});
  try {
    await go(['attach', ID]);
    await go(['attach', ID, '--fork']);
    assert.deepEqual(spawns, [
      { command: 'claude', args: ['--resume', SESSION], cwd: dir },
      { command: 'claude', args: ['--resume', SESSION, '--fork-session'], cwd: dir },
    ]);
  } finally {
    cleanup();
  }
});

test('attach --dry-run prints the command and starts nothing', async () => {
  const { dir, printed, spawns, go, cleanup } = setup({});
  try {
    await go(['attach', '--dry-run', ID, '--fork']);
    assert.deepEqual(printed, [`DRY claude --resume ${SESSION} --fork-session  (in ${dir})`]);
    await go(['--dry-run', 'attach', ID]);
    assert.equal(printed[1], `DRY claude --resume ${SESSION}  (in ${dir})`);
    assert.deepEqual(spawns, []);
  } finally {
    cleanup();
  }
});

test('attach ends with the exit status of claude', async () => {
  const { go, cleanup } = setup({}, { exitCode: 3 });
  try {
    await assert.rejects(
      go(['attach', ID]),
      (error: unknown) => error instanceof ReportedFailure && error.exitCode === 3,
    );
  } finally {
    cleanup();
  }
});

test('attach refuses what it cannot attach to, and starts nothing', async () => {
  const cases: [string, Partial<Task>, RegExp][] = [
    ['running', { status: 'running' }, /HTTP 409.*"the task is running.*Transcript on the task page"/],
    ['no session', { sessionId: null }, /HTTP 409.*"the task has no session"/],
    ['another machine', { machine: 'office' }, /HTTP 403.*"the session lives on office, not on here"/],
    ['no machine', { machine: null }, /HTTP 403.*"the session lives on no machine, not on here"/],
    ['unreadable workdir', { workdir: null }, /directory of Zt0Test1 is unknown/],
    ['missing workdir', { workdir: '/nonexistent/board-attach' }, /is not there: \/nonexistent\/board-attach/],
  ];
  for (const [name, overrides, message] of cases) {
    const { spawns, go, cleanup } = setup(overrides);
    try {
      await assert.rejects(
        go(['attach', ID]),
        (error: unknown) => error instanceof UsageError && message.test(error.message),
        name,
      );
      assert.deepEqual(spawns, [], name);
    } finally {
      cleanup();
    }
  }
});

test('attach refuses a workdir that is a file', async () => {
  const { dir, cleanup } = setup({});
  const file = join(dir, 'file');
  writeFileSync(file, '');
  const { spawns, go, cleanup: cleanupFile } = setup({ workdir: file });
  try {
    await assert.rejects(go(['attach', ID]), /is not there/);
    assert.deepEqual(spawns, []);
  } finally {
    cleanupFile();
    cleanup();
  }
});

test('attach is not available inside a board run', async () => {
  const { spawns, go, cleanup } = setup({});
  try {
    await assert.rejects(
      go(['attach', ID], { AGENT_BOARD_TASK: ID }),
      /board attach is not available inside a board run/,
    );
    assert.deepEqual(spawns, []);
  } finally {
    cleanup();
  }
});

test('board show names the session, its machine and directory only when there is a session', () => {
  const withSession = renderThread(
    task({ id: 'a', title: 'T', sessionId: SESSION, machine: 'here', workdir: '/w/x' }),
    [],
  );
  assert.match(withSession, new RegExp(`labels: -\nsession: ${SESSION} · here:/w/x\n\n## Input`));
  const unknown = renderThread(task({ id: 'a', title: 'T', sessionId: SESSION }), []);
  assert.match(unknown, new RegExp(`session: ${SESSION} · -:-\n`));
  assert.equal(renderThread(task({ id: 'a', title: 'T' }), []).includes('session:'), false);
});

test('board show names the PR the agent reported, when there is one', () => {
  const url = 'https://github.com/acme/app/pull/9';
  assert.match(renderThread(task({ id: 'a', title: 'T', pr: url }), []), new RegExp(`labels: -\npr: ${url}\n`));
  assert.equal(renderThread(task({ id: 'a', title: 'T' }), []).includes('pr:'), false);
});
