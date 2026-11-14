import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boardRules,
  buildInvocation,
  ownLane,
  decideOutcome,
  isPermanentRefusal,
  isRunOver,
  decideStale,
  expandRule,
  pluginPlaceholders,
  planPauses,
  planStarts,
  supervise,
  notServableHere,
  planRun,
  freshThreadBlock,
  splitBatches,
  START_MARKER,
} from '../src/decide.mts';
import type { LaneRun } from '../src/decide.mts';
import { MAX_BATCH_EVENTS } from '@agent-board/shared';
import { BackendError } from '../src/backend.mts';
import type { TranscriptEvent } from '@agent-board/shared';
import { tail } from '../src/text.mts';
import { CONFIG, note as makeNote, OTHER_SESSION, SESSION, task } from './helpers.mts';

// What a worker knows of this machine's sessions: by default, every session it is asked for is its own.
const options = (newSession = OTHER_SESSION, own = true) => ({
  newSessionId: () => newSession,
  isOwnSession: () => own,
});

const FRESH = { kind: 'fresh', sessionId: SESSION } as const;
const PR = 'https://github.com/cosuno/cosuno/pull/17741';
const invoke = (
  overrides: Parameters<typeof task>[0],
  run: Parameters<typeof buildInvocation>[0]['run'] = FRESH,
  laneCwd?: string,
) =>
  buildInvocation({
    run,
    task: task(overrides),
    repos: CONFIG.repos,
    defaultCwd: CONFIG.defaultCwd,
    intake: CONFIG.intake,
    laneCwd,
    home: '/h',
    pluginRoots: { 'pr-review': '/plugins/pr' },
    hookCommand: "'/x/agent-hook' '/run/ab' abc",
  });

test('a scheduled task runs its prompt as written, in its directory, as the user in auto mode', () => {
  const plan = invoke({ id: 'abc', input: '/review-pr 17741 --fresh', machine: 'here', workdir: '/work/cosuno' });
  assert.ok(plan.ok);
  const { args, cwd, prompt } = plan.invocation;
  assert.equal(prompt, '/review-pr 17741 --fresh');
  assert.deepEqual(args.slice(0, 2), ['-p', `--session-id=${SESSION}`]);
  assert.equal(cwd, '/work/cosuno');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!args.includes('--setting-sources'), "all of the user's settings load");
  assert.ok(!args.includes('--allowedTools'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 3), [
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
  assert.match(args[args.indexOf('--append-system-prompt') + 1] ?? '', /agent-board task abc/);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
  assert.deepEqual(settings, {
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "'/x/agent-hook' '/run/ab' abc" }] }] },
  });
});

test('a task without a directory runs in the default one', () => {
  const plan = invoke({ id: 'abc', input: 'Find out why the export is slow' });
  assert.ok(plan.ok);
  assert.equal(plan.invocation.cwd, '/home/me');
  assert.ok(!invoke({ id: 'abc', input: '  ' }).ok, 'an empty prompt is refused');
});

test("an intake review runs in the PR's checkout with intake's narrow rules", () => {
  const plan = invoke({
    id: 'abc',
    input: `/review-pr ${PR} --auto`,
    head: '56120dc60b',
    createdBy: 'intake',
    workdir: '/stale/dir',
  });
  assert.ok(plan.ok);
  const { args, cwd, prompt } = plan.invocation;
  assert.equal(prompt, `/review-pr ${PR} --auto`);
  assert.equal(cwd, '/work/cosuno', 'a fresh intake run goes back to the checkout');
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 4), [
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')), [
    'Read',
    'Bash(board comment *)',
  ]);
  const unmapped = invoke({
    id: 'abc',
    input: '/review-pr https://github.com/other/repo/pull/2 --auto',
    createdBy: 'intake',
  });
  assert.ok(!unmapped.ok && /other\/repo/.test(unmapped.reason));
});

