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
    const unknownLabel = await ctx.call('laptop', 'add-task', { body: { title: 't', labels: ['nope'] } });
    expect(unknownLabel.json.error).toMatch(/unknown label nope/);
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
    const first = await ui.tasks.create({ title: 'first', input: '', label: 'research' });
    const second = await ui.tasks.create({ title: 'second', input: 'Find out X', label: 'research', start: false });
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
    const task = await ui.tasks.create({ title: 't', input: '', label: 'research' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await expect(ui.tasks.reply({ id: task.id, message: 'x', resume: true })).rejects.toThrow(/running/);
    await expect(ui.tasks.move({ id: task.id, status: 'done' })).rejects.toThrow(/running/);
    await expect(ui.tasks.setClosed({ id: task.id, closed: true })).rejects.toThrow(/running/);
    // A comment without resume is fine while it runs.
    await ui.tasks.reply({ id: task.id, message: 'fyi', resume: false });
  });

  it('agent proposals wait in needs-me until started; moving into Todo starts them', async () => {
    const ui = caller(db);
    const parent = await ui.tasks.create({ title: 'parent', input: '', label: 'research' });
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
    const a = await ui.tasks.create({ title: 'a', input: '', label: 'research' });
    const b = await ui.tasks.create({ title: 'b', input: '', label: 'research' });
    const c = await ui.tasks.create({ title: 'c', input: '', label: 'research' });
    await ui.tasks.move({ id: c.id, status: 'todo', afterId: a.id, beforeId: b.id });
    expect((await ui.tasks.list()).map((t) => t.title)).toEqual(['a', 'c', 'b']);
    await ui.tasks.move({ id: a.id, status: 'done' });
    await expect(ui.tasks.move({ id: b.id, status: 'running' })).rejects.toThrow(/Only a worker/);
  });

  it('done and re-run clear the open question; re-run forgets the session', async () => {
    const ui = caller(db);
    const task = await ui.tasks.create({ title: 't', input: '', label: 'research' });
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
