import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLinkCode } from './services/slack';
import { buildServer } from './server';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db } = useTestDb();

type Server = Awaited<ReturnType<typeof buildServer>>;
let app: Server;
let url: string;

beforeEach(async () => {
  app = await buildServer(testConfig, db);
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(() => app.close());

const signedIn = { 'remote-user': 'jascha', 'remote-groups': 'admins' };

/** Over a real socket: `inject` does not hand tRPC a multipart body the way a server does. */
describe('writes to /trpc', () => {
  const linkUp = async () => {
    await caller(db, 'jascha').slack.confirmLink({
      code: await createLinkCode(db, { teamId: 'T1', slackUserId: 'U1' }, 'ada'),
    });
    expect((await caller(db, 'jascha').slack.status()).link).not.toBeNull();
  };
  const linked = async () => (await caller(db, 'jascha').slack.status()).link !== null;

  // `%74` is `t`, `%72` is `r`: Fastify routes on the decoded path.
  it.each(['/trpc/slack.unlink', '/%74rpc/slack.unlink', '/t%72pc/slack.unlink'])(
    'refuses a form post to %s, which would otherwise run the mutation',
    async (path) => {
      await linkUp();
      const form = new FormData();
      form.append('0', '{}');
      const res = await fetch(`${url}${path}`, { method: 'POST', headers: signedIn, body: form });
      expect(res.status).toBe(415);
      expect(await linked()).toBe(true);
    },
  );

  it('refuses urlencoded, plain text and typeless writes too', async () => {
    await linkUp();
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', undefined]) {
      const res = await fetch(`${url}/trpc/slack.unlink`, {
        method: 'POST',
        headers: { ...signedIn, ...(type ? { 'content-type': type } : {}) },
        body: type ? '{}' : undefined,
      });
      expect(res.status).toBe(415);
    }
    expect(await linked()).toBe(true);
  });

  it('still runs a JSON mutation', async () => {
    await linkUp();
    const res = await fetch(`${url}/trpc/slack.unlink`, {
      method: 'POST',
      headers: { ...signedIn, 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await linked()).toBe(false);
  });
});
