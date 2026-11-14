import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SHELLS, renderCompletion, completionModel } from '../src/completion.mts';
import type { Shell } from '../src/completion.mts';
import type { Context } from '../src/cli.mts';
import { buildProgram, runBoard } from '../src/commands.mts';
import { CONFIG, fakeBackend, schedule, task } from './helpers.mts';

const model = completionModel(buildProgram({ env: {} }));
const VISIBLE = [
  'tasks',
  'show',
  'comment',
  'move',
  'notify',
  'ask',
  'add',
  'schedule',
  'schedules',
  'delay',
  'init',
  'doctor',
  'setup',
  'self-update',
  'completion',
  'help',
];

function script(shell: Shell): string {
  return renderCompletion(shell, model);
}

test('the model lists the visible commands only, with their flags', () => {
  assert.deepEqual(
    model.commands.map((command) => command.name),
    VISIBLE,
  );
  const flags = (name: string): string[] => model.commands.find((command) => command.name === name)?.flags ?? [];
  assert.ok(['--all', '--status', '--json', '--dry-run'].every((flag) => flags('tasks').includes(flag)));
  assert.ok(flags('schedule').includes('--cron') && flags('add').includes('--priority'));
  assert.deepEqual(model.flagValues['--status'], ['backlog', 'todo', 'running', 'needs-me', 'done']);
  assert.deepEqual(model.flagValues['--priority'], ['urgent', 'high', 'normal', 'low']);
});

for (const shell of SHELLS) {
  test(`the ${shell} script names every visible command, no hidden one, and the values`, () => {
    const text = script(shell);
    assert.ok(text.length > 500);
    for (const name of VISIBLE) assert.ok(new RegExp(`\\b${name}\\b`).test(text), name);
    assert.ok(!/\binternal\b/.test(text), 'internal');
    assert.ok(text.includes('needs-me') && text.includes('urgent') && text.includes('pause'));
    assert.ok(text.includes('__complete'));
  });
}

function shellExists(shell: string): boolean {
  return spawnSync(shell, ['--version'], { stdio: 'ignore' }).status === 0;
}

