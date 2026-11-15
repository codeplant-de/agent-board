import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { cleanupAllBoards } from './cleanup';
import { slackInbox, slackLinks } from './db/schema';
import { withOwner } from './db/scope';
import {
  addInboxItem,
  createLinkCode,
  getLink,
  listInbox,
  ownerOf,
  peekLinkCode,
  redeemLinkCode,
  removeInboxItem,
  removeLink,
} from './services/slack';
import { buildServer } from './server';
import { asOwner, caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = useTestDb();

const TEAM = 'T1';
const MINUTE = 60_000;
const who = { teamId: TEAM, slackUserId: 'U1' };
const link = (owner: string, slackUserId = 'U1') =>
  asOwner(db, owner, (tx) => tx.insert(slackLinks).values({ teamId: TEAM, slackUserId }));

describe('link codes', () => {
  it('binds the Slack user to whoever redeems the code, once', async () => {
    const code = await createLinkCode(db, who, 'ada');
    expect(await peekLinkCode(db, code)).toEqual({ slackUserId: 'U1', displayName: 'ada' });
    await asOwner(db, 'alice', (tx) => redeemLinkCode(tx, code));
    expect(await ownerOf(db, who)).toBe('alice');
    expect(await caller(db, 'alice').slack.status()).toMatchObject({ link: { displayName: 'ada' } });
    expect(await peekLinkCode(db, code)).toBeNull();
    await expect(asOwner(db, 'bob', (tx) => redeemLinkCode(tx, code))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a code after 15 minutes', async () => {
    const code = await createLinkCode(db, who, null, new Date(Date.now() - 16 * MINUTE));
    expect(await peekLinkCode(db, code)).toBeNull();
    await expect(asOwner(db, 'alice', (tx) => redeemLinkCode(tx, code))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const fresh = await createLinkCode(db, who, null, new Date(Date.now() - 14 * MINUTE));
    expect(await peekLinkCode(db, fresh)).toEqual({ slackUserId: 'U1', displayName: null });
  });

  it('keeps only the newest code of a Slack user, and stores only hashes', async () => {
    const first = await createLinkCode(db, who, null);
    const second = await createLinkCode(db, who, null);
    expect(await peekLinkCode(db, first)).toBeNull();
    expect(await peekLinkCode(db, second)).not.toBeNull();
    const { rows } = await admin.execute<{ code_hash: string }>(sql`select code_hash from slack_link_code`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).not.toBe(second);
  });

  it('cannot be read or changed by the request role directly', async () => {
    await createLinkCode(db, who, null);
    await expect(db.execute(sql`select * from slack_link_code`)).rejects.toThrow();
  });

  it('does not use the code up when the Slack user belongs to another board user', async () => {
    await link('alice');
    const code = await createLinkCode(db, who, null);
    await expect(caller(db, 'bob').slack.confirmLink({ code })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await peekLinkCode(db, code)).not.toBeNull();
  });

  it('replaces a user’s earlier link and unlinks', async () => {
    const alice = caller(db, 'alice');
    await alice.slack.confirmLink({ code: await createLinkCode(db, who, null) });
    await alice.slack.confirmLink({ code: await createLinkCode(db, { teamId: TEAM, slackUserId: 'U2' }, null) });
    expect(await alice.slack.status()).toMatchObject({ enabled: false, link: { slackUserId: 'U2' } });
    expect(await ownerOf(db, who)).toBeNull();
    await alice.slack.unlink();
    expect((await alice.slack.status()).link).toBeNull();
  });

  it('removes by Slack identity: a newer link of the same board user to another Slack user stays', async () => {
    await link('alice', 'U1');
    await asOwner(db, 'alice', async (tx) => {
      expect(await removeLink(tx, { teamId: TEAM, slackUserId: 'U9' })).toBe(false);
      expect(await removeLink(tx, who)).toBe(true);
    });
    await link('alice', 'U2');
    await asOwner(db, 'alice', async (tx) => {
      expect(await removeLink(tx, who)).toBe(false);
      expect(await getLink(tx)).toMatchObject({ slackUserId: 'U2' });
      expect(await removeLink(tx)).toBe(true);
    });
  });

  it('shows whom a code is for on the confirmation page', async () => {
    const code = await createLinkCode(db, who, 'ada');
    expect(await caller(db, 'alice').slack.peekLink({ code })).toEqual({ slackUserId: 'U1', displayName: 'ada' });
    await expect(caller(db, 'alice').slack.peekLink({ code: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the Slack inbox', () => {
  const item = { text: 'look at the flaky test', slackUserId: 'U1' };

  it('is private to its owner', async () => {
    await asOwner(db, 'alice', () => Promise.resolve());
    await asOwner(db, 'bob', () => Promise.resolve());
    await addInboxItem(db, 'alice', item);
    const alice = caller(db, 'alice');
    const bob = caller(db, 'bob');
    const [mine] = await alice.slack.inbox.list();
    expect(mine).toMatchObject({ text: item.text });
    expect(await bob.slack.inbox.list()).toEqual([]);

    await bob.slack.inbox.remove({ id: mine!.id });
    expect(await alice.slack.inbox.list()).toHaveLength(1);
    await expect(
      withOwner(db, 'bob', (tx) => tx.insert(slackInbox).values({ id: 'x', owner: 'alice', ...item })),
    ).rejects.toThrow();

    await alice.slack.inbox.remove({ id: mine!.id });
    expect(await alice.slack.inbox.list()).toEqual([]);
  });

  it('refuses empty and oversized text in the database', async () => {
    await asOwner(db, 'alice', () => Promise.resolve());
    await expect(addInboxItem(db, 'alice', { ...item, text: '' })).rejects.toThrow();
    await expect(addInboxItem(db, 'alice', { ...item, text: 'a'.repeat(4001) })).rejects.toThrow();
  });

  it('loses items after 30 days in the cleanup loop', async () => {
    await asOwner(db, 'alice', () => Promise.resolve());
    await addInboxItem(db, 'alice', item);
    const now = new Date(Date.now() + 29 * 24 * 60 * MINUTE);
    await cleanupAllBoards(db, { info: vi.fn(), error: vi.fn() }, now);
    expect(await withOwner(db, 'alice', (tx) => listInbox(tx))).toHaveLength(1);
    await cleanupAllBoards(db, { info: vi.fn(), error: vi.fn() }, new Date(now.getTime() + 2 * 24 * 60 * MINUTE));
    expect(await withOwner(db, 'alice', (tx) => listInbox(tx))).toEqual([]);
  });

  it('is not reachable from the machine API', async () => {
    await asOwner(db, 'alice', () => Promise.resolve());
    await addInboxItem(db, 'alice', item);
    const app = await buildServer(testConfig, db);
    const { token } = await caller(db, 'alice').machines.issue({ name: 'laptop' });
    const machine = (command: string) =>
      app.inject({
        method: 'POST',
        url: `/api/machine/${command}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    const listed = await machine('list-tasks');
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(item.text);
    expect((await machine('list-slack-inbox')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('removes an item', async () => {
    await asOwner(db, 'alice', () => Promise.resolve());
    await addInboxItem(db, 'alice', item);
    const [row] = await withOwner(db, 'alice', (tx) => listInbox(tx));
    await withOwner(db, 'alice', (tx) => removeInboxItem(tx, row!.id));
    expect(await admin.select().from(slackInbox).where(eq(slackInbox.id, row!.id))).toEqual([]);
  });
});
