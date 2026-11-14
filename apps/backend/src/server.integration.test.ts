import { CONTRACT_VERSION, TAKE_BACK_AFTER_MS } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { tasks } from './db/schema';
import { buildServer } from './server';
import { issueToken } from './services/machines';
import { archiveStaleDone } from './services/tasks';
import { caller, question, testConfig, useTestDb } from './test/helpers';

const { db } = useTestDb();

async function setup() {
  const app = await buildServer(testConfig, db);
  const tokens = { laptop: await issueToken(db, 'laptop'), workstation: await issueToken(db, 'workstation') };
  const call = async (machine: keyof typeof tokens, command: string, body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${tokens[machine]}` },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as { result?: any; error?: string } };
  };
  return { app, call };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const pr = 'https://github.com/cosuno/cosuno/pull/1';

describe('machine API', () => {
  it('refuses a missing, unknown or revoked token', async () => {
    const none = await ctx.app.inject({ method: 'POST', url: '/api/machine/list-tasks', payload: {} });
    expect(none.statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/machine/list-tasks',
      headers: { authorization: 'Bearer abm_nope' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    await caller(db).machines.revoke({ name: 'laptop' });
    expect((await ctx.call('laptop', 'list-tasks')).status).toBe(401);
    expect((await ctx.call('workstation', 'list-tasks')).status).toBe(200);
  });

  it('answers the contract version it speaks', async () => {
    const { status, json } = await ctx.call('laptop', 'version');
    expect(status).toBe(200);
    expect(json.result).toEqual({ contract: CONTRACT_VERSION });
  });

  it('the UI needs a signed-in user in an allowed group; Remote-* headers do not open the machine API', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/trpc/me' })).statusCode).toBe(403);
    const outsider = await ctx.app.inject({
      method: 'GET',
      url: '/trpc/me',
      headers: { 'remote-user': 'x', 'remote-groups': 'family-tree' },
    });
    expect(outsider.statusCode).toBe(403);
    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/trpc/me',
      headers: { 'remote-user': 'jascha', 'remote-groups': 'work,admins' },
    });
    expect(admin.statusCode).toBe(200);
    const spoof = await ctx.app.inject({
      method: 'POST',
      url: '/api/machine/list-tasks',
      headers: { 'remote-user': 'jascha', 'remote-groups': 'admins' },
      payload: {},
    });
    expect(spoof.statusCode).toBe(401);
  });

  it('round-trips the contract: add, list, update, note, read', async () => {
    const added = await ctx.call('laptop', 'add-task', {
      body: { title: '#1 PR', input: pr, head: 'abc1234', labels: ['review-pr'], dedupeKey: pr, createdBy: 'intake' },
    });
    expect(added.status).toBe(200);
    const task = added.json.result.task;
    expect(added.json.result.created).toBe(true);
    expect(task).toMatchObject({
      status: 'todo',
      input: pr,
      head: 'abc1234',
      machine: null,
      sessionId: null,
      next: 'fresh',
      openQuestion: false,
      runStartedAt: null,
      paused: false,
    });
    expect(task.url).toBe(`https://board.test/t/${task.id}`);
    expect(task.id).toMatch(/^[A-Za-z0-9]{8}$/);

    const list = await ctx.call('laptop', 'list-tasks');
    expect(list.json.result.map((t: { id: string }) => t.id)).toEqual([task.id]);

    const updated = await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: 's1', next: 'fresh' } });
    expect(updated.json.result.sessionId).toBe('s1');

    await ctx.call('laptop', 'add-note', { id: task.id, body: 'Review started' });
    await ctx.call('laptop', 'add-note', { id: task.id, author: 'system', body: 'agent-board: started x' });
    const notes = await ctx.call('laptop', 'read-notes', { id: task.id });
    expect(
      notes.json.result.map((n: { text: string; author: string; kind: string }) => [n.text, n.author, n.kind]),
    ).toEqual([
      ['Review started', 'agent', 'comment'],
      ['agent-board: started x', 'system', 'event'],
    ]);
  });

  it('refuses bad input with the parser reason', async () => {
    const bad = await ctx.call('laptop', 'update-task', { id: 'abcdefgh', body: { title: 'x' } });
    expect(bad).toMatchObject({ status: 400, json: { error: 'patch has an unknown key "title"' } });
    const missing = await ctx.call('laptop', 'get-task', { id: 'abcdefgh' });
    expect(missing.status).toBe(404);
    const badId = await ctx.call('laptop', 'get-task', { id: '../x' });
    expect(badId.status).toBe(400);
  });

  it('dedupes intake across machines', async () => {
    const body = { title: '#1', input: pr, labels: ['review-pr'], dedupeKey: pr };
    const [a, b] = await Promise.all([
      ctx.call('laptop', 'add-task', { body }),
      ctx.call('workstation', 'add-task', { body }),
    ]);
    const results = [a.json.result, b.json.result];
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0].task.id).toBe(results[1].task.id);
  });

  it('lets exactly one machine win a claim, and only for its own name', async () => {
    const { json } = await ctx.call('laptop', 'add-task', { body: { title: 't', labels: ['review-pr'] } });
    const id = json.result.task.id;
    const forged = await ctx.call('laptop', 'claim-task', { id, machine: 'workstation' });
    expect(forged.status).toBe(403);
    const claims = await Promise.all([
      ctx.call('laptop', 'claim-task', { id, machine: 'laptop' }),
      ctx.call('workstation', 'claim-task', { id, machine: 'workstation' }),
    ]);
    expect(claims.map((c) => c.status).sort()).toEqual([200, 409]);
    const winner = claims.find((c) => c.status === 200)!.json.result;
    expect(winner.status).toBe('running');
  });

  it('ask → answer → resume is pinned to the machine that holds the session', async () => {
    const { json } = await ctx.call('laptop', 'add-task', { body: { title: 't', labels: ['review-pr'] } });
    const id = json.result.task.id;
    await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id, body: { sessionId: 'sess-1' } });
    const bad = await ctx.call('laptop', 'ask', {
      id,
      body: { questions: [{ ...question, options: [question.options[0]] }] },
    });
    expect(bad.status).toBe(400);
    expect((await ctx.call('laptop', 'ask', { id, body: { questions: [question] } })).status).toBe(200);

    const asked = (await ctx.call('laptop', 'get-task', { id })).json.result;
    expect(asked).toMatchObject({ status: 'needs-me', openQuestion: true });

    const ui = caller(db);
    const { thread } = await ui.tasks.get({ id });
    const questionNote = thread.find((n) => n.kind === 'question')!;
    await expect(
      ui.tasks.answer({ id, questionNoteId: questionNote.id, answers: [{ selected: ['Maybe'] }] }),
    ).rejects.toThrow(/not an option/);
    const answered = await ui.tasks.answer({
      id,
      questionNoteId: questionNote.id,
      answers: [{ selected: ['Yes'], other: 'and the seed' }],
      message: 'thanks',
    });
    expect(answered).toMatchObject({ status: 'todo', next: 'resume', openQuestion: false, machine: 'laptop' });
    await expect(
      ui.tasks.answer({ id, questionNoteId: questionNote.id, answers: [{ selected: ['Yes'] }] }),
    ).rejects.toThrow(/already answered/);

    expect((await ctx.call('workstation', 'claim-task', { id, machine: 'workstation' })).status).toBe(409);
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(200);

    const notes = (await ctx.call('laptop', 'read-notes', { id })).json.result;
    const answer = notes.find((n: { kind: string }) => n.kind === 'answer');
    expect(answer).toMatchObject({
      author: 'user',
      text: 'thanks',
      questionNoteId: questionNote.id,
      answers: [{ selected: ['Yes'], other: 'and the seed' }],
    });
  });
});

