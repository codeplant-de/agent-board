import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BATCH_EVENTS } from '@agent-board/shared';
import type { Note, Task } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { START_MARKER } from '../dispatch/decide.mts';
import type { Invocation, Supervision } from '../dispatch/decide.mts';
import { runWorker } from './worker.mts';
import type { RunChannel, RunResult, Watch, WorkerDeps } from './worker.mts';
import {
  CONFIG,
  fakeBackend,
  fakeRunFiles,
  fakeSessions,
  note,
  OTHER_SESSION,
  SESSION,
  task,
} from '../__tests__/helpers/fakes.mts';

function setup(result: RunResult | Error, moveDuringRun = false) {
  // A task scheduled from /tmp on this machine.
  const running = task({
    id: 'w1',
    status: 'running',
    input: '/selftest go',
    machine: 'here',
    workdir: '/tmp',
    runStartedAt: new Date('2026-01-01T10:00:00Z'),
  });
  const backend = fakeBackend([running]);
  const calls: string[] = [];
  const deps: WorkerDeps = {
    backend,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    run: async () => {
      if (moveDuringRun) running.status = 'needs-me';
      if (result instanceof Error) throw result;
      return result;
    },
    logTail: () => 'tail of log',
    resetLog: (shortLink) => void calls.push(`reset ${shortLink}`),
    appendLog: (shortLink, text) => void calls.push(`append ${shortLink}: ${text}`),
    pluginPath: () => '/plugins/pr-review',
    dirExists: () => true,
    realpath: (path) => path,
    settingsEnv: () => ({}),
    mcpServers: () => ({ config: { mcpServers: {} }, missing: [] }),
    home: '/h',
    newSessionId: () => SESSION,
    sessions: fakeSessions(),
    files: fakeRunFiles(),
    hookCommand: (dir, id) => `hook ${dir} ${id}`,
    now: () => new Date(),
    watchEveryMs: 10,
  };
  return { deps, backend, calls };
}

// The calls to the board that a tick starts without waiting need a few turns of the event loop to finish.
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((done) => setImmediate(done));
};

test('non-zero exit reports the error and log tail', async () => {
  const { deps, backend } = setup({ exitCode: 1, signal: null });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('exited with code 1') && w.includes('tail of log')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
});

test('a run the watch stopped is reported with the reason', async () => {
  const { deps, backend } = setup({
    exitCode: null,
    signal: 'SIGTERM',
    stopped: { kind: 'stop', why: 'inactive', message: 'Stopped: the agent made no tool call for 15 minutes.' },
  });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('no tool call for 15 minutes')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
});

test('exit 0 with the task still in Running is reported as unreported', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('finished without reporting')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
});

test('exit 0 after the worker moved the task writes nothing', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  await runWorker(deps, 'w1');
  assert.deepEqual(
    backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
    [],
  );
});

test('a task the board hides from this CLI at the end of the run keeps its run files and is logged, not thrown', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  const cleared: string[] = [];
  deps.files = { ...deps.files, clear: (id) => void cleared.push(id) };
  const getTask = backend.getTask.bind(backend);
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  backend.getTask = async (id) => {
    if (ran) throw new BackendError('get-task: HTTP 422', 422, true);
    return getTask(id);
  };
  await runWorker(deps, 'w1');
  assert.ok(
    calls.some((line) => /does not know/.test(line)),
    calls.join('\n'),
  );
  assert.deepEqual(cleared, []);
});

test('a command that cannot start is reported on the task', async () => {
  const { deps, backend } = setup(new Error('could not start claude: ENOENT'));
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('could not start claude')));
});

test('the log is reset before anything else', async () => {
  const { deps, calls } = setup({ exitCode: 0, signal: null }, true);
  await runWorker(deps, 'w1');
  assert.equal(calls[0], 'reset w1');
});

test('exit 0 with the task already moved to Todo by a quick answer writes nothing', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.run = async () => {
    backend.tasks[0]!.status = 'todo';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(
    backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
    [],
  );
});

test('an unresolvable pr-review plugin sends the task to Needs me with the reason', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.config = { ...CONFIG, intake: { ...CONFIG.intake, allowedTools: ['Bash({pr-review}/skills/x.sh *)'] } };
  Object.assign(backend.tasks[0]!, {
    createdBy: 'intake',
    input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
  });
  deps.pluginPath = () => {
    throw new Error('plugin pr-review@ccc is not installed');
  };
  await runWorker(deps, 'w1');
  assert.ok(
    backend.writes.some((w) =>
      w.includes('Cannot resolve the pr-review plugin: plugin pr-review@ccc is not installed'),
    ),
  );
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
  assert.ok(calls.some((c) => c.startsWith('append w1:')));
});

test('a worker refuses an intake task on a machine without an intake block', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.config = { ...CONFIG, intakeEnabled: false };
  Object.assign(backend.tasks[0]!, {
    createdBy: 'intake',
    input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
  });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('no intake block')));
  assert.ok(calls.some((c) => c.startsWith('append w1:')));
});

test('a missing working directory is named in the error', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.dirExists = () => false;
  backend.tasks[0]!.workdir = '/no/such/dir';
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('/no/such/dir')));
});

test('a task closed during the run is left alone, whatever the outcome', async () => {
  for (const result of [
    { exitCode: 0, signal: null },
    { exitCode: 1, signal: null },
    { exitCode: null, signal: 'SIGTERM', timedOut: true },
  ]) {
    const { deps, backend } = setup(result);
    deps.run = async () => {
      backend.tasks[0]!.closed = true;
      return result;
    };
    await runWorker(deps, 'w1');
    assert.deepEqual(
      backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
      [],
    );
  }
});

