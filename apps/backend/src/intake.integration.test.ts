import { INBOX_TEXT_MAX } from '@agent-board/shared';
import { eq, sql } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntakeClient, IntakeError, NotLinkedError } from '../../slack/src/intake';
import type { Config } from './config';
import { slackInbox, slackLinks, tasks } from './db/schema';
import { buildServer } from './server';
import { asOwner, caller, SEALED, testConfig, useTestDb } from './test/helpers';

const { db, admin } = useTestDb();

const TOKEN = 'intake-token-0123456789abcdef0123456789';
const BOARD = 'https://board.example.com';
const config: Config = { ...testConfig, intake: { token: TOKEN, boardUrl: BOARD } };
const who = { teamId: 'T1', slackUserId: 'U1' };

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve(options: Partial<Config> = {}) {
  const app = await buildServer({ ...config, ...options }, db);
  open.push(app);
  const call = (command: string, body: unknown, token: string | null = TOKEN) =>
    app.inject({
      method: 'POST',
      url: `/api/intake/${command}`,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      payload: body as object,
    });
  return { app, call };
}

describe('the intake API', () => {
  it('is off without INTAKE_TOKEN', async () => {
    const { call } = await serve({ intake: null });
    expect((await call('link', who)).statusCode).toBe(404);
  });

  it('refuses a missing, wrong or near-miss token', async () => {
    const { call } = await serve();
    expect((await call('link', who, null)).statusCode).toBe(401);
    expect((await call('link', who, 'nope')).statusCode).toBe(401);
    expect((await call('link', who, TOKEN.slice(0, -1))).statusCode).toBe(401);
    expect((await call('link', who, `${TOKEN}x`)).statusCode).toBe(401);
  });

  it('takes no machine token and no browser login in its place', async () => {
    const { app } = await serve({ devAuthUser: 'alice' });
    const { token } = await caller(db, 'alice').machines.issue({ name: 'laptop' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/intake/link',
      headers: { authorization: `Bearer ${token}`, 'remote-user': 'alice' },
      payload: who,
    });
    expect(res.statusCode).toBe(401);
  });

  it('knows three commands and nothing that touches a task', async () => {
    const { call } = await serve();
    for (const command of ['list-tasks', 'get-task', 'add-task', 'claim-task'])
      expect((await call(command, who)).statusCode).toBe(404);
  });

  it('starts a link whose code the board user confirms, then takes inbox text for them', async () => {
    const { call } = await serve();
    const started = await call('link', { ...who, displayName: 'ada' });
    expect(started.statusCode).toBe(200);
    const { url, minutes } = started.json().result as { url: string; minutes: number };
    expect(minutes).toBe(15);
    expect(url.startsWith(`${BOARD}/slack/link?code=`)).toBe(true);

    expect((await call('inbox-add', { ...who, text: 'do the thing' })).statusCode).toBe(409);
    expect(await admin.select().from(slackInbox)).toEqual([]);

    await caller(db, 'alice').slack.confirmLink({ code: new URL(url).searchParams.get('code')! });
    const added = await call('inbox-add', { ...who, text: 'do the thing' });
    expect(added.json()).toEqual({ result: { url: BOARD } });
    expect(await admin.select().from(slackInbox)).toMatchObject([
      { owner: 'alice', text: 'do the thing', slackUserId: 'U1' },
    ]);
  });

  it('never creates or changes a task', async () => {
    const { call } = await serve();
    await asOwner(db, 'alice', (tx) => tx.insert(slackLinks).values(who));
    await call('inbox-add', { ...who, text: 'do the thing' });
    expect(await admin.select().from(tasks)).toEqual([]);
    await asOwner(db, 'alice', (tx) =>
      tx.insert(tasks).values({ id: 'abc', title: SEALED, input: SEALED, position: 0 }),
    );
    await call('inbox-add', { ...who, text: 'abc' });
    await call('unlink', who);
    expect(await admin.select({ id: tasks.id, status: tasks.status }).from(tasks)).toEqual([
      { id: 'abc', status: 'todo' },
    ]);
  });

  it('unlinks the Slack user, once', async () => {
    const { call } = await serve();
    await asOwner(db, 'alice', (tx) => tx.insert(slackLinks).values(who));
    expect((await call('unlink', who)).json()).toEqual({ result: { unlinked: true } });
    expect((await call('unlink', who)).json()).toEqual({ result: { unlinked: false } });
    expect(await admin.select().from(slackLinks)).toEqual([]);
  });

  it('unlinks only the Slack user it is given', async () => {
    const { call } = await serve();
    await asOwner(db, 'alice', (tx) => tx.insert(slackLinks).values({ teamId: 'T1', slackUserId: 'U2' }));
    expect((await call('unlink', who)).json()).toEqual({ result: { unlinked: false } });
    expect(await admin.select().from(slackLinks)).toHaveLength(1);
  });

  it('checks what it is given', async () => {
    const { call } = await serve();
    await asOwner(db, 'alice', (tx) => tx.insert(slackLinks).values(who));
    expect((await call('inbox-add', { ...who, text: '' })).statusCode).toBe(400);
    expect((await call('inbox-add', { ...who, text: '   ' })).statusCode).toBe(400);
    expect((await call('inbox-add', { ...who, text: 'a'.repeat(INBOX_TEXT_MAX + 1) })).statusCode).toBe(400);
    expect((await call('inbox-add', { ...who, text: 7 })).statusCode).toBe(400);
    expect((await call('inbox-add', { teamId: 'x y', slackUserId: 'U1', text: 'a' })).statusCode).toBe(400);
    expect((await call('link', { teamId: 'T1' })).statusCode).toBe(400);
    expect((await call('link', { ...who, displayName: 3 })).statusCode).toBe(400);
    expect(await admin.select().from(slackInbox).where(eq(slackInbox.owner, 'alice'))).toEqual([]);
  });

  it('does not put the text of a failing call in the log', async () => {
    const { app, call } = await serve();
    await asOwner(db, 'alice', (tx) => tx.insert(slackLinks).values(who));
    const logged: string[] = [];
    vi.spyOn(app.log, 'error').mockImplementation(
      ((...args: unknown[]) => void logged.push(JSON.stringify(args))) as never,
    );
    await admin.execute(sql`alter table slack_inbox add constraint refuse_all check (false) not valid`);
    try {
      const res = await call('inbox-add', { ...who, text: 'SECRET_INBOX_TEXT' });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('SECRET_INBOX_TEXT');
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join()).not.toContain('SECRET_INBOX_TEXT');
    } finally {
      await admin.execute(sql`alter table slack_inbox drop constraint refuse_all`);
    }
  });
});

describe('the Slack app’s client against the real API', () => {
  async function listening() {
    const { app } = await serve();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const client = (token = TOKEN) => createIntakeClient({ apiUrl: `http://127.0.0.1:${port}`, token });
    return { client };
  }

  it('links, adds to the inbox, and unlinks', async () => {
    const { client } = await listening();
    const intake = client();
    await expect(intake.addToInbox(who, 'hello')).rejects.toBeInstanceOf(NotLinkedError);
    const { url } = await intake.startLink(who, null);
    await caller(db, 'alice').slack.confirmLink({ code: new URL(url).searchParams.get('code')! });
    expect(await intake.addToInbox(who, 'hello')).toEqual({ boardUrl: BOARD });
    expect(await intake.unlink(who)).toBe(true);
    expect(await intake.unlink(who)).toBe(false);
  });

  it('reports a refused token without repeating it', async () => {
    const { client } = await listening();
    const error = await client('wrong-token')
      .unlink(who)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntakeError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('wrong-token');
  });
});
