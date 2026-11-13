import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { issueToken } from './services/machines';
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
      body: { title: '#1 PR', input: `${pr}\nhead: abc1234`, labels: ['review-pr'], dedupeKey: pr, createdBy: 'intake' },
    });
    expect(added.status).toBe(200);
    const task = added.json.result.task;
    expect(added.json.result.created).toBe(true);
    expect(task).toMatchObject({ status: 'todo', machine: null, sessionId: null, next: 'fresh', openQuestion: false });
    expect(task.url).toBe(`https://board.test/t/${task.id}`);
    expect(task.id).toMatch(/^[A-Za-z0-9]{8}$/);

    const list = await ctx.call('laptop', 'list-tasks');
    expect(list.json.result.map((t: { id: string }) => t.id)).toEqual([task.id]);

    const updated = await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: 's1', next: 'fresh' } });
    expect(updated.json.result.sessionId).toBe('s1');

    await ctx.call('laptop', 'add-note', { id: task.id, body: 'Review started' });
    await ctx.call('laptop', 'add-note', { id: task.id, author: 'system', body: 'agent-board: started x' });
    const notes = await ctx.call('laptop', 'read-notes', { id: task.id });
    expect(notes.json.result.map((n: { text: string; author: string; kind: string }) => [n.text, n.author, n.kind])).toEqual([
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
    const [a, b] = await Promise.all([ctx.call('laptop', 'add-task', { body }), ctx.call('workstation', 'add-task', { body })]);
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
    const bad = await ctx.call('laptop', 'ask', { id, body: { questions: [{ ...question, options: [question.options[0]] }] } });
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
    expect(answer).toMatchObject({ author: 'user', text: 'thanks', questionNoteId: questionNote.id, answers: [{ selected: ['Yes'], other: 'and the seed' }] });
  });
});

describe('board UI', () => {
  it('a reply with resume goes to the top of Todo; without a session it runs fresh', async () => {
    const ui = caller(db);
    const first = await ui.tasks.create({ title: 'first', input: 'do it' });
    const second = await ui.tasks.create({ title: 'second', input: 'Find out X', start: false });
    expect(second.status).toBe('needs-me');
    await expect(ui.tasks.reply({ id: second.id, message: '  ', resume: true })).rejects.toThrow(/Write something/);
    const replied = await ui.tasks.reply({ id: second.id, message: 'go', resume: true });
    expect(replied).toMatchObject({ status: 'todo', next: 'fresh' });
    const todo = (await ui.tasks.list()).filter((t) => t.status === 'todo').map((t) => t.title);
    expect(todo).toEqual(['second', 'first']);
    expect(first.status).toBe('todo');
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
      body: { title: 'follow-up', input: 'do Y', labels: ['research'], status: 'needs-me', createdBy: 'agent', parentId: parent.id },
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
    const waiting = await ui.tasks.create({ title: 'replied', input: 'do it', start: false });
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
    const inherit = await ctx.call('laptop', 'add-task', { body: { title: 'a', labels: ['research'], parentId: parent.id, createdBy: 'agent', status: 'needs-me' } });
    expect(inherit.json.result.task.priority).toBe('high');
    const chosen = await ctx.call('laptop', 'add-task', { body: { title: 'b', labels: ['research'], parentId: parent.id, createdBy: 'agent', status: 'needs-me', priority: 'low' } });
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
    expect((await ctx.call('laptop', 'get-task', { id })).json.result).toMatchObject({ lane: null, borrowed: false, lastActiveAt: null });
    // A late heartbeat from a stopping worker does not bring the run back.
    await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'implement', borrowed: true } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.lane).toBeNull();
  });

  it('a paused task resumes next, on its machine, ahead of new urgent work', async () => {
    const ui = caller(db);
    const id = await running('paused', 'low');
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    const paused = await ctx.call('laptop', 'pause', { id, body: 'Paused on laptop: the reviews lane needed its slot.' });
    expect(paused.json.result).toMatchObject({ status: 'todo', next: 'resume', machine: 'laptop' });
    const list = await ui.tasks.list();
    expect(list.filter((t) => t.status === 'todo').map((t) => [t.title, t.paused])).toEqual([
      ['paused', true],
      ['urgent', false],
    ]);
    expect((await ctx.call('laptop', 'pause', { id, body: 'again' })).status).toBe(409);
    expect((await ctx.call('workstation', 'claim-task', { id, machine: 'workstation' })).status).toBe(409);
    await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    expect((await ui.tasks.get({ id })).task.paused).toBe(false);
    const { thread } = await ui.tasks.get({ id });
    expect(thread.some((n) => n.author === 'system' && n.text.startsWith('Paused on laptop'))).toBe(true);
  });
});

describe('prompts', () => {
  it('a task is labelled with its skill, titled by its first line, and can be pinned', async () => {
    const ui = caller(db);
    const review = await ui.tasks.create({ input: '/review-pr 17741\nplease look at the migration' });
    expect(review).toMatchObject({ title: '/review-pr 17741', labels: ['review-pr'], createdBy: 'user', machine: null, workdir: null });
    const plain = await ui.tasks.create({ input: 'Find out why the export is slow' });
    expect(plain.labels).toEqual([]);
    await expect(ui.tasks.create({ input: '   ' })).rejects.toThrow(/Write a prompt first/);
    const pinned = await ctx.call('laptop', 'add-task', { body: { title: 't', input: '/grill', machine: 'laptop', workdir: '/home/me/repo' } });
    expect(pinned.json.result.task).toMatchObject({ machine: 'laptop', workdir: '/home/me/repo', labels: ['grill'] });
  });
});