test('a run another machine took over is left alone: no workdir, no failure', async () => {
  for (const result of [
    { exitCode: 0, signal: null },
    { exitCode: 1, signal: null },
  ]) {
    const { deps, backend } = setup(result);
    backend.tasks[0]!.runStartedAt = new Date('2026-01-01T10:00:00Z');
    deps.run = async () => {
      deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
      // Taken back and claimed again: still Running, with the other run's start.
      backend.tasks[0]!.runStartedAt = new Date('2026-01-01T11:00:00Z');
      return result;
    };
    await runWorker(deps, 'w1');
    assert.ok(!backend.writes.some((w) => w.startsWith('workdir w1: /tmp/.claude') || w.startsWith('fail ')));
  }
});

test('a fresh skill run gets a new session, stored on the task before the run', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  const runs: Invocation[] = [];
  deps.run = async (invocation) => {
    runs.push(invocation);
    assert.ok(backend.writes.includes(`session w1: ${SESSION}`), 'stored before the run');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(runs[0]?.args.slice(0, 2), ['-p', `--session-id=${SESSION}`]);
  assert.equal(runs[0]?.prompt, '/selftest go');
});

test("a resume runs the stored session with the user's reply and uses the resume up", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: SESSION, machine: 'here' });
  deps.sessions.record('w1', SESSION);
  backend.notes.set('w1', [
    note('Done, one question', new Date('2026-11-13T10:00:00Z')),
    note('please also check X', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  const runs: Invocation[] = [];
  deps.run = async (invocation) => {
    runs.push(invocation);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(runs[0]?.args[1], `--resume=${SESSION}`);
  assert.match(runs[0]?.prompt ?? '', /please also check X/);
  assert.ok(backend.writes.includes('next w1: fresh'));
  assert.ok(!backend.writes.some((w) => w.startsWith('session w1')));
});

test('a run asked to pause gives its task back to Todo with a note naming the lane', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { sessionId: 's' });
  deps.files.writeRun('w1', { lane: 'implement', borrowed: true, startedAt: new Date() });
  deps.run = async () => {
    deps.files.requestPause('w1');
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const pause = backend.writes.find((w) => w.startsWith('pause w1'));
  assert.match(pause ?? '', /Paused on here: its implement lane needed the slot/);
  assert.ok(!backend.writes.some((w) => w.includes('needs-me')));
  assert.equal(deps.files.readRun('w1'), undefined, 'the run files are cleared');
});

test("the watch passes liveness on with the run's lane and stops a quiet skill run", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.files.writeRun('w1', { lane: 'reviews', borrowed: true, startedAt: new Date() });
  let clock = Date.now();
  deps.now = () => new Date(clock);
  let decision: unknown;
  deps.run = async (_invocation, _taskId, _env, watch) => {
    clock += 20 * 60_000;
    decision = await watch.tick();
    return {
      exitCode: null,
      signal: 'SIGTERM',
      stopped: { kind: 'stop', why: 'inactive', message: 'Stopped: the agent made no tool call for 15 minutes.' },
    };
  };
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.includes('heartbeat w1 reviews borrowed'));
  assert.deepEqual(decision, {
    kind: 'stop',
    why: 'inactive',
    message: 'Stopped: the agent made no tool call for 15 minutes.',
  });
  assert.ok(backend.writes.some((w) => w.includes('no tool call for 15 minutes')));
});

test("the hook goes into a skill run's settings", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  let settings = '';
  deps.run = async (invocation) => {
    settings = invocation.args[invocation.args.indexOf('--settings') + 1] ?? '';
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(settings, /"command":"hook \/run\/test\/agent-board w1"/);
});

test('a fresh skill run binds the task to its directory, and to the worktree it ended in', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { machine: null, workdir: null });
  deps.run = async () => {
    deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const workdirs = backend.writes.filter((w) => w.startsWith('workdir w1'));
  assert.deepEqual(workdirs, ['workdir w1: /home/me', 'workdir w1: /tmp/.claude/worktrees/feat-x']);
});

test('a run that reported keeps the worktree it ended in, though the board dropped its runStartedAt', async () => {
  for (const status of ['needs-me', 'waiting', 'todo'] as const) {
    const { deps, backend } = setup({ exitCode: 0, signal: null });
    deps.run = async () => {
      deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
      backend.tasks[0]!.status = status;
      return { exitCode: 0, signal: null };
    };
    await runWorker(deps, 'w1');
    assert.deepEqual(
      backend.writes.filter((w) => w.startsWith('workdir w1')),
      ['workdir w1: /tmp/.claude/worktrees/feat-x'],
      status,
    );
    assert.ok(!backend.writes.some((w) => w.startsWith('fail ')), status);
  }
});

test("a resume starts in the task's directory, and a missing one fails without starting", async () => {
  const resumable = {
    next: 'resume' as const,
    sessionId: SESSION,
    machine: 'here',
    workdir: '/repo/.claude/worktrees/feat-x',
  };
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.sessions.record('w1', SESSION);
  Object.assign(backend.tasks[0]!, resumable);
  backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let cwd = '';
  deps.run = async (invocation) => {
    cwd = invocation.cwd;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(cwd, '/repo/.claude/worktrees/feat-x');

  const gone = setup({ exitCode: 0, signal: null });
  gone.deps.sessions.record('w1', SESSION);
  Object.assign(gone.backend.tasks[0]!, resumable);
  gone.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  gone.deps.dirExists = (path) => path !== '/repo/.claude/worktrees/feat-x';
  let started = false;
  gone.deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(gone.deps, 'w1');
  assert.equal(started, false);
  assert.ok(gone.backend.writes.some((w) => w.includes("task's directory is gone: /repo/.claude/worktrees/feat-x")));
});

test("the run's stream becomes readable log lines and a transcript sent with each check and at the end", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const logged: (string | undefined)[] = [];
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    logged.push(
      onLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        }),
      ),
    );
    await watch.tick();
    await settle();
    logged.push(
      onLine(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] },
        }),
      ),
    );
    logged.push(onLine(JSON.stringify({ type: 'result', result: 'All done', is_error: false })));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(logged, ['→ Bash: ls', undefined, 'All done']);
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('transcript')),
    [`transcript w1 ${SESSION} tool_use`, `transcript w1 ${SESSION} tool_result,result`],
  );
});

