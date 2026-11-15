import { describe, expect, it } from 'vitest';
import { replyEphemeral } from './reply';

describe('replyEphemeral', () => {
  it('posts an ephemeral answer to a Slack response URL', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(init.body as string) });
      return new Response('ok');
    }) as unknown as typeof globalThis.fetch;
    await replyEphemeral('https://hooks.slack.com/commands/T1/2/abc', 'hi', { fetch });
    expect(sent).toEqual([
      { url: 'https://hooks.slack.com/commands/T1/2/abc', body: { response_type: 'ephemeral', text: 'hi' } },
    ]);
  });

  it('refuses any other URL, without sending anything', async () => {
    const fetch = (async () => {
      throw new Error('must not be called');
    }) as unknown as typeof globalThis.fetch;
    for (const url of [
      'http://hooks.slack.com/x',
      'https://evil.example/hooks.slack.com/x',
      'https://hooks.slack.com.evil.io/x',
    ])
      await expect(replyEphemeral(url, 'hi', { fetch })).rejects.toThrow('not a Slack URL');
  });

  it('reports a refusal by Slack', async () => {
    const fetch = (async () => new Response('no', { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(replyEphemeral('https://hooks.slack.com/commands/x', 'hi', { fetch })).rejects.toThrow('404');
  });
});