test('a resume passes the reply and continues where the session stopped', () => {
  const plan = invoke(
    { id: 'abc', input: '/grill', workdir: '/repo/.claude/worktrees/x' },
    { kind: 'resume', sessionId: SESSION, prompt: 'the reply' },
  );
  assert.ok(plan.ok);
  assert.equal(plan.invocation.prompt, 'the reply');
  assert.deepEqual(plan.invocation.args.slice(0, 2), ['-p', `--resume=${SESSION}`]);
  assert.equal(plan.invocation.cwd, '/repo/.claude/worktrees/x');
});

test('intake rules naming a plugin need its path', () => {
  const plan = buildInvocation({
    run: FRESH,
    task: task({ id: 'a', input: PR, createdBy: 'intake' }),
    repos: CONFIG.repos,
    defaultCwd: '/',
    intake: { ...CONFIG.intake, allowedTools: ['Bash({pr-review}/x.sh *)', 'Bash({engineering}/y.sh *)'] },
    home: '/h',
    pluginRoots: { 'pr-review': '/p' },
  });
  assert.ok(!plan.ok && /plugin engineering is unknown/.test(plan.reason));
});

test("a task without a directory runs in the checkout of the PR its prompt names, else in its lane's directory", () => {
  const byPr = invoke({ id: 'a', input: `/review-pr ${PR}` }, FRESH, '/lane/dir');
  assert.ok(byPr.ok && byPr.invocation.cwd === '/work/cosuno');
  const byLane = invoke({ id: 'a', input: '/review-pr 17741' }, FRESH, '/lane/dir');
  assert.ok(byLane.ok && byLane.invocation.cwd === '/lane/dir');
  const pinned = invoke(
    { id: 'a', input: `/review-pr ${PR}`, workdir: '/own/dir', machine: 'here' },
    FRESH,
    '/lane/dir',
  );
  assert.ok(pinned.ok && pinned.invocation.cwd === '/own/dir', "a task's own directory wins");
});

test("a prompt's skill picks its lane; anything else goes to the lane with *", () => {
  const lanes = [
    { name: 'reviews', skills: ['review-pr'], slots: 2 },
    { name: 'general', skills: ['*'], slots: 3 },
  ];
  assert.equal(ownLane(task({ id: 'a', input: '/review-pr 17741' }), lanes), 'reviews');
  assert.equal(ownLane(task({ id: 'a', input: '/pr-review:review-pr 17741' }), lanes), 'reviews');
  assert.equal(ownLane(task({ id: 'a', input: '/grill this plan' }), lanes), 'general');
  assert.equal(ownLane(task({ id: 'a', input: 'Find out X' }), lanes), 'general');
  assert.equal(ownLane(task({ id: 'a', input: 'Find out X' }), [lanes[0]!]), undefined);
});

test("a machine leaves a task to another when it is pinned there or lacks the PR's checkout", () => {
  const here = (overrides: Parameters<typeof task>[0]) => notServableHere(task(overrides), 'here', CONFIG.repos);
  assert.equal(here({ id: 'a', input: 'Find out X' }), undefined);
  assert.match(here({ id: 'a', input: '/grill', machine: 'there', workdir: '/x' }) ?? '', /pinned to there/);
  assert.equal(here({ id: 'a', input: '/grill', machine: 'here', workdir: '/x' }), undefined);
  assert.match(
    here({ id: 'a', input: '/grill', next: 'resume', sessionId: SESSION, machine: 'there' }) ?? '',
    /pinned to there/,
  );
  assert.equal(
    here({ id: 'a', input: `/review-pr ${PR} --auto`, createdBy: 'intake', machine: 'there', workdir: '/w' }),
    undefined,
    'an intake task runs on any machine with the checkout',
  );
  assert.match(
    here({ id: 'a', input: '/review-pr https://github.com/other/repo/pull/2 --auto', createdBy: 'intake' }) ?? '',
    /no checkout of other\/repo/,
  );
});