test('a transcript batch the board refused is sent again with the next one', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let failures = 1;
  const sent: string[] = [];
  backend.transcript = async (_id, batch) => {
    if (failures-- > 0) throw new Error('board down');
    sent.push(batch.events.map((e) => e.kind).join(','));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }));
    await watch.tick();
    await settle();
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(sent, ['text,text']);
});

test("an intake run gets the variables intake names from the checkout's settings, and nothing else", async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.config = { ...CONFIG, intake: { ...CONFIG.intake, env: ['CIRCLECI_TOKEN', 'SHORTCUT_API_TOKEN'] } };
  Object.assign(backend.tasks[0]!, {
    createdBy: 'intake',
    input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
    machine: null,
    workdir: null,
  });
  const read: string[] = [];
  deps.settingsEnv = (dir) => {
    read.push(dir);
    return { CIRCLECI_TOKEN: 'ci-secret', OTHER: 'not asked for' };
  };
  let env: Record<string, string> = {};
  deps.run = async (_invocation, _taskId, runEnv) => {
    env = runEnv;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(read, ['/work/cosuno']);
  assert.deepEqual(env, {
    CIRCLECI_TOKEN: 'ci-secret',
    AGENT_BOARD_TASK: 'w1',
    AGENT_BOARD_START_DIR: '/work/cosuno',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  });
  assert.ok(calls.some((c) => c.includes("not in the checkout's settings: SHORTCUT_API_TOKEN")));
  assert.ok(!calls.some((c) => c.includes('ci-secret')), 'values never reach the log');
});

test("a scheduled run loads the checkout's settings itself: no variables are copied", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.config = { ...CONFIG, intake: { ...CONFIG.intake, env: ['CIRCLECI_TOKEN'] } };
  let env: Record<string, string> = { unset: 'x' };
  deps.settingsEnv = () => ({ CIRCLECI_TOKEN: 'ci-secret' });
  deps.run = async (_invocation, _taskId, runEnv) => {
    env = runEnv;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(env, {
    AGENT_BOARD_TASK: 'w1',
    AGENT_BOARD_START_DIR: '/tmp',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  });
});

test("an intake run gets the MCP servers intake names from the checkout's .mcp.json", async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.config = { ...CONFIG, intake: { ...CONFIG.intake, mcpServers: ['shortcut', 'gone'] } };
  Object.assign(backend.tasks[0]!, {
    createdBy: 'intake',
    input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
    machine: null,
    workdir: null,
  });
  deps.mcpServers = (dir, names) => {
    assert.equal(dir, '/work/cosuno');
    assert.deepEqual(names, ['shortcut', 'gone']);
    return { config: { mcpServers: { shortcut: { type: 'http', url: 'https://mcp.example' } } }, missing: ['gone'] };
  };
  let args: string[] = [];
  deps.run = async (invocation) => {
    args = invocation.args;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(
    args[args.indexOf('--mcp-config') + 1],
    '{"mcpServers":{"shortcut":{"type":"http","url":"https://mcp.example"}}}',
  );
  assert.ok(calls.some((c) => c.includes("not in the checkout's .mcp.json: gone")));
});

test('a run that failed before it started leaves no session behind, and one that could not be spawned gives it back', async () => {
  const gone = setup({ exitCode: 0, signal: null });
  gone.deps.dirExists = () => false;
  await runWorker(gone.deps, 'w1');
  assert.ok(!gone.backend.writes.some((w) => w.startsWith('session w1')), 'the directory check failed first');

  const unplanned = setup({ exitCode: 0, signal: null });
  unplanned.backend.tasks[0]!.input = '  ';
  await runWorker(unplanned.deps, 'w1');
  assert.ok(!unplanned.backend.writes.some((w) => w.startsWith('session w1')), 'no prompt');

  const unspawned = setup(new Error('could not start claude: ENOENT'));
  await runWorker(unspawned.deps, 'w1');
  assert.deepEqual(
    unspawned.backend.writes.filter((w) => w.startsWith('session w1')),
    [`session w1: ${SESSION}`, 'session w1: null'],
  );
});

test("the agent's environment names the task, so `board schedule` can refuse inside a run", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let env: Record<string, string> = {};
  deps.run = async (_invocation, _taskId, runEnv) => {
    env = runEnv;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(env['AGENT_BOARD_TASK'], 'w1');
});

test('every run waits for background work: print mode would otherwise stop it 10 minutes after the last turn', async () => {
  for (const intake of [false, true]) {
    const { deps, backend } = setup({ exitCode: 0, signal: null });
    if (intake) {
      deps.config = {
        ...CONFIG,
        intake: { ...CONFIG.intake, env: ['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'AGENT_BOARD_TASK'] },
      };
      deps.settingsEnv = () => ({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '600000', AGENT_BOARD_TASK: 'other' });
      Object.assign(backend.tasks[0]!, {
        createdBy: 'intake',
        input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
      });
    }
    let env: Record<string, string> = {};
    deps.run = async (_invocation, _taskId, runEnv) => {
      env = runEnv;
      backend.tasks[0]!.status = 'needs-me';
      return { exitCode: 0, signal: null };
    };
    await runWorker(deps, 'w1');
    assert.equal(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'], '0');
    assert.equal(env['AGENT_BOARD_TASK'], 'w1');
  }
});

test("a fresh run's prompt carries the user's message and points at the thread", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  backend.notes.set('w1', [
    note('Findings', new Date('2026-11-13T10:00:00Z')),
    note('now with the seed too', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.prompt;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(
    prompt,
    /^\/selftest go\n\nThe user wrote on board task w1 since its last run started:\n\nnow with the seed too\n/,
  );
  assert.match(prompt, /run `board show w1` first/);
});

test("a worker that finds the task paused tells the agent, from the task's flag", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: SESSION, paused: true });
  deps.sessions.record('w1', SESSION);
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.prompt;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(prompt, /You were paused on board task w1/);
});

test('the upload still in flight when the run ends is awaited, then the rest is sent', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  backend.transcript = async (_id, batch) => {
    if (sent.length === 0) await gate;
    sent.push(batch.events.map((e) => e.kind).join(','));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }));
    void watch.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    onLine(JSON.stringify({ type: 'result', result: 'All done', is_error: false }));
    setTimeout(release, 10);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(sent, ['text', 'result']);
});

