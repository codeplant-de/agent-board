import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BATCH_EVENTS } from '@agent-board/shared';
import { runWorker } from '../src/worker.mts';
import type { RunResult, WorkerDeps } from '../src/worker.mts';
import { CONFIG, fakeBackend, fakeRunFiles, note, task } from './helpers.mts';

function setup(result: RunResult | Error, moveDuringRun = false) {
  // A task scheduled from /tmp on this machine.
  const running = task({ id: 'w1', status: 'running', input: '/selftest go', machine: 'here', workdir: '/tmp' });
  const backend = fakeBackend([running]);
  const notes: string[] = [];
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
    notify: async (_task, text) => void notes.push(text),
    resetLog: (shortLink) => void calls.push(`reset ${shortLink}`),
    appendLog: (shortLink, text) => void calls.push(`append ${shortLink}: ${text}`),
    pluginPath: () => '/plugins/pr-review',
    dirExists: () => true,
    settingsEnv: () => ({}),
    mcpServers: () => ({ config: { mcpServers: {} }, missing: [] }),
    home: '/h',
    newSessionId: () => 's-new',
    files: fakeRunFiles(),
    hookCommand: (dir, id) => `hook ${dir} ${id}`,
    now: () => new Date(),
    watchEveryMs: 10,
  };
  return { deps, backend, notes, calls };
}

test('non-zero exit reports the error and log tail', async () => {
  const { deps, backend, notes } = setup({ exitCode: 1, signal: null });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('exited with code 1') && w.includes('tail of log')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
  assert.equal(notes.length, 1);
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
  const { deps, backend, notes } = setup({ exitCode: 0, signal: null });
  deps.run = async () => {
    backend.tasks[0]!.status = 'todo';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(
    backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
    [],
  );
  assert.deepEqual(notes, []);
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
    const { deps, backend, notes } = setup(result);
    deps.run = async () => {
      backend.tasks[0]!.closed = true;
      return result;
    };
    await runWorker(deps, 'w1');
    assert.deepEqual(
      backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
      [],
    );
    assert.deepEqual(notes, []);
  }
});

test('a run another machine took over is left alone: no workdir, no failure', async () => {
  for (const result of [
    { exitCode: 0, signal: null },
    { exitCode: 1, signal: null },
  ]) {
    const { deps, backend, notes } = setup(result);
    backend.tasks[0]!.runStartedAt = new Date('2026-01-01T10:00:00Z');
    deps.run = async () => {
      deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
      // Taken back and claimed again: still Running, with the other run's start.
      backend.tasks[0]!.runStartedAt = new Date('2026-01-01T11:00:00Z');
      return result;
    };
    await runWorker(deps, 'w1');
    assert.ok(!backend.writes.some((w) => w.startsWith('workdir w1: /tmp/.claude') || w.startsWith('fail ')));
    assert.deepEqual(notes, []);
  }
});

test('a fresh skill run gets a new session, stored on the task before the run', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  const args: string[][] = [];
  deps.run = async (invocation) => {
    args.push(invocation.args);
    assert.ok(backend.writes.includes('session w1: s-new'), 'stored before the run');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(args[0]?.slice(0, 4), ['-p', '/selftest go', '--session-id', 's-new']);
});

test("a resume runs the stored session with the user's reply and uses the resume up", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: 's-old', machine: 'here' });
  backend.notes.set('w1', [
    note('Done, one question', new Date('2026-11-13T10:00:00Z')),
    note('please also check X', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  const args: string[][] = [];
  deps.run = async (invocation) => {
    args.push(invocation.args);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(args[0]?.[2], '--resume');
  assert.equal(args[0]?.[3], 's-old');
  assert.match(args[0]?.[1] ?? '', /please also check X/);
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

test("a resume starts in the task's directory, and a missing one fails without starting", async () => {
  const resumable = {
    next: 'resume' as const,
    sessionId: 's-old',
    machine: 'here',
    workdir: '/repo/.claude/worktrees/feat-x',
  };
  const { deps, backend } = setup({ exitCode: 0, signal: null });
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
    ['transcript w1 s-new tool_use', 'transcript w1 s-new tool_result,result'],
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
  assert.deepEqual(env, { CIRCLECI_TOKEN: 'ci-secret', AGENT_BOARD_TASK: 'w1' });
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
  assert.deepEqual(env, { AGENT_BOARD_TASK: 'w1' });
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
    ['session w1: s-new', 'session w1: null'],
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

test("a fresh run's prompt carries the user's message and points at the thread", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  backend.notes.set('w1', [
    note('Findings', new Date('2026-11-13T10:00:00Z')),
    note('now with the seed too', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.args[1] ?? '';
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
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: 's-old', paused: true });
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.args[1] ?? '';
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
    assert.deepEqual(sizes, [], 'the first batch was refused, nothing else went out');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(sizes, [MAX_BATCH_EVENTS, 10]);
});

test('a task whose prompt cannot be decrypted is reported, never run', async () => {
  const { deps, backend, notes } = setup({ exitCode: 0, signal: null });
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
  assert.equal(notes.length, 1);
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