describe('board UI', () => {
  it('a reply with resume goes to the top of Todo; without a session it runs fresh', async () => {
    const ui = caller(db);
    const first = await ui.tasks.create({ title: 'first', input: 'do it' });
    const second = await ui.tasks.create({ title: 'second', input: 'Find out X', when: 'hold' });
    expect(second.status).toBe('needs-me');
    await expect(ui.tasks.reply({ id: second.id, message: '  ', resume: true })).rejects.toThrow(/Write something/);
    const replied = await ui.tasks.reply({ id: second.id, message: 'go', resume: true });
    expect(replied).toMatchObject({ status: 'todo', next: 'fresh' });
    const todo = (await ui.tasks.list()).filter((t) => t.status === 'todo').map((t) => t.title);
    expect(todo).toEqual(['second', 'first']);
    expect(first.status).toBe('todo');
  });

  it('creates a task in Todo, Backlog or Needs me by `when`', async () => {
    const ui = caller(db);
    expect((await ui.tasks.create({ input: 'a' })).status).toBe('todo');
    expect((await ui.tasks.create({ input: 'b', when: 'now' })).status).toBe('todo');
    expect((await ui.tasks.create({ input: 'c', when: 'backlog' })).status).toBe('backlog');
    expect((await ui.tasks.create({ input: 'd', when: 'hold' })).status).toBe('needs-me');
  });

  it('a Backlog task cannot be claimed; moving it to Todo makes it claimable and back parks it', async () => {
    const ui = caller(db);
    const { id } = await ui.tasks.create({ input: 'later', when: 'backlog' });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    expect(await ui.tasks.move({ id, status: 'todo' })).toMatchObject({ status: 'todo' });
    expect(await ui.tasks.move({ id, status: 'backlog' })).toMatchObject({ status: 'backlog' });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    await ui.tasks.move({ id, status: 'todo' });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(200);
  });

  it('lists Backlog before Todo', async () => {
    const ui = caller(db);
    await ui.tasks.create({ title: 'todo', input: 'a' });
    await ui.tasks.create({ title: 'parked', input: 'b', when: 'backlog' });
    expect((await ui.tasks.list()).map((t) => t.title)).toEqual(['parked', 'todo']);
  });

  it('a running task cannot be answered, moved or closed from the UI', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await expect(ui.tasks.reply({ id: task.id, message: 'x', resume: true })).rejects.toThrow(/running/);
    await expect(ui.tasks.move({ id: task.id, status: 'done' })).rejects.toThrow(/running/);
    await expect(ui.tasks.setClosed({ id: task.id, closed: true })).rejects.toThrow(/running/);
    // A comment without resume is fine while it runs.
    await ui.tasks.reply({ id: task.id, message: 'fyi', resume: false });
  });

  it('agent proposals wait in needs-me until started; moving into Todo starts them', async () => {
    const ui = caller(db);
    const parent = await ui.tasks.create({ title: 'parent', input: 'do it' });
    const proposed = await ctx.call('laptop', 'add-task', {
      body: {
        title: 'follow-up',
        input: 'do Y',
        labels: ['research'],
        status: 'needs-me',
        createdBy: 'agent',
        parentId: parent.id,
      },
    });
    const id = proposed.json.result.task.id;
    const before = await ui.tasks.get({ id });
    expect(before.task).toMatchObject({ proposed: true, status: 'needs-me', parentId: parent.id });
    expect((await ui.tasks.get({ id: parent.id })).followUps.map((t) => t.id)).toEqual([id]);
    const started = await ui.tasks.move({ id, status: 'todo' });
    expect(started).toMatchObject({ proposed: false, status: 'todo' });
  });

  it('drag and drop places a task between its neighbours', async () => {
    const ui = caller(db);
    const a = await ui.tasks.create({ title: 'a', input: 'do it' });
    const b = await ui.tasks.create({ title: 'b', input: 'do it' });
    const c = await ui.tasks.create({ title: 'c', input: 'do it' });
    await ui.tasks.move({ id: c.id, status: 'todo', afterId: a.id, beforeId: b.id });
    expect((await ui.tasks.list()).map((t) => t.title)).toEqual(['a', 'c', 'b']);
    await ui.tasks.move({ id: a.id, status: 'done' });
    await expect(ui.tasks.move({ id: b.id, status: 'running' })).rejects.toThrow(/Only a worker/);
  });

  it('done and re-run clear the open question; re-run forgets the session', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: 's' } });
    await ctx.call('laptop', 'ask', { id: task.id, body: [question] });
    const rerun = await ui.tasks.rerun({ id: task.id });
    expect(rerun).toMatchObject({ status: 'todo', next: 'fresh', sessionId: null, openQuestion: false });
  });

  it('a machine token is shown once and works at once', async () => {
    const ui = caller(db);
    const { token } = await ui.machines.issue({ name: 'new-box' });
    expect(token).toMatch(/^abm_/);
    await expect(ui.machines.issue({ name: 'bad name' })).rejects.toThrow(/machine name/);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/machine/list-tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const listed = await ui.machines.list();
    expect(listed.find((m) => m.name === 'new-box')?.lastSeenAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain('token');
  });
});