test("the board's rules tell the agent to attach the user's likely next reply to its final comment", () => {
  assert.match(
    boardRules(task({ id: 'abc' })),
    /board comment --suggest "<reply>" abc "<summary>".*Skip it when no single reply is obvious/s,
  );
});

test("the board's rules tell the agent to ask through the board, and an intake run to keep its commands simple", () => {
  assert.match(
    boardRules(task({ id: 'abc' })),
    /AskUserQuestion is not available.*board ask abc --file \/tmp\/pr-abc-questions\.json/s,
  );
  assert.doesNotMatch(boardRules(task({ id: 'abc' })), /stands alone/);
  assert.match(
    boardRules(task({ id: 'abc', createdBy: 'intake' })),
    /run every Bash command on its own, without pipes/,
  );
});

test("the board's rules tell the agent not to end its turn while background work runs", () => {
  assert.match(boardRules(task({ id: 'abc' })), /Do not end your turn while a background agent .* in the foreground/s);
});

test('long text is tailed', () => {
  assert.equal(tail('abcdef', 4), '…def');
});

test("{<plugin>} expands to the plugin's root in Bash rules; ~/ only in Bash rules", () => {
  const roots = { 'pr-review': '/plugins/pr', engineering: '/plugins/eng' };
  assert.equal(expandRule('Bash({pr-review}/skills/x.sh *)', '/h', roots), 'Bash(/plugins/pr/skills/x.sh *)');
  assert.equal(
    expandRule('Bash({engineering}/skills/circleci-reference/cci.sh *)', '/h', roots),
    'Bash(/plugins/eng/skills/circleci-reference/cci.sh *)',
  );
  assert.equal(expandRule('Bash(~/bin/tool *)', '/h', {}), 'Bash(/h/bin/tool *)');
  assert.equal(expandRule('Read(~/.config/**)', '/h', roots), 'Read(~/.config/**)');
  assert.deepEqual(
    pluginPlaceholders(['Bash({pr-review}/a *)', 'Bash({engineering}/b *)', 'Bash({pr-review}/c *)', 'Read(x)']),
    ['pr-review', 'engineering'],
  );
});

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 13, 10, minute));
const questionNote = makeNote('', at(1), {
  kind: 'question',
  questions: [
    {
      header: 'Scope',
      question: 'Review the migration?',
      multiSelect: false,
      options: [
        { label: 'Yes', description: '' },
        { label: 'No', description: '' },
      ],
    },
  ],
});