test('the scripts are valid in their shell', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    const file = (shell: Shell): string => {
      const path = join(dir, shell);
      writeFileSync(path, script(shell));
      return path;
    };
    assert.equal(spawnSync('bash', ['-n', file('bash')]).status, 0, 'bash -n');
    if (shellExists('zsh')) assert.equal(spawnSync('zsh', ['-n', file('zsh')]).status, 0, 'zsh -n');
    else context.diagnostic('zsh is not installed; its script was not checked');
    if (shellExists('fish'))
      assert.equal(spawnSync('fish', ['--no-execute', file('fish')]).status, 0, 'fish --no-execute');
    else context.diagnostic('fish is not installed; its script was not checked');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// Runs the bash script with a stub `board` that answers __complete, and returns what it offers for a command line.
function bashOffers(line: string[], current: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    writeFileSync(join(dir, 'board.bash'), script('bash'));
    const words = [...line, current].map((word) => `'${word}'`).join(' ');
    const program = `
board() { if [ "$1" = __complete ] && [ "$2" = tasks ]; then printf 'Ab3dEf9x\\tFirst\\nZk7mNp2q\\tSecond\\n'; elif [ "$2" = schedules ]; then printf 'Sc1aBcDe\\tSweep\\n'; fi; }
source ${join(dir, 'board.bash')}
COMP_WORDS=(board ${words}); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1))
_board
printf '%s\\n' "\${COMPREPLY[@]}"`;
    const result = spawnSync('bash', ['-c', program], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter((entry) => entry !== '');
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('the bash script completes commands, task ids, statuses, priorities and schedule actions', () => {
  assert.ok(bashOffers([], 'ta').includes('tasks'));
  assert.ok(bashOffers([], 'tasks').length >= 1);
  assert.deepEqual(bashOffers(['show'], ''), ['Ab3dEf9x', 'Zk7mNp2q']);
  assert.deepEqual(bashOffers(['show'], 'Ab'), ['Ab3dEf9x']);
  assert.deepEqual(bashOffers(['move', 'Ab3dEf9x'], 'n'), ['needs-me']);
  assert.deepEqual(bashOffers(['tasks', '--status'], 'd'), ['done']);
  assert.deepEqual(bashOffers(['add', '--priority'], 'h'), ['high']);
  assert.deepEqual(bashOffers(['add', '--parent'], 'Z'), ['Zk7mNp2q']);
  assert.deepEqual(bashOffers(['schedules'], 'p'), ['pause']);
  assert.deepEqual(bashOffers(['schedules', 'rm'], ''), ['Sc1aBcDe']);
  assert.deepEqual(bashOffers(['schedules', '--dry-run', 'pause'], ''), ['Sc1aBcDe']);
  assert.deepEqual(bashOffers(['tasks'], '--st'), ['--status']);
  assert.deepEqual(bashOffers(['comment', 'Ab3dEf9x'], ''), [], 'the text after the task completes to nothing');
  assert.deepEqual(bashOffers(['help'], 'sched'), ['schedule', 'schedules']);
  assert.deepEqual(bashOffers(['completion'], 'z'), ['zsh']);
});

function completeContext(backend: ReturnType<typeof fakeBackend>): (dryRun: boolean) => Context {
  return () => ({ config: CONFIG, backend, dryRun: false, print: () => undefined });
}

test('__complete prints id and title per line, and nothing on any failure', async () => {
  const backend = fakeBackend([task({ id: 'Ab3dEf9x', title: 'Fix\tthe\nthing' })]);
  backend.schedules = [schedule({ id: 'Sc1aBcDe', title: 'Sweep' })];
  const out: string[] = [];
  const go = (argv: string[], options: Parameters<typeof runBoard>[1] = {}) =>
    runBoard(argv, { env: {}, context: completeContext(backend), writeOut: (text) => out.push(text), ...options });
  await go(['__complete', 'tasks']);
  await go(['__complete', 'schedules']);
  assert.deepEqual(out, ['Ab3dEf9x\tFix the thing\n', 'Sc1aBcDe\tSweep\n']);
  out.length = 0;
  await go(['__complete', 'tasks'], { env: { AGENT_BOARD_TASK: 'Zt0Test1' } });
  await go(['__complete', 'nothing']);
  await go(['__complete']);
  backend.listTasks = async () => {
    throw new Error('no network');
  };
  await go(['__complete', 'tasks']);
  await go(['__complete', 'tasks'], {
    context: () => {
      throw new Error('no config');
    },
  });
  assert.deepEqual(out, []);
});

test('__complete gives up after about two seconds', async () => {
  const backend = fakeBackend([]);
  backend.listTasks = () => new Promise(() => undefined);
  const out: string[] = [];
  const started = Date.now();
  await runBoard(['__complete', 'tasks'], {
    env: {},
    context: completeContext(backend),
    writeOut: (text) => out.push(text),
  });
  const took = Date.now() - started;
  assert.deepEqual(out, []);
  assert.ok(took >= 1900 && took < 4000, `took ${took} ms`);
});

test('board __complete exits 0 and prints nothing with an empty config dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    const bin = fileURLToPath(new URL('../bin/board', import.meta.url));
    const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = execFile(
        bin,
        ['__complete', 'tasks'],
        { env: { ...process.env, AGENT_BOARD_CONFIG_DIR: dir, AGENT_BOARD_TASK: '' } },
        (error, stdout) =>
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout }),
      );
      child.stdin?.end();
    });
    assert.deepEqual(result, { code: 0, stdout: '' });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('board completion rejects an unknown shell', async () => {
  await assert.rejects(
    runBoard(['completion', 'powershell'], { env: {} }),
    /'powershell' is invalid for argument 'shell'/,
  );
});