describe('priority', () => {
  const titles = (rows: { title: string; status: string }[], status = 'todo') =>
    rows.filter((t) => t.status === status).map((t) => t.title);

  it('columns sort by priority, then manual order; list-tasks hands workers the urgent ones first', async () => {
    const ui = caller(db);
    await ui.tasks.create({ title: 'normal-1', input: 'do it' });
    await ui.tasks.create({ title: 'low', input: 'do it', priority: 'low' });
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    await ui.tasks.create({ title: 'normal-2', input: 'do it' });
    expect(titles(await ui.tasks.list())).toEqual(['urgent', 'normal-1', 'normal-2', 'low']);
    const machine = (await ctx.call('laptop', 'list-tasks')).json.result;
    expect(machine.map((t: { title: string; priority: string }) => `${t.title}:${t.priority}`)).toEqual([
      'urgent:urgent',
      'normal-1:normal',
      'normal-2:normal',
      'low:low',
    ]);
  });

  it('a new priority puts the task at the bottom of its new band and notes it', async () => {
    const ui = caller(db);
    await ui.tasks.create({ title: 'high-1', input: 'do it', priority: 'high' });
    const task = await ui.tasks.create({ title: 'normal', input: 'do it' });
    await ui.tasks.create({ title: 'high-2', input: 'do it', priority: 'high' });
    await ui.tasks.setPriority({ id: task.id, priority: 'high' });
    expect(titles(await ui.tasks.list())).toEqual(['high-1', 'high-2', 'normal']);
    const { thread } = await ui.tasks.get({ id: task.id });
    expect(thread.at(-1)?.text).toBe('Priority normal → high.');
  });

  it('a reply jumps to the top of its own band, not above more urgent work', async () => {
    const ui = caller(db);
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    await ui.tasks.create({ title: 'normal-old', input: 'do it' });
    const waiting = await ui.tasks.create({ title: 'replied', input: 'do it', when: 'hold' });
    await ui.tasks.reply({ id: waiting.id, message: 'go', resume: true });
    expect(titles(await ui.tasks.list())).toEqual(['urgent', 'replied', 'normal-old']);
  });

  it('a dropped card takes the priority of the tasks it lands among', async () => {
    const ui = caller(db);
    const urgent = await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    const n1 = await ui.tasks.create({ title: 'n1', input: 'do it' });
    const n2 = await ui.tasks.create({ title: 'n2', input: 'do it' });
    const low = await ui.tasks.create({ title: 'low', input: 'do it', priority: 'low' });
    // Between two normals: normal.
    const moved = await ui.tasks.move({ id: urgent.id, status: 'todo', afterId: n1.id, beforeId: n2.id });
    expect(moved.priority).toBe('normal');
    expect(titles(await ui.tasks.list())).toEqual(['n1', 'urgent', 'n2', 'low']);
    // Above everything, below nothing: the one below it.
    expect((await ui.tasks.move({ id: low.id, status: 'todo', beforeId: n1.id })).priority).toBe('normal');
    // Within its own band it keeps its priority.
    expect((await ui.tasks.move({ id: n2.id, status: 'todo', beforeId: n1.id })).priority).toBe('normal');
  });

  it('follow-ups inherit the parent priority unless the agent sets one', async () => {
    const ui = caller(db);
    const parent = await ui.tasks.create({ title: 'parent', input: 'do it', priority: 'high' });
    const inherit = await ctx.call('laptop', 'add-task', {
      body: { title: 'a', labels: ['research'], parentId: parent.id, createdBy: 'agent', status: 'needs-me' },
    });
    expect(inherit.json.result.task.priority).toBe('high');
    const chosen = await ctx.call('laptop', 'add-task', {
      body: {
        title: 'b',
        labels: ['research'],
        parentId: parent.id,
        createdBy: 'agent',
        status: 'needs-me',
        priority: 'low',
      },
    });
    expect(chosen.json.result.task.priority).toBe('low');
    const plain = await ctx.call('laptop', 'add-task', { body: { title: 'c', labels: ['research'] } });
    expect(plain.json.result.task.priority).toBe('normal');
  });
});