test("a backlog is sent in batches of at most the board's limit, and a refused one is retried", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const sizes: number[] = [];
  let failures = 1;
  backend.transcript = async (_id, batch) => {
    if (failures-- > 0) throw new Error('board down');
    sizes.push(batch.events.length);
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < MAX_BATCH_EVENTS + 10; n++)
      onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `t${n}` }] } }));
    await watch.tick();
    await settle();
    assert.deepEqual(sizes, [], 'the first batch was refused, nothing else went out');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(sizes, [MAX_BATCH_EVENTS, 10]);
});

test('a task whose prompt cannot be decrypted is reported, never run', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const [running] = backend.tasks;
  Object.assign(running!, { input: '', unreadable: ['input'] });
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(ran, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('input could not be decrypted')));
});

test('a run that fails before it starts clears the run files the dispatcher wrote', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { input: '', unreadable: ['input'] });
  const cleared: string[] = [];
  deps.files = { ...deps.files, clear: (id) => void cleared.push(id) };
  await runWorker(deps, 'w1');
  assert.deepEqual(cleared, ['w1']);
});

test('a task whose directory cannot be decrypted is not run in the default directory', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { workdir: null, unreadable: ['workdir'] });
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(ran, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('workdir could not be decrypted')));
});

test('an unreadable comment of the user stops the run; an unreadable title or agent note does not', async () => {
  const stopped = setup({ exitCode: 0, signal: null }, true);
  stopped.backend.notes.set('w1', [note('', new Date('2026-01-01T10:00:00Z'), { author: 'user', unreadable: true })]);
  let ran = false;
  stopped.deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(stopped.deps, 'w1');
  assert.equal(ran, false);
  assert.ok(stopped.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('could not be decrypted')));

  const fine = setup({ exitCode: 0, signal: null }, true);
  Object.assign(fine.backend.tasks[0]!, { unreadable: ['title'] });
  fine.backend.notes.set('w1', [note('', new Date('2026-01-01T10:00:00Z'), { author: 'agent', unreadable: true })]);
  await runWorker(fine.deps, 'w1');
  assert.ok(!fine.backend.writes.some((w) => w.startsWith('fail w1:')));
});

const HOSTILE_SESSION = '--dangerously-skip-permissions';

async function resumeOf(sessionId: string, known: string[] = []) {
  const run = setup({ exitCode: 0, signal: null });
  Object.assign(run.backend.tasks[0]!, { next: 'resume', sessionId, machine: 'here' });
  for (const session of known) run.deps.sessions.record('w1', session);
  run.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  const invocations: string[][] = [];
  run.deps.run = async (invocation) => {
    invocations.push(invocation.args);
    run.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(run.deps, 'w1');
  return { ...run, invocations };
}

test('a session id the board names that this machine did not start is never resumed (flag injection)', async () => {
  for (const hostile of [HOSTILE_SESSION, '-p', `${SESSION} --dangerously-skip-permissions`, OTHER_SESSION]) {
    const { invocations, backend } = await resumeOf(hostile, [SESSION]);
    assert.deepEqual(invocations, [], `${hostile} must not start claude`);
    const failure = backend.writes.find((w) => w.startsWith('fail w1:')) ?? '';
    assert.match(failure, /did not start for this task, so the run was not started/);
    assert.match(failure, /Re-run fresh/);
    assert.ok(!backend.writes.some((w) => w.startsWith('next w1')), 'the resume is not used up');
  }
});

test('a session this machine started for the task resumes, as one argument', async () => {
  const { invocations } = await resumeOf(SESSION.toUpperCase(), [SESSION]);
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0]!.includes(`--resume=${SESSION}`));
  assert.ok(!invocations[0]!.includes('--resume'));
});

test('a session recorded for another task is not this task’s', async () => {
  const run = setup({ exitCode: 0, signal: null });
  run.deps.sessions.record('other', SESSION);
  Object.assign(run.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, machine: 'here' });
  run.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let ran = false;
  run.deps.run = async () => ((ran = true), { exitCode: 0, signal: null });
  await runWorker(run.deps, 'w1');
  assert.equal(ran, false);
});

test('a fresh run records its session before it starts, so a later resume is allowed', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  deps.run = async () => {
    assert.ok(deps.sessions.has('w1', SESSION), 'recorded before the process starts');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(deps.sessions.has('w1', SESSION));
});