test('a resume carries the answers and comments given since the agent last spoke', () => {
  const notes = [
    makeNote('earlier user note', at(0), { author: 'user' }),
    questionNote,
    makeNote('agent-board: started', at(2), { author: 'system' }),
    makeNote('also check the seed', at(3), {
      author: 'user',
      kind: 'answer',
      questionNoteId: questionNote.id,
      questions: questionNote.questions,
      answers: [{ selected: ['Yes'] }],
    }),
    makeNote('and keep it short', at(4), { author: 'user' }),
  ];
  const plan = planRun(task({ id: 'abc', next: 'resume', sessionId: SESSION }), notes, options(OTHER_SESSION));
  assert.equal(plan.kind, 'resume');
  assert.ok(plan.kind === 'resume');
  assert.equal(plan.sessionId, SESSION);
  assert.match(plan.prompt, /Scope: Review the migration\? → Yes/);
  assert.match(plan.prompt, /also check the seed/);
  assert.match(plan.prompt, /and keep it short/);
  assert.doesNotMatch(plan.prompt, /earlier user note/);
  assert.match(plan.prompt, /board's rules from the start of this session still hold/);
});

test('a run starts fresh without a resume request, without a session, or without a reply', () => {
  const reply = [questionNote, makeNote('go on', at(2), { author: 'user' })];
  const sessionOf = (plan: ReturnType<typeof planRun>) =>
    `${plan.kind}:${plan.kind === 'blocked' ? plan.reason : plan.sessionId}`;
  assert.equal(
    sessionOf(planRun(task({ id: 'a', next: 'fresh', sessionId: SESSION }), reply, options())),
    `fresh:${OTHER_SESSION}`,
  );
  assert.equal(
    sessionOf(planRun(task({ id: 'a', next: 'resume', sessionId: null }), reply, options())),
    `fresh:${OTHER_SESSION}`,
  );
  assert.equal(
    sessionOf(planRun(task({ id: 'a', next: 'resume', sessionId: SESSION }), [questionNote], options())),
    `fresh:${OTHER_SESSION}`,
  );
});

const NOW = new Date('2026-01-01T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const LIMITS = { inactivityMinutes: 15, maxRunHours: 6 };

test('stale: a gone unit at once; an active one only past the limits plus grace', () => {
  const gone = decideStale({ unitActive: false, startedAt: NOW, lastActive: undefined, now: NOW, limits: LIMITS });
  assert.equal(gone.stale && !gone.stopUnit, true);
  assert.equal(
    decideStale({ unitActive: true, startedAt: ago(300), lastActive: ago(19), now: NOW, limits: LIMITS }).stale,
    false,
  );
  const quiet = decideStale({ unitActive: true, startedAt: ago(300), lastActive: ago(21), now: NOW, limits: LIMITS });
  assert.equal(quiet.stale && quiet.stopUnit, true);
  assert.equal(
    decideStale({ unitActive: true, startedAt: ago(6 * 60 + 6), lastActive: ago(0), now: NOW, limits: LIMITS }).stale,
    true,
  );
  assert.equal(
    decideStale({ unitActive: true, startedAt: undefined, lastActive: undefined, now: NOW, limits: LIMITS }).stale,
    false,
  );
});

test('supervision: inactivity, the ceiling and an ignored pause stop a run; activity keeps it going', () => {
  const run = { now: NOW, limits: LIMITS, pauseGraceMinutes: 5, pauseRequestedAt: undefined };
  assert.equal(supervise({ ...run, startedAt: ago(120), lastActive: ago(1) }).kind, 'continue');
  assert.equal(supervise({ ...run, startedAt: ago(10), lastActive: undefined }).kind, 'continue');
  const inactive = supervise({ ...run, startedAt: ago(120), lastActive: ago(16) });
  assert.ok(inactive.kind === 'stop' && inactive.why === 'inactive');
  const quietFromStart = supervise({ ...run, startedAt: ago(16), lastActive: undefined });
  assert.ok(quietFromStart.kind === 'stop' && quietFromStart.why === 'inactive');
  const ceiling = supervise({ ...run, startedAt: ago(6 * 60 + 1), lastActive: ago(0) });
  assert.ok(ceiling.kind === 'stop' && ceiling.why === 'ceiling');
  assert.equal(
    supervise({ ...run, startedAt: ago(30), lastActive: ago(0), pauseRequestedAt: ago(4) }).kind,
    'continue',
  );
  const forced = supervise({ ...run, startedAt: ago(30), lastActive: ago(0), pauseRequestedAt: ago(6) });
  assert.ok(forced.kind === 'stop' && forced.why === 'pause-forced');
});

test('a run is over for its worker when the task closed or runs again from another start', () => {
  const started = { runStartedAt: new Date('2026-01-01T10:00:00Z') };
  assert.equal(isRunOver(started, { closed: false, runStartedAt: new Date('2026-01-01T10:00:00Z') }), false);
  assert.equal(isRunOver(started, { closed: true, runStartedAt: started.runStartedAt }), true);
  assert.equal(isRunOver(started, { closed: false, runStartedAt: new Date('2026-01-01T11:00:00Z') }), true);
  assert.equal(isRunOver(started, { closed: false, runStartedAt: null }), true);
  assert.equal(isRunOver({ runStartedAt: null }, { closed: false, runStartedAt: null }), false);
});

test('outcomes: a pause wins over the stop it caused, a report wins over a pause', () => {
  const base = { signal: null, stopped: undefined, pauseRequested: false, reported: false };
  const forced = { kind: 'stop' as const, why: 'pause-forced' as const, message: 'forced' };
  const inactive = { kind: 'stop' as const, why: 'inactive' as const, message: 'Stopped: no tool call' };
  assert.equal(decideOutcome({ ...base, exitCode: 1 }).kind, 'failed');
  assert.equal(decideOutcome({ ...base, exitCode: 0 }).kind, 'unreported');
  assert.equal(decideOutcome({ ...base, exitCode: 0, reported: true }).kind, 'ok');
  assert.deepEqual(decideOutcome({ ...base, exitCode: null, signal: 'SIGTERM', stopped: inactive }), {
    kind: 'failed',
    reason: 'Stopped: no tool call',
  });
  assert.equal(decideOutcome({ ...base, exitCode: 0, pauseRequested: true }).kind, 'paused');
  assert.equal(
    decideOutcome({ ...base, exitCode: null, signal: 'SIGTERM', stopped: forced, pauseRequested: true }).kind,
    'paused',
  );
  assert.equal(decideOutcome({ ...base, exitCode: 0, pauseRequested: true, reported: true }).kind, 'ok');
});

const LANES = [
  { name: 'reviews', skills: ['review-pr'], slots: 2 },
  { name: 'implement', skills: ['implement'], slots: 1 },
];
const lane = (t: { labels: string[] }) => LANES.find((l) => l.skills.includes(t.labels[0] ?? ''))?.name;
const run = (
  taskId: string,
  laneName: string,
  borrowed: boolean,
  minutesAgo: number,
  pauseRequested = false,
): LaneRun => ({ taskId, lane: laneName, borrowed, startedAt: ago(minutesAgo), pauseRequested });

test('lanes take their own work first, then idle lanes borrow in list order', () => {
  const candidates = [
    task({ id: 'r1', labels: ['review-pr'] }),
    task({ id: 'r2', labels: ['review-pr'] }),
    task({ id: 'r3', labels: ['review-pr'] }),
    task({ id: 'x', labels: ['other'] }),
  ];
  assert.deepEqual(planStarts({ lanes: LANES, running: [], candidates, ownLaneOf: lane }), [
    { taskId: 'r1', lane: 'reviews', borrowed: false },
    { taskId: 'r2', lane: 'reviews', borrowed: false },
    { taskId: 'r3', lane: 'implement', borrowed: true },
  ]);
  const withImplement = [...candidates, task({ id: 'i1', labels: ['implement'] })];
  assert.deepEqual(
    planStarts({ lanes: LANES, running: [], candidates: withImplement, ownLaneOf: lane }).map(
      (s) => `${s.taskId}:${s.lane}:${s.borrowed}`,
    ),
    ['r1:reviews:false', 'r2:reviews:false', 'i1:implement:false'],
  );
  assert.deepEqual(
    planStarts({
      lanes: LANES,
      running: [run('a', 'reviews', false, 1), run('b', 'reviews', false, 1), run('c', 'implement', true, 1)],
      candidates,
      ownLaneOf: lane,
    }),
    [],
  );
});

test('a full lane with its own work waiting pauses its newest borrowed run that ran long enough', () => {
  const plan = (running: LaneRun[], waiting: Record<string, number>) =>
    planPauses({
      lanes: LANES,
      running,
      waitingOwn: new Map(Object.entries(waiting)),
      now: NOW,
      pauseAfterMinutes: 5,
    }).map((r) => r.taskId);
  assert.deepEqual(plan([run('old', 'reviews', true, 40), run('new', 'reviews', true, 10)], { reviews: 1 }), ['new']);
  assert.deepEqual(
    plan([run('young', 'reviews', true, 3), run('own', 'reviews', false, 30)], { reviews: 1 }),
    [],
    'only after five minutes, never its own work',
  );
  assert.deepEqual(
    plan([run('b', 'reviews', true, 40), run('c', 'reviews', true, 40)], {}),
    [],
    'nothing of its own waits',
  );
  assert.deepEqual(plan([run('b', 'reviews', true, 40)], { reviews: 1 }), [], 'a free slot needs no pause');
  assert.deepEqual(
    plan([run('b', 'reviews', true, 40, true), run('c', 'reviews', true, 40)], { reviews: 2 }),
    [],
    'one pause at a time',
  );
  assert.deepEqual(plan([run('b', 'implement', true, 40)], { implement: 1 }), ['b']);
});

test('a paused run resumes with a note that it was paused, and with any reply since', () => {
  const notes = [makeNote('Halfway through the resolvers', at(2))];
  const paused = planRun(task({ id: 'p', next: 'resume', sessionId: SESSION, paused: true }), notes, options());
  assert.ok(paused.kind === 'resume');
  assert.match(paused.prompt, /You were paused on board task p/);
  const replied = planRun(
    task({ id: 'p', next: 'resume', sessionId: SESSION, paused: true }),
    [...notes, makeNote('also do X', at(4), { author: 'user' })],
    options(),
  );
  assert.ok(replied.kind === 'resume' && /You were paused/.test(replied.prompt) && /also do X/.test(replied.prompt));
  assert.equal(
    planRun(task({ id: 'p', next: 'resume', sessionId: SESSION, paused: false }), notes, options()).kind,
    'fresh',
    'a task that was not paused has nothing to resume without a reply',
  );
});

const start = (iso: number) => makeNote(`${START_MARKER} x`, at(iso), { author: 'system', kind: 'event' });

test("a fresh run reads the user's notes since the previous run started, and is pointed at the thread", () => {
  const notes = [
    makeNote('please look at the migration first', at(0), { author: 'user' }),
    start(1),
    makeNote('Findings: two issues', at(5)),
    makeNote('also the seed', at(6), { author: 'user' }),
    start(10),
  ];
  const current = task({ id: 'abc', runStartedAt: at(9) });
  const block = freshThreadBlock(current, notes) ?? '';
  assert.match(block, /The user wrote on board task abc since its last run started:\n\nalso the seed\n/);
  assert.doesNotMatch(block, /migration/, 'written before the previous run started');
  assert.doesNotMatch(block, /two issues/, "the agent's notes are for `board show`");
  assert.match(block, /run `board show abc` first/);
  const plan = planRun(current, notes, options());
  assert.ok(plan.kind === 'fresh' && plan.thread === block);
  const invocation = buildInvocation({
    run: plan,
    task: task({ id: 'abc', input: '/grill the plan' }),
    repos: {},
    defaultCwd: '/',
    intake: CONFIG.intake,
    home: '/h',
    pluginRoots: {},
  });
  assert.ok(invocation.ok);
  assert.equal(invocation.invocation.prompt, `/grill the plan\n\n${block}`);
});

test("a fresh run's prompt is verbatim when the thread has no user or agent notes", () => {
  assert.equal(freshThreadBlock(task({ id: 'a' }), []), undefined);
  assert.equal(
    freshThreadBlock(task({ id: 'a' }), [start(1), makeNote('Paused', at(2), { author: 'system', kind: 'event' })]),
    undefined,
  );
  assert.deepEqual(planRun(task({ id: 'a' }), [start(1)], options()), { kind: 'fresh', sessionId: OTHER_SESSION });
});

test('earlier findings alone point the fresh run at the thread; a first message on a never-run task is carried whole', () => {
  assert.equal(
    freshThreadBlock(task({ id: 'a', runStartedAt: at(20) }), [start(1), makeNote('Findings', at(5)), start(10)]),
    'The thread holds earlier notes: run `board show a` first to read it.',
  );
  const proposal = freshThreadBlock(task({ id: 'a' }), [makeNote('start with the API', at(1), { author: 'user' })]);
  assert.match(proposal ?? '', /start with the API/);
});

test('a backlog goes out in batches under the event and size limits', () => {
  const event = (seq: number): TranscriptEvent => ({
    kind: 'text',
    seq,
    at: '2026-01-01T00:00:00Z',
    parent: null,
    text: 'x'.repeat(100),
  });
  const events = Array.from({ length: 7 }, (_, seq) => event(seq));
  const size = Buffer.byteLength(JSON.stringify(event(0)));
  assert.deepEqual(
    splitBatches(events, { maxEvents: 3 }).map((batch) => batch.length),
    [3, 3, 1],
  );
  assert.deepEqual(
    splitBatches(events, { maxBytes: size * 2 + 5 }).map((batch) => batch.length),
    [2, 2, 2, 1],
  );
  assert.deepEqual(
    splitBatches(events, { maxBytes: 10 }).map((batch) => batch.length),
    [1, 1, 1, 1, 1, 1, 1],
    'an event over the limit goes alone',
  );
  assert.deepEqual(splitBatches([]), []);
  assert.deepEqual(
    splitBatches(Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, seq) => event(seq))).map((batch) => batch.length),
    [MAX_BATCH_EVENTS, 1],
  );
});