describe('lanes, liveness and pausing', () => {
  async function running(title: string, priority: 'urgent' | 'high' | 'normal' | 'low' = 'normal') {
    const task = await caller(db).tasks.create({ title, input: 'do it', priority });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: `s-${title}` } });
    return task.id;
  }

  it('a heartbeat shows the lane and liveness while the task runs, and nothing after', async () => {
    const id = await running('t');
    expect((await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'a b', borrowed: false } })).status).toBe(400);
    await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'implement', borrowed: true } });
    const task = (await ctx.call('laptop', 'get-task', { id })).json.result;
    expect(task).toMatchObject({ lane: 'implement', borrowed: true });
    expect(Date.now() - new Date(task.lastActiveAt).getTime()).toBeLessThan(5_000);
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result).toMatchObject({
      lane: null,
      borrowed: false,
      lastActiveAt: null,
    });
    // A late heartbeat from a stopping worker does not bring the run back.
    await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'implement', borrowed: true } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.lane).toBeNull();
  });

  it('a paused task resumes next, on its machine, ahead of new urgent work', async () => {
    const ui = caller(db);
    const id = await running('paused', 'low');
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    const paused = await ctx.call('laptop', 'pause', {
      id,
      body: 'Paused on laptop: the reviews lane needed its slot.',
    });
    expect(paused.json.result).toMatchObject({ status: 'todo', next: 'resume', machine: 'laptop' });
    const list = await ui.tasks.list();
    expect(list.filter((t) => t.status === 'todo').map((t) => [t.title, t.paused])).toEqual([
      ['paused', true],
      ['urgent', false],
    ]);
    expect((await ctx.call('laptop', 'pause', { id, body: 'again' })).status).toBe(409);
    expect((await ctx.call('workstation', 'claim-task', { id, machine: 'workstation' })).status).toBe(409);
    const claimed = await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    // The worker that resumes it still sees the pause until its first update of the run.
    expect(claimed.json.result).toMatchObject({ status: 'running', paused: true });
    await ctx.call('laptop', 'update-task', { id, body: { next: 'fresh' } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.paused).toBe(false);
    const { thread } = await ui.tasks.get({ id });
    expect(thread.some((n) => n.author === 'system' && n.text.startsWith('Paused on laptop'))).toBe(true);
  });
});