test('only the notes the run would hand the agent can stop it: an old unreadable note does not (unrunnable forever)', async () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 13, 10, minute));
  const unreadable = (minute: number) => note('', at(minute), { author: 'user', unreadable: true });
  const started = (minute: number) =>
    note(`${START_MARKER} ${at(minute).toISOString()} (x, here)`, at(minute), { author: 'system', kind: 'event' });
  const attempt = async (notes: ReturnType<typeof note>[], overrides: Partial<Task> = {}) => {
    const run = setup({ exitCode: 0, signal: null }, true);
    Object.assign(run.backend.tasks[0]!, { runStartedAt: at(30), ...overrides });
    run.deps.sessions.record('w1', SESSION);
    run.backend.notes.set('w1', notes);
    let ran = false;
    run.deps.run = async () => ((ran = true), { exitCode: 0, signal: null });
    await runWorker(run.deps, 'w1');
    return { ran, failure: run.backend.writes.find((w) => w.startsWith('fail w1:')) ?? '' };
  };
  // Fresh: an unreadable note written since the last run started would be handed over, so the run is refused, with advice.
  const refused = await attempt([started(1), unreadable(10)]);
  assert.equal(refused.ran, false);
  assert.match(refused.failure, /Re-run fresh: a fresh run starts after this attempt/);
  // Re-run fresh keeps the note, but the refused attempt left a start note behind it: the note is no longer handed over.
  assert.equal((await attempt([unreadable(10), started(20)])).ran, true);
  // Resume: the user's reply is what is handed over.
  const resume = { next: 'resume' as const, sessionId: SESSION, machine: 'here' };
  assert.equal((await attempt([note('Findings', at(5)), unreadable(10)], resume)).ran, false);
  assert.equal(
    (await attempt([unreadable(1), note('Findings', at(5)), note('go on', at(10), { author: 'user' })], resume)).ran,
    true,
  );
});

const textEvent = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('an event the board refuses for good is dropped alone, and never holds the transcript back (transcript stall)', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  const stored: string[] = [];
  backend.transcript = async (_id, batch) => {
    if (batch.events.some((event) => event.kind === 'text' && event.text === 'too big for the board'))
      throw new BackendError('transcript: event 2 is too long', 400);
    stored.push(...batch.events.map((event) => (event.kind === 'text' ? event.text : event.kind)));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (const text of ['a', 'b', 'too big for the board', 'c']) onLine(textEvent(text));
    await watch.tick();
    await settle();
    onLine(textEvent('d'));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(stored, ['a', 'b', 'c', 'd']);
  assert.ok(calls.some((c) => c.includes('transcript event 2 was refused and dropped')));
});

test('an event the board refused for a passing reason waits, in order, with everything after it', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const stored: string[] = [];
  let down = true;
  backend.transcript = async (_id, batch) => {
    if (down) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    stored.push(...batch.events.map((event) => (event.kind === 'text' ? event.text : event.kind)));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    onLine(textEvent('a'));
    await watch.tick();
    await settle();
    onLine(textEvent('b'));
    down = false;
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(stored, ['a', 'b']);
});

test('a worker refuses a task whose creator is an agent, as the board lists it as Todo (unstarted proposal)', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { createdBy: 'agent', input: 'rm -rf the world' });
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(ran, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('you have not started it')));
});

test('a session that a fresh run abandoned is not resumed, even when the board still names it (Re-run fresh)', async () => {
  const run = setup({ exitCode: 0, signal: null });
  Object.assign(run.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, machine: 'here' });
  run.deps.sessions.record('w1', SESSION);
  run.deps.sessions.record('w1', OTHER_SESSION);
  run.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let ran = false;
  run.deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(run.deps, 'w1');
  assert.equal(ran, false);
  assert.ok(run.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('did not start for this task')));
});

// The board is the other side of every call the worker makes: it may refuse, hold an answer for as long as the client waits, or
// answer slowly on purpose. None of that may keep the worker from checking the run's own limits.
function stalledRun(options: { quietSince: Date; now: Date }) {
  const run = setup({ exitCode: 0, signal: null });
  const { deps, backend } = run;
  deps.now = () => options.now;
  (deps.files as ReturnType<typeof fakeRunFiles>).touchAlive('w1', options.quietSince);
  const decisions: Supervision[] = [];
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < 1000; n += 1) onLine(textEvent(`t${n}`));
    decisions.push(await watch.tick());
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  return { ...run, decisions };
}

test('a board that never answers a transcript upload or a heartbeat cannot hold back the run’s limits (stalled supervision)', async () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const { deps, backend, decisions } = stalledRun({ quietSince: new Date(now.getTime() - 20 * 60_000), now });
  let uploads = 0;
  const never = new Promise<never>(() => undefined);
  backend.transcript = async () => {
    uploads += 1;
    return never;
  };
  backend.heartbeat = async () => never;
  // The run ends only when the test lets it; the hanging calls are still open then.
  const ended = Promise.race([
    runWorker(deps, 'w1').then(() => 'ended'),
    new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 300)),
  ]);
  assert.equal(
    await ended,
    'waiting',
    'the end of the run waits for the hanging upload, which is bounded in the real client',
  );
  assert.equal(decisions.length, 1, 'the tick answered without waiting for the board');
  assert.deepEqual(decisions[0], {
    kind: 'stop',
    why: 'inactive',
    message: 'Stopped: the agent made no tool call for 15 minutes.',
  });
  assert.equal(uploads, 1);
});

test('a board that refuses every transcript batch costs a bounded number of calls per pass, never the limits (2N-1 calls)', async () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const { deps, backend, decisions } = stalledRun({ quietSince: new Date(now.getTime() - 20 * 60_000), now });
  let calls = 0;
  backend.transcript = async () => {
    calls += 1;
    throw new BackendError('transcript: refused', 400);
  };
  let afterTick = -1;
  const inner = deps.run;
  deps.run = async (invocation, taskId, env, watch, onLine) => {
    const result = await inner(invocation, taskId, env, watch, onLine);
    await settle();
    afterTick = calls;
    return result;
  };
  await runWorker(deps, 'w1');
  assert.equal(decisions[0]?.kind, 'stop');
  assert.ok(afterTick >= 1 && afterTick <= 24, `${afterTick} calls in one pass`);
  assert.ok(calls <= 72, `${calls} calls in all, the end of the run with its two passes included`);
});

const toolPair = (n: number, output: string) => [
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: `step ${n}` } }] },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: output }] },
  }),
];

