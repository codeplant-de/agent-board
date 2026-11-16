import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntakeClient, IntakeError, NotLinkedError } from './intake';

const who = { teamId: 'T1', slackUserId: 'U1' };
const servers: Server[] = [];
afterEach(() => Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done)))));

/** A board that answers every call with `reply`, and records what it was sent. */
async function fakeBoard(reply: (command: string) => { status: number; body: unknown } | 'hang') {
  const seen: { url: string; authorization: string | undefined; body: unknown }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({
      url: req.url ?? '',
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
    });
    const answer = reply((req.url ?? '').split('/').pop() ?? '');
    if (answer === 'hang') return;
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { apiUrl, seen };
}

describe('the intake client', () => {
  it('sends the token and the command’s fields, and reads the answers', async () => {
    const board = await fakeBoard((command) => ({
      status: 200,
      body: {
        result:
          command === 'link'
            ? { url: 'https://board/slack/link?code=c', minutes: 15 }
            : command === 'unlink'
              ? { unlinked: true }
              : command === 'link-status'
                ? { linked: false }
                : { url: 'https://board' },
      },
    }));
    const intake = createIntakeClient({ apiUrl: board.apiUrl, token: 'tok' });
    expect(await intake.addToInbox(who, 'hi')).toEqual({ boardUrl: 'https://board' });
    expect(await intake.startLink(who, 'ada')).toEqual({ url: 'https://board/slack/link?code=c', minutes: 15 });
    expect(await intake.unlink(who)).toBe(true);
    expect(await intake.isLinked(who)).toBe(false);
    expect(board.seen).toEqual([
      { url: '/api/intake/inbox-add', authorization: 'Bearer tok', body: { ...who, text: 'hi' } },
      { url: '/api/intake/link', authorization: 'Bearer tok', body: { ...who, displayName: 'ada' } },
      { url: '/api/intake/unlink', authorization: 'Bearer tok', body: who },
      { url: '/api/intake/link-status', authorization: 'Bearer tok', body: who },
    ]);
  });

  it('turns a 409 on inbox-add into NotLinkedError', async () => {
    const board = await fakeBoard(() => ({ status: 409, body: { error: 'not linked' } }));
    const intake = createIntakeClient({ apiUrl: board.apiUrl, token: 'tok' });
    await expect(intake.addToInbox(who, 'hi')).rejects.toBeInstanceOf(NotLinkedError);
  });

  it('reports a refusal or a broken answer as IntakeError, without the text it sent', async () => {
    const refusing = await fakeBoard(() => ({ status: 401, body: { error: 'unknown intake token' } }));
    const error = await createIntakeClient({ apiUrl: refusing.apiUrl, token: 'tok' })
      .addToInbox(who, 'PRIVATE')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntakeError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('PRIVATE');

    const odd = await fakeBoard(() => ({ status: 200, body: { result: {} } }));
    await expect(createIntakeClient({ apiUrl: odd.apiUrl, token: 'tok' }).startLink(who, null)).rejects.toBeInstanceOf(
      IntakeError,
    );
  });

  it('reports an unreachable board and a board that does not answer', async () => {
    const down = createIntakeClient({ apiUrl: 'http://127.0.0.1:1', token: 'tok' });
    await expect(down.unlink(who)).rejects.toBeInstanceOf(IntakeError);
    const board = await fakeBoard(() => 'hang');
    const slow = createIntakeClient({ apiUrl: board.apiUrl, token: 'tok', timeoutMs: 50 });
    await expect(slow.unlink(who)).rejects.toBeInstanceOf(IntakeError);
  });
});