describe('prompts', () => {
  it('a task is labelled with its skill, titled by its first line, and can be pinned', async () => {
    const ui = caller(db);
    const review = await ui.tasks.create({ input: '/review-pr 17741\nplease look at the migration' });
    expect(review).toMatchObject({
      title: '/review-pr 17741',
      labels: ['review-pr'],
      createdBy: 'user',
      machine: null,
      workdir: null,
    });
    const plain = await ui.tasks.create({ input: 'Find out why the export is slow' });
    expect(plain.labels).toEqual([]);
    await expect(ui.tasks.create({ input: '   ' })).rejects.toThrow(/Write a prompt first/);
    const pinned = await ctx.call('laptop', 'add-task', {
      body: { title: 't', input: '/grill', machine: 'laptop', workdir: '/home/me/repo' },
    });
    expect(pinned.json.result.task).toMatchObject({ machine: 'laptop', workdir: '/home/me/repo', labels: ['grill'] });
  });
});

describe('transcripts', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 12, 0, s)).toISOString();
  const batch = (runId: string, events: unknown[]) => ({
    runId,
    startedAt: at(0),
    sessionId: 'sess',
    resumed: false,
    events,
  });
  const events = [
    { seq: 0, at: at(1), parent: null, kind: 'note', text: 'Claude Code 2.1.325' },
    { seq: 1, at: at(2), parent: null, kind: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } },
    { seq: 2, at: at(3), parent: null, kind: 'tool_result', toolUseId: 'tu1', isError: false, output: 'a.txt\nb.txt' },
  ];

  it('stores batches once, lists runs and events without output, and loads output on demand', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ input: '/grill' });
    const body = batch('run-0001-aaaa', events);
    expect((await ctx.call('laptop', 'transcript', { id: task.id, body })).status).toBe(200);
    expect((await ctx.call('laptop', 'transcript', { id: task.id, body })).status).toBe(200);
    await ctx.call('laptop', 'transcript', {
      id: task.id,
      body: batch('run-0001-aaaa', [{ seq: 3, at: at(9), parent: null, kind: 'text', text: 'done' }]),
    });
    const [run] = await ui.transcript.runs({ id: task.id });
    expect(run).toMatchObject({ id: 'run-0001-aaaa', machine: 'laptop', eventCount: 4, sessionId: 'sess' });
    expect(run?.lastEventAt.toISOString()).toBe(at(9));
    const listed = await ui.transcript.events({ runId: 'run-0001-aaaa' });
    expect(listed.map((e) => e.kind)).toEqual(['note', 'tool_use', 'tool_result', 'text']);
    expect(listed[2]).toMatchObject({ outputSize: 11 });
    expect(listed[2]).not.toHaveProperty('output');
    expect((await ui.transcript.events({ runId: 'run-0001-aaaa', afterSeq: 2 })).map((e) => e.seq)).toEqual([3]);
    expect(await ui.transcript.output({ runId: 'run-0001-aaaa', seq: 2 })).toBe('a.txt\nb.txt');
    const other = await ui.tasks.create({ input: '/other' });
    expect((await ctx.call('laptop', 'transcript', { id: other.id, body })).status).toBe(400);
    expect((await ctx.call('laptop', 'transcript', { id: task.id, body: { ...body, runId: '../x' } })).status).toBe(
      400,
    );
  });

  it('refuses an event with a bad seq or date instead of failing in the database', async () => {
    const task = await caller(db).tasks.create({ input: '/grill' });
    for (const bad of [{ seq: -1 }, { seq: 1.5 }, { at: 'soon' }]) {
      const body = batch('run-bad-00001', [{ ...events[0], ...bad }]);
      expect((await ctx.call('laptop', 'transcript', { id: task.id, body })).status).toBe(400);
    }
  });

  it('transcripts of open tasks untouched in Done for 28 days are deleted, others stay', async () => {
    const ui = caller(db);
    const stale = await ui.tasks.create({ input: '/stale', when: 'hold' });
    const fresh = await ui.tasks.create({ input: '/fresh', when: 'hold' });
    const running = await ui.tasks.create({ input: '/running', when: 'hold' });
    for (const [task, run] of [
      [stale, 'run-stale-001'],
      [fresh, 'run-fresh-001'],
      [running, 'run-runnin-01'],
    ] as const) {
      await ctx.call('laptop', 'transcript', { id: task.id, body: batch(run, events) });
    }
    await ui.tasks.done({ id: stale.id });
    await ui.tasks.done({ id: fresh.id });
    const idle = (id: string, days: number) =>
      db
        .update(tasks)
        .set({ updatedAt: new Date(Date.now() - days * 24 * 60 * 60_000) })
        .where(eq(tasks.id, id));
    await idle(stale.id, 29);
    await idle(fresh.id, 27);
    await idle(running.id, 29);
    const { deleteOldTranscripts } = await import('./services/transcripts');
    expect(await deleteOldTranscripts(db)).toBe(1);
    expect(await ui.transcript.runs({ id: stale.id })).toHaveLength(0);
    expect(await ui.transcript.runs({ id: fresh.id })).toHaveLength(1);
    expect(await ui.transcript.runs({ id: running.id })).toHaveLength(1);
  });

  it('transcripts of tasks closed more than 14 days ago are deleted, others stay', async () => {
    const ui = caller(db);
    const old = await ui.tasks.create({ input: '/old' });
    const recent = await ui.tasks.create({ input: '/recent' });
    const open = await ui.tasks.create({ input: '/open' });
    for (const [task, run] of [
      [old, 'run-old-0001'],
      [recent, 'run-recent-01'],
      [open, 'run-open-0001'],
    ] as const) {
      await ctx.call('laptop', 'transcript', { id: task.id, body: batch(run, events) });
    }
    await ui.tasks.setClosed({ id: old.id, closed: true });
    await ui.tasks.setClosed({ id: recent.id, closed: true });
    const { deleteOldTranscripts } = await import('./services/transcripts');
    const { tasks } = await import('./db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(tasks)
      .set({ closedAt: new Date(Date.now() - 15 * 24 * 60 * 60_000) })
      .where(eq(tasks.id, old.id));
    expect(await deleteOldTranscripts(db)).toBe(1);
    expect(await ui.transcript.runs({ id: old.id })).toHaveLength(0);
    expect(await ui.transcript.runs({ id: recent.id })).toHaveLength(1); // closed today: kept
    expect(await ui.transcript.runs({ id: open.id })).toHaveLength(1);
    await ui.tasks.setClosed({ id: recent.id, closed: false });
    expect((await ui.tasks.get({ id: recent.id })).task.closed).toBe(false);
  });
});