test('a backlog past its byte budget loses the oldest tool outputs first, and the transcript says so', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.maxPendingBytes = 5_000;
  const stored: { kind: string; output?: string; text?: string }[] = [];
  let down = true;
  backend.transcript = async (_id, batch) => {
    if (down) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    stored.push(...batch.events);
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < 6; n++) for (const line of toolPair(n, `output ${n} ${'x'.repeat(1_000)}`)) onLine(line);
    await watch.tick();
    await settle();
    down = false;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const results = stored.filter((event) => event.kind === 'tool_result');
  assert.equal(results.length, 6, 'every tool result is still there, in order');
  assert.equal(results[0]?.output, '', 'the oldest output went first');
  assert.match(results.at(-1)?.output ?? '', /^output 5 /, 'the newest output is kept');
  assert.equal(stored.filter((event) => event.kind === 'tool_use').length, 6);
  const notes = stored.filter((event) => event.kind === 'note');
  assert.ok(notes.length >= 1, 'a note says that outputs were dropped');
  for (const note of notes)
    assert.match(note.text ?? '', /\d+ tool outputs of this run were dropped from the transcript/);
});

test('a backlog that outgrows its budget even without outputs drops its oldest events, and notes it', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.maxPendingBytes = 2_000;
  const stored: { kind: string; text?: string }[] = [];
  let down = true;
  backend.transcript = async (_id, batch) => {
    if (down) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    stored.push(...batch.events);
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < 30; n++) onLine(textEvent(`event ${n} ${'y'.repeat(200)}`));
    await watch.tick();
    await settle();
    down = false;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const texts = stored.filter((event) => event.kind === 'text').map((event) => event.text ?? '');
  assert.ok(texts.length > 0 && texts.length < 30, `${texts.length} events kept`);
  assert.match(texts.at(-1) ?? '', /^event 29 /, 'the newest events are the ones kept');
  assert.match(stored.find((event) => event.kind === 'note')?.text ?? '', /\d+ events of this run were dropped/);
});

test('the end of the run makes a second pass over what the first left', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let calls = 0;
  const sent: string[] = [];
  backend.transcript = async (_id, batch) => {
    calls += 1;
    if (calls === 1) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    sent.push(...batch.events.map((event) => (event.kind === 'text' ? event.text : event.kind)));
  };
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(textEvent('a'));
    onLine(textEvent('b'));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(calls, 2);
  assert.deepEqual(sent, ['a', 'b']);
});

// A running agent's stdin, recorded.
function fakeChannel() {
  const calls: string[] = [];
  const sent: string[] = [];
  let open = true;
  const channel: RunChannel = {
    get open() {
      return open;
    },
    send(text) {
      if (!open) return false;
      sent.push(text);
      calls.push('send');
      return true;
    },
    interrupt() {
      if (open) calls.push('interrupt');
    },
    end() {
      if (open) calls.push('end');
      open = false;
    },
    stop() {
      if (open) calls.push('interrupt', 'end');
      open = false;
    },
  };
  return { channel, calls, sent };
}

const userMessage = (text: string, overrides: Partial<Note> = {}): Note =>
  note(text, new Date('2026-01-01T10:05:00Z'), { author: 'user', pending: true, ...overrides });

// Runs the worker with a process that stays for `during`, which gets the watch and the agent's channel.
async function runWith(
  during: (input: {
    watch: Watch;
    channel: ReturnType<typeof fakeChannel>;
    backend: ReturnType<typeof setup>['backend'];
    deps: WorkerDeps;
  }) => Promise<void>,
  result: RunResult = { exitCode: 0, signal: null },
) {
  const harness = setup(result);
  const channel = fakeChannel();
  harness.deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    await during({ watch, channel, backend: harness.backend, deps: harness.deps });
    return result;
  };
  await runWorker(harness.deps, 'w1');
  return { ...harness, channel };
}

test('a pause request is told to the agent as a message, once, and an agent that ignores it is interrupted after the grace', async () => {
  const decisions: Supervision[] = [];
  let clock = Date.now();
  const { channel, backend } = await runWith(async ({ watch, channel, deps }) => {
    deps.now = () => new Date(clock);
    deps.files.writeRun('w1', { lane: 'implement', borrowed: true, startedAt: new Date(clock) });
    deps.files.touchAlive('w1', new Date(clock));
    deps.files.requestPause('w1');
    decisions.push(await watch.tick());
    decisions.push(await watch.tick());
    assert.equal(channel.sent.length, 1);
    clock += 3 * 60_000;
    deps.files.touchAlive('w1', new Date(clock));
    decisions.push(await watch.tick());
  });
  assert.match(channel.sent[0] ?? '', /Pause requested.*board comment w1 "\.\.\."/);
  assert.deepEqual(
    decisions.map((decision) => decision.kind),
    ['continue', 'continue', 'stop'],
  );
  assert.ok(decisions[2]?.kind === 'stop' && decisions[2].why === 'pause-forced');
  assert.ok(backend.writes.some((w) => w.startsWith('pause w1')));
});

test('the pause message is not sent into a closed stdin', async () => {
  const { channel } = await runWith(async ({ watch, channel, deps }) => {
    channel.channel.end();
    deps.files.requestPause('w1');
    await watch.tick();
  });
  assert.deepEqual(channel.sent, []);
});

test("a message of the user's reaches the running agent without interrupting it, and is acknowledged", async () => {
  const message = userMessage('also check the migration');
  const { channel, backend } = await runWith(async ({ watch, channel, backend }) => {
    backend.inboxes.set('w1', { stop: false, messages: [message] });
    await watch.tick();
    await settle();
    assert.equal(channel.sent.length, 1);
  });
  assert.deepEqual(channel.calls, ['send']);
  assert.match(
    channel.sent[0] ?? '',
    /sent you a message on board task w1 while you work:\n\nalso check the migration/,
  );
  assert.ok(backend.writes.includes(`ack w1: ${message.id}`));
});