test('a session id that is not a UUID, or a directory that is not a path, never reaches an argument (flag injection)', () => {
  const run = (sessionId: string, workdir: string | null = null) =>
    buildInvocation({
      run: { kind: 'resume', sessionId, prompt: 'go on' },
      task: task({ id: 'a', input: '/grill', workdir }),
      repos: {},
      defaultCwd: '/',
      intake: CONFIG.intake,
      home: '/h',
      pluginRoots: {},
    });
  for (const hostile of ['--dangerously-skip-permissions', '-p', `${SESSION} --x`, `${SESSION}\n`, ''])
    assert.deepEqual(run(hostile), { ok: false, reason: 'The session id is not a UUID.' }, hostile);
  assert.equal(run(SESSION, 'relative/dir').ok, false);
  assert.equal(run(SESSION, '/a\nb').ok, false);
  const ok = run(SESSION, '/work/x');
  assert.ok(ok.ok);
  assert.ok(ok.invocation.args.includes(`--resume=${SESSION}`) && !ok.invocation.args.includes('--resume'));
  assert.ok(!ok.invocation.args.includes(SESSION), 'the id is part of one argument, never one of its own');
});

test('a blocked plan never becomes an invocation', () => {
  const plan = buildInvocation({
    run: { kind: 'blocked', reason: 'because' },
    task: task({ id: 'a', input: '/grill' }),
    repos: {},
    defaultCwd: '/',
    intake: CONFIG.intake,
    home: '/h',
    pluginRoots: {},
  });
  assert.deepEqual(plan, { ok: false, reason: 'because' });
});