describe('proposals', () => {
  const propose = async (body: Record<string, unknown> = {}) =>
    (await ctx.call('laptop', 'add-task', { body: { title: 'idea', input: 'do Y', createdBy: 'agent', ...body } })).json
      .result.task;

  it('an agent task lands in needs-me as a proposal whatever status it names', async () => {
    for (const status of ['todo', 'running', 'done', 'needs-me']) {
      expect(await propose({ status })).toMatchObject({ status: 'needs-me', createdBy: 'agent' });
    }
    expect((await caller(db).tasks.list()).every((t) => t.proposed)).toBe(true);
  });

  it('the machine API cannot start a proposal; the user can', async () => {
    const { id } = await propose();
    for (const status of ['todo', 'done']) {
      const refused = await ctx.call('laptop', 'update-task', { id, body: { status } });
      expect(refused.status).toBe(403);
    }
    // Other fields are fine, and so is staying put.
    expect((await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me', sessionId: 's' } })).status).toBe(
      200,
    );
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    // Even a proposal that somehow sits in Todo is not claimable.
    await db.update(tasks).set({ status: 'todo' }).where(eq(tasks.id, id));
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    await db.update(tasks).set({ status: 'needs-me' }).where(eq(tasks.id, id));
    const started = await caller(db).tasks.move({ id, status: 'todo' });
    expect(started).toMatchObject({ status: 'todo', proposed: false });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(200);
  });

  it('a proposal cannot ask a question, so answering never starts it', async () => {
    const { id } = await propose();
    const asked = await ctx.call('laptop', 'ask', { id, body: { questions: [question] } });
    expect(asked.status).toBe(403);
    expect(asked.json.error).toMatch(/only you start it/);
    const { task, thread } = await caller(db).tasks.get({ id });
    expect(task).toMatchObject({ status: 'needs-me', proposed: true, openQuestion: false });
    expect(thread.filter((n) => n.kind === 'question')).toEqual([]);
  });
});

describe('transitions', () => {
  async function asking(options: { session?: boolean } = {}) {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    if (options.session ?? true) await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: 's' } });
    await ctx.call('laptop', 'ask', { id: task.id, body: { questions: [question] } });
    expect((await ui.tasks.get({ id: task.id })).task.openQuestion).toBe(true);
    return task.id;
  }

  it('marking done and dragging to Done both close the open question', async () => {
    const ui = caller(db);
    expect(await ui.tasks.done({ id: await asking() })).toMatchObject({ status: 'done', openQuestion: false });
    expect(await ui.tasks.move({ id: await asking(), status: 'done' })).toMatchObject({
      status: 'done',
      openQuestion: false,
    });
  });

  it('dragging to Todo drops the open question and leaves a session its next run', async () => {
    const ui = caller(db);
    const id = await asking();
    const before = (await ui.tasks.get({ id })).task;
    const moved = await ui.tasks.move({ id, status: 'todo' });
    expect(moved).toMatchObject({ status: 'todo', openQuestion: false, next: before.next, sessionId: 's' });
  });

  it('an intake requeue with a fresh run and a re-run drop the open question', async () => {
    const ui = caller(db);
    const requeued = await ctx.call('laptop', 'update-task', {
      id: await asking(),
      body: { status: 'todo', next: 'fresh' },
    });
    expect(requeued.json.result).toMatchObject({ status: 'todo', next: 'fresh', openQuestion: false });
    expect(await ui.tasks.rerun({ id: await asking() })).toMatchObject({ status: 'todo', openQuestion: false });
  });

  it('a question stays open only in Needs me: moving around there keeps it', async () => {
    const ui = caller(db);
    const id = await asking();
    expect(await ui.tasks.setPriority({ id, priority: 'high' })).toMatchObject({
      status: 'needs-me',
      openQuestion: true,
    });
    expect(await ui.tasks.move({ id, status: 'needs-me' })).toMatchObject({ openQuestion: true });
  });

  it('records the run start while it runs, and nothing after', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    expect((await ctx.call('laptop', 'get-task', { id: task.id })).json.result.runStartedAt).toBeNull();
    const claimed = (await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' })).json.result;
    expect(Date.now() - new Date(claimed.runStartedAt).getTime()).toBeLessThan(5_000);
    await ctx.call('laptop', 'update-task', { id: task.id, body: { status: 'needs-me' } });
    expect((await ctx.call('laptop', 'get-task', { id: task.id })).json.result.runStartedAt).toBeNull();
  });

  it('a pause is cleared when the task leaves Running another way', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'pause', { id: task.id, body: 'Paused on laptop' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'ask', { id: task.id, body: { questions: [question] } });
    expect((await ctx.call('laptop', 'get-task', { id: task.id })).json.result.paused).toBe(false);
  });
});