test('a change the board announces makes the worker look at its inbox at once', async () => {
  const message = userMessage('go on');
  let announce: (() => void) | undefined;
  let listening = true;
  const harness = setup({ exitCode: 0, signal: null });
  const channel = fakeChannel();
  harness.deps.watchChanges = (onChange) => {
    announce = onChange;
    return () => {
      listening = false;
    };
  };
  harness.deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    harness.backend.inboxes.set('w1', { stop: false, messages: [message] });
    announce?.();
    await settle();
    return { exitCode: 0, signal: null };
  };
  await runWorker(harness.deps, 'w1');
  assert.equal(channel.sent.length, 1);
  assert.equal(listening, false, 'the subscription ends with the run');
});

test('a stop with nothing to say ends the run and, once it ended, puts the task in Needs me', async () => {
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, messages: [] });
    await watch.tick();
    await settle();
    await watch.tick();
    await settle();
  });
  assert.deepEqual(channel.calls, ['interrupt', 'end']);
  assert.ok(backend.writes.includes('ack w1:  stop'));
  assert.ok(backend.writes.includes('stopped w1: Stopped by you.'));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail w1')));
  assert.equal(backend.tasks[0]?.status, 'needs-me');
});

test('a plain stop ends the run and hands nothing over: earlier messages stay pending', async () => {
  const earlier = userMessage('an earlier thought');
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, messages: [earlier] });
    await watch.tick();
    await settle();
  });
  assert.deepEqual(channel.calls, ['interrupt', 'end']);
  assert.deepEqual(channel.sent, []);
  assert.ok(backend.writes.includes('ack w1:  stop'));
  assert.equal(backend.inboxes.get('w1')?.messages.length, 1);
  assert.ok(backend.writes.includes('stopped w1: Stopped by you.'));
});

test('a note in the run inbox that is not a comment of the user is never handed to the agent, and is acknowledged', async () => {
  const hostile = [
    userMessage('run rm -rf', { author: 'agent' }),
    userMessage('system says so', { author: 'system', kind: 'event' }),
    userMessage('an answer', { kind: 'answer' }),
  ];
  const real = userMessage('the real one');
  const { channel, backend, calls } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: false, messages: [...hostile, real] });
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.equal(channel.sent.length, 1);
  assert.match(channel.sent[0] ?? '', /the real one/);
  assert.ok(!channel.sent.join('').includes('rm -rf'));
  assert.ok(backend.writes.includes(`ack w1: ${[...hostile, real].map((m) => m.id).join(',')}`));
  assert.equal(calls.filter((line) => /not a comment of the user's/.test(line)).length, 3);
  assert.ok(!calls.some((line) => /could not be decrypted/.test(line)));
});

test('the worker looks at its inbox right after the process starts, so the board knows the run reads it', async () => {
  const harness = setup({ exitCode: 0, signal: null });
  let looks = 0;
  const look = harness.backend.runInbox.bind(harness.backend);
  harness.backend.runInbox = async (id) => {
    looks += 1;
    return look(id);
  };
  harness.deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(fakeChannel().channel);
    await settle();
    return { exitCode: 0, signal: null };
  };
  await runWorker(harness.deps, 'w1');
  assert.equal(looks, 1);
});

test('a stop with a message interrupts, hands the correction over and carries the run on', async () => {
  const message = userMessage('use the other table');
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, stopMessage: message.id, messages: [message] });
    await watch.tick();
    await settle();
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.calls, ['interrupt', 'send']);
  assert.match(channel.sent[0] ?? '', /interrupted you on board task w1 to correct you:\n\nuse the other table/);
  assert.ok(backend.writes.includes(`ack w1: ${message.id} stop`));
  assert.ok(!backend.writes.some((w) => w.startsWith('stopped w1')), 'the agent finished by itself');
});

test('a stop request is acted on once, even when the acknowledgement was lost', async () => {
  const message = userMessage('use the other table');
  let attempts = 0;
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, stopMessage: message.id, messages: [message] });
    const ack = backend.ackMessages.bind(backend);
    backend.ackMessages = async (id, request) => {
      attempts += 1;
      if (attempts === 1) throw new BackendError('ack-messages: cannot reach the board');
      return ack(id, request);
    };
    for (let round = 0; round < 3; round += 1) {
      await watch.tick();
      await settle();
    }
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.calls, ['interrupt', 'send'], 'one interrupt and one delivery');
  assert.equal(attempts, 2);
  assert.ok(backend.writes.includes(`ack w1: ${message.id} stop`));
});

test('nothing is handed over once the run ended its stdin; the message stays pending', async () => {
  const { channel, backend } = await runWith(async ({ watch, channel, backend }) => {
    channel.channel.end();
    backend.inboxes.set('w1', { stop: false, messages: [userMessage('too late')] });
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.sent, []);
  assert.ok(!backend.writes.some((w) => w.startsWith('ack ')));
  assert.equal(backend.inboxes.get('w1')?.messages.length, 1);
});

test('a message that cannot be decrypted is not handed over, and is acknowledged so it does not come back', async () => {
  const unreadable = userMessage('', { unreadable: true });
  const { channel, backend, calls } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: false, messages: [unreadable] });
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.sent, []);
  assert.ok(backend.writes.includes(`ack w1: ${unreadable.id}`));
  assert.ok(calls.some((line) => /could not be decrypted.*acknowledged/.test(line)));
});

test('a board without the run inbox is left alone for the rest of the run', async () => {
  let looks = 0;
  const { calls, channel } = await runWith(async ({ watch, backend }) => {
    backend.runInbox = async () => {
      looks += 1;
      const error = new BackendError('the board server does not support messages yet');
      error.missingFeature = 'run-inbox';
      throw error;
    };
    await watch.tick();
    await settle();
    await watch.tick();
    await settle();
  });
  assert.equal(looks, 1);
  assert.deepEqual(channel.calls, []);
  assert.ok(calls.some((line) => /no run inbox/.test(line)));
});