test('a run resumes only a session this machine started, and only with a reply it can read', () => {
  const replied = [questionNote, makeNote('go on', at(2), { author: 'user' })];
  const resume = (sessionId: string | null) => task({ id: 'a', next: 'resume', sessionId });
  const foreign = planRun(resume(OTHER_SESSION), replied, options(OTHER_SESSION, false));
  assert.ok(foreign.kind === 'blocked' && /did not start for this task/.test(foreign.reason));
  assert.equal(planRun(resume(SESSION), replied, options(OTHER_SESSION, true)).kind, 'resume');
  // Without a reply to hand over, nothing is resumed and nothing needs to be known.
  assert.equal(planRun(resume(OTHER_SESSION), [questionNote], options(OTHER_SESSION, false)).kind, 'fresh');
  const unreadable = [questionNote, makeNote('', at(2), { author: 'user', unreadable: true })];
  const blocked = planRun(resume(SESSION), unreadable, options());
  assert.ok(blocked.kind === 'blocked' && /Re-run fresh/.test(blocked.reason));
});

test('a refusal is permanent when sending it again cannot help', () => {
  for (const status of [400, 404, 409, 413, 422]) assert.equal(isPermanentRefusal(new BackendError('x', status)), true);
  for (const status of [401, 403, 429, 500, 502, 503, undefined])
    assert.equal(isPermanentRefusal(new BackendError('x', status)), false);
  assert.equal(isPermanentRefusal(new Error('ECONNRESET')), false);
});