describe('taking back a stuck task', () => {
  async function running() {
    const task = await caller(db).tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    return task.id;
  }
  const quietFor = (id: string, ms: number) =>
    db
      .update(tasks)
      .set({ lastActiveAt: new Date(Date.now() - ms) })
      .where(eq(tasks.id, id));

  it('is refused while the agent is active, and for a task that is not running', async () => {
    const ui = caller(db);
    const id = await running();
    await quietFor(id, TAKE_BACK_AFTER_MS - 60_000);
    await expect(ui.tasks.takeBack({ id })).rejects.toThrow(/active 19 min ago/);
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    await expect(ui.tasks.takeBack({ id })).rejects.toThrow(/not running/);
  });

  it('moves a task quiet for the limit to Needs me with a note; the worker then finds it reported', async () => {
    const ui = caller(db);
    const id = await running();
    await quietFor(id, TAKE_BACK_AFTER_MS + 1_000);
    const taken = await ui.tasks.takeBack({ id });
    expect(taken).toMatchObject({ status: 'needs-me', lane: null, lastActiveAt: null, runStartedAt: null });
    const { thread } = await ui.tasks.get({ id });
    expect(thread.at(-1)).toMatchObject({ author: 'system', kind: 'event' });
    expect(thread.at(-1)?.text).toMatch(/^Taken back from laptop/);
    // Nothing left to claim or fail for the worker that comes back.
    expect((await ctx.call('laptop', 'fail', { id, body: 'late' })).json.result.applied).toBe(false);
  });
});

describe('fail', () => {
  it('moves a running task to needs-me with the text as a system note, once', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    expect((await ctx.call('laptop', 'fail', { id: task.id, body: '  ' })).status).toBe(400);
    expect((await ctx.call('laptop', 'fail', { id: task.id, body: 'too early' })).json.result).toMatchObject({
      applied: false,
      task: { status: 'todo' },
    });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    const failed = await ctx.call('laptop', 'fail', { id: task.id, body: 'The worker exited with code 1.' });
    expect(failed.json.result).toMatchObject({ applied: true, task: { status: 'needs-me', lane: null } });
    expect((await ctx.call('laptop', 'fail', { id: task.id, body: 'again' })).json.result.applied).toBe(false);
    const notes = (await ctx.call('laptop', 'read-notes', { id: task.id })).json.result;
    expect(notes.map((n: { text: string; author: string }) => [n.author, n.text])).toEqual([
      ['system', 'The worker exited with code 1.'],
    ]);
  });

  it('leaves a closed task alone', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await db.update(tasks).set({ closed: true }).where(eq(tasks.id, task.id));
    expect((await ctx.call('laptop', 'fail', { id: task.id, body: 'x' })).json.result).toMatchObject({
      applied: false,
      task: { status: 'running' },
    });
  });
});