test('the resume prompt of a run leaves out what the agent was handed while it ran', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.sessions = fakeSessions([['w1', SESSION]]);
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: SESSION });
  backend.notes.set('w1', [
    note('earlier', new Date('2026-01-01T09:00:00Z'), { author: 'agent' }),
    note('handed over mid-run', new Date('2026-01-01T09:10:00Z'), {
      author: 'user',
      deliveredAt: new Date('2026-01-01T09:11:00Z'),
    }),
    note('said after the stop', new Date('2026-01-01T09:20:00Z'), { author: 'user' }),
  ]);
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.prompt;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(prompt, /said after the stop/);
  assert.doesNotMatch(prompt, /handed over mid-run/);
});

// Enforcement: config.json has a `dirs` list.
const withDirs = (deps: WorkerDeps, ...dirs: string[]): void => {
  deps.config = { ...CONFIG, dirs: dirs.map((path) => ({ path })) };
};

test('a run in a listed directory, or below one, starts as before', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/tmp');
  deps.run = async () => {
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  backend.tasks[0]!.workdir = '/tmp/sub';
  await runWorker(deps, 'w1');
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('a task in a directory outside the list is refused with the reason, and the agent never starts', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  let started = false;
  deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(started, false);
  assert.ok(
    backend.writes.some(
      (w) =>
        w.startsWith('fail w1:') &&
        w.includes('/tmp is not a listed directory on here') &&
        w.includes('board dirs add') &&
        w.includes('Re-run fresh'),
    ),
  );
  assert.ok(!backend.writes.some((w) => w.startsWith('workdir ')));
});

test('an empty list refuses every start; no list at all changes nothing', async () => {
  const empty = setup({ exitCode: 0, signal: null });
  withDirs(empty.deps);
  await runWorker(empty.deps, 'w1');
  assert.ok(empty.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('not a listed directory')));

  const none = setup({ exitCode: 0, signal: null });
  await runWorker(none.deps, 'w1');
  assert.ok(!none.backend.writes.some((w) => w.includes('not a listed directory')));
});

test('a missing directory keeps its own message even when it is not listed either', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  deps.dirExists = () => false;
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('directory is gone')));
  assert.ok(!backend.writes.some((w) => w.includes('not a listed directory')));
});

test('a symlink inside a listed directory that points outside is refused, and a listed link is followed', async () => {
  const links: Record<string, string> = { '/srv/app/out': '/etc', '/home/me/alias': '/srv/app' };
  const realpath = (path: string): string => links[path] ?? path;
  const outside = setup({ exitCode: 0, signal: null });
  withDirs(outside.deps, '/srv/app');
  outside.deps.realpath = realpath;
  outside.backend.tasks[0]!.workdir = '/srv/app/out';
  await runWorker(outside.deps, 'w1');
  assert.ok(outside.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('not a listed directory')));

  const listed = setup({ exitCode: 0, signal: null });
  withDirs(listed.deps, '/home/me/alias');
  listed.deps.realpath = realpath;
  listed.backend.tasks[0]!.workdir = '/srv/app';
  await runWorker(listed.deps, 'w1');
  assert.ok(!listed.backend.writes.some((w) => w.includes('not a listed directory')));
});

test('a form task routed to the default directory is refused when that is not listed', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  Object.assign(backend.tasks[0]!, { machine: null, workdir: null });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('/home/me is not a listed directory')));
});

test('a resume in a workdir that left the list is refused, not started', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  Object.assign(backend.tasks[0]!, {
    next: 'resume',
    sessionId: SESSION,
    workdir: '/repo/.claude/worktrees/feat-x',
  });
  deps.sessions.record('w1', SESSION);
  backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let started = false;
  deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(started, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('feat-x is not a listed directory')));
});

test('an intake review whose checkout is not listed is refused, and the message names the repos checkout', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  deps.config = { ...deps.config, repos: { 'cosuno/cosuno': '/srv/cosuno' } };
  Object.assign(backend.tasks[0]!, {
    createdBy: 'intake',
    machine: null,
    workdir: null,
    input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
  });
  await runWorker(deps, 'w1');
  assert.ok(
    backend.writes.some(
      (w) => w.startsWith('fail w1:') && w.includes('/srv/cosuno is not a listed directory') && w.includes('repos'),
    ),
  );
});

test('a run that ends outside the list keeps its directory and leaves a system note', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/tmp');
  deps.run = async () => {
    deps.files.writeCwd('w1', '/var/elsewhere');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(!backend.writes.some((w) => w.startsWith('workdir ')));
  const noted = backend.writes.find((w) => w.startsWith('note w1 (system):'));
  assert.ok(noted?.includes('/var/elsewhere') && noted.includes('not a listed directory') && noted.includes('/tmp'));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('a note that cannot be added does not lose the run, and an end inside the list is stored', async () => {
  const failing = setup({ exitCode: 0, signal: null });
  withDirs(failing.deps, '/tmp');
  failing.deps.run = async () => {
    failing.deps.files.writeCwd('w1', '/var/elsewhere');
    failing.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  failing.backend.addNote = async () => {
    throw new Error('board down');
  };
  await runWorker(failing.deps, 'w1');
  assert.ok(failing.calls.some((c) => c.includes('could not add the note: board down')));
  assert.ok(!failing.backend.writes.some((w) => w.startsWith('fail ')));

  const inside = setup({ exitCode: 0, signal: null });
  withDirs(inside.deps, '/tmp');
  inside.deps.run = async () => {
    inside.deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
    inside.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(inside.deps, 'w1');
  assert.deepEqual(
    inside.backend.writes.filter((w) => w.startsWith('workdir w1')),
    ['workdir w1: /tmp/.claude/worktrees/feat-x'],
  );
});