// `claude -p <prompt>` would take the prompt as an operand, and a sealed prompt is whatever the user (or an agent's proposal the
// user started) wrote. `--mcp-config=...` starts a process before any permission mode applies, so the prompt goes in on stdin.
const HOSTILE_PROMPTS = [
  '--version',
  '--dangerously-skip-permissions',
  '-p',
  '-',
  '--',
  '- fix the flaky login test',
  '--mcp-config={"mcpServers":{"poc":{"command":"touch","args":["/tmp/marker"]}}}',
];

for (const hostile of HOSTILE_PROMPTS) {
  test(`a prompt of ${JSON.stringify(hostile.slice(0, 30))} is carried as the prompt and adds nothing to argv`, () => {
    const reference = invoke({ id: 'abc', input: 'plain' });
    assert.ok(reference.ok);
    for (const run of [FRESH, { kind: 'resume', sessionId: SESSION, prompt: hostile } as const]) {
      const plan = invoke({ id: 'abc', input: run.kind === 'fresh' ? hostile : '/grill' }, run);
      assert.ok(plan.ok);
      assert.equal(plan.invocation.prompt, hostile);
      assert.ok(!plan.invocation.args.includes('--'), 'no separator to rely on');
      // Apart from the session flag, the arguments do not depend on the prompt at all.
      const withoutSession = (args: string[]) =>
        args.filter((arg) => !arg.startsWith('--session-id=') && !arg.startsWith('--resume='));
      assert.deepEqual(withoutSession(plan.invocation.args), withoutSession(reference.invocation.args));
    }
  });
}