describe('head', () => {
  it('is set by a draft, changed and cleared by a patch, and checked', async () => {
    const added = await ctx.call('laptop', 'add-task', { body: { title: 't', input: pr, head: 'abc1234' } });
    const id = added.json.result.task.id;
    expect(added.json.result.task.head).toBe('abc1234');
    expect((await ctx.call('laptop', 'update-task', { id, body: { head: 'def56789ab' } })).json.result.head).toBe(
      'def56789ab',
    );
    expect((await ctx.call('laptop', 'update-task', { id, body: { head: null } })).json.result.head).toBeNull();
    expect((await ctx.call('laptop', 'update-task', { id, body: { head: 'nothex!' } })).status).toBe(400);
    expect((await ctx.call('laptop', 'add-task', { body: { title: 't', head: 'abc' } })).status).toBe(400);
  });

  it('is cleared together with a status change', async () => {
    const added = await ctx.call('laptop', 'add-task', { body: { title: 't', input: pr, head: 'abc1234' } });
    const id = added.json.result.task.id;
    const done = await ctx.call('laptop', 'update-task', { id, body: { status: 'done', head: null } });
    expect(done.json.result).toMatchObject({ status: 'done', head: null });
  });
});

describe('the board list', () => {
  it('carries the newest note of each task, and null for a task without notes', async () => {
    const ui = caller(db);
    const quiet = await ui.tasks.create({ title: 'quiet', input: 'do it' });
    const busy = await ui.tasks.create({ title: 'busy', input: 'do it' });
    await ctx.call('laptop', 'add-note', { id: busy.id, body: 'first' });
    await ctx.call('laptop', 'add-note', { id: busy.id, body: 'x'.repeat(1000) });
    const list = await ui.tasks.list();
    expect(list.find((t) => t.id === quiet.id)?.lastNote).toBeNull();
    const last = list.find((t) => t.id === busy.id)?.lastNote;
    expect(last).toMatchObject({ kind: 'comment', author: 'agent' });
    expect(last?.text).toHaveLength(300);
  });
});

describe('update-task expect', () => {
  it('writes only while the task has the expected status, and answers 409 without a write otherwise', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    const refused = await ctx.call('laptop', 'update-task', {
      id: task.id,
      body: { status: 'done', head: null, expect: 'needs-me' },
    });
    expect(refused.status).toBe(409);
    expect((await ui.tasks.get({ id: task.id })).task.status).toBe('todo');
    const applied = await ctx.call('laptop', 'update-task', {
      id: task.id,
      body: { priority: 'high', expect: 'todo' },
    });
    expect(applied.status).toBe(200);
    expect(applied.json.result.priority).toBe('high');
    expect((await ctx.call('laptop', 'update-task', { id: task.id, body: { expect: 'nope' } })).status).toBe(400);
  });
});

describe('Done archival', () => {
  const idle = (id: string, days: number) =>
    db
      .update(tasks)
      .set({ updatedAt: new Date(Date.now() - days * 24 * 60 * 60_000) })
      .where(eq(tasks.id, id));

  it('closes tasks untouched in Done for 14 days, with a note, and nothing else', async () => {
    const ui = caller(db);
    const old = await ui.tasks.create({ title: 'old', input: 'do it', when: 'hold' });
    const recent = await ui.tasks.create({ title: 'recent', input: 'do it', when: 'hold' });
    const waiting = await ui.tasks.create({ title: 'waiting', input: 'do it', when: 'hold' });
    await ui.tasks.done({ id: old.id });
    await ui.tasks.done({ id: recent.id });
    await idle(old.id, 15);
    await idle(recent.id, 13);
    await idle(waiting.id, 30);
    expect(await archiveStaleDone(db)).toBe(1);
    const closed = (await ui.tasks.get({ id: old.id })).task;
    expect(closed).toMatchObject({ closed: true, status: 'done' });
    expect((await ui.tasks.get({ id: old.id })).thread.at(-1)?.text).toBe('Closed after 14 days in Done.');
    expect((await ui.tasks.get({ id: recent.id })).task.closed).toBe(false);
    expect((await ui.tasks.get({ id: waiting.id })).task.closed).toBe(false);
    expect(await archiveStaleDone(db)).toBe(0);
    // Its transcripts now go after the usual retention.
    expect((await db.select().from(tasks).where(eq(tasks.id, old.id)))[0]?.closedAt).not.toBeNull();
  });

  it('leaves intake tasks open, so a re-requested review is not blocked', async () => {
    const added = await ctx.call('laptop', 'add-task', {
      body: { title: 'review', input: '/review-pr x', createdBy: 'intake' },
    });
    const id = added.json.result.task.id;
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, id));
    await idle(id, 40);
    expect(await archiveStaleDone(db)).toBe(0);
    expect((await caller(db).tasks.get({ id })).task.closed).toBe(false);
  });
});