test('every other board-derived value on the command line is one argument that cannot read as an option', () => {
  const plan = invoke({ id: 'abc', input: `/review-pr ${PR} --auto`, createdBy: 'intake' });
  assert.ok(plan.ok);
  const { args } = plan.invocation;
  // The session id is part of one `--flag=value` argument (and a UUID), the rules and the settings follow their flag.
  assert.ok(args.includes(`--session-id=${SESSION}`));
  assert.ok(!args.includes(SESSION));
  assert.match(
    args[args.indexOf('--append-system-prompt') + 1] ?? '',
    /^You are running headless as agent-board task abc/,
  );
  assert.match(args[args.indexOf('--settings') + 1] ?? '', /^\{/);
  // `--allowedTools` and `--disallowedTools` take every following argument that does not start with "-".
  const rules = args.slice(args.indexOf('--allowedTools') + 1).filter((arg) => !arg.startsWith('--'));
  assert.ok(rules.length > 0 && rules.every((rule) => !rule.startsWith('-')));
});

test('an intake tool rule that would read as an option stops the run', () => {
  for (const rule of ['--dangerously-skip-permissions', '-x', '{pr-review}/--x'.replace('{pr-review}', '-')]) {
    for (const list of ['allowedTools', 'disallowedTools'] as const) {
      const plan = buildInvocation({
        run: FRESH,
        task: task({ id: 'a', input: PR, createdBy: 'intake' }),
        repos: CONFIG.repos,
        defaultCwd: CONFIG.defaultCwd,
        intake: { ...CONFIG.intake, [list]: [rule] },
        home: '/h',
        pluginRoots: {},
      });
      assert.ok(!plan.ok && /starts with "-"/.test(plan.reason), `${list} ${rule}`);
    }
  }
});
