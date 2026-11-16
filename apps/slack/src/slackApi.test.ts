import { describe, expect, it } from 'vitest';
import { createSlackApi, SlackApiError } from './slackApi';

type Call = { url: string; init: RequestInit };

function api(answers: object[] | ((n: number) => object | Error)) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = typeof answers === 'function' ? answers(calls.length) : answers[calls.length - 1]!;
    if (next instanceof Error) throw next;
    return Response.json(next);
  }) as unknown as typeof fetch;
  return { calls, slack: createSlackApi({ botToken: 'xoxb-secret', fetch: fetchImpl }) };
}

describe('the Slack Web API client', () => {
  it('opens a view with a JSON body and the bearer token', async () => {
    const { calls, slack } = api([{ ok: true }]);
    await slack.openView('trig', { type: 'modal' });
    expect(calls[0]!.url).toBe('https://slack.com/api/views.open');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer xoxb-secret' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ trigger_id: 'trig', view: { type: 'modal' } });
  });

  it('pages through a thread up to the limit', async () => {
    const { calls, slack } = api([
      { ok: true, messages: [{ ts: '1.1', user: 'U1', text: 'a' }, 'junk'], response_metadata: { next_cursor: 'c2' } },
      { ok: true, messages: [{ ts: '2.1', text: 'b', files: [{}] }], response_metadata: { next_cursor: '' } },
    ]);
    expect(await slack.threadMessages('C1', '1.1', 10)).toEqual([
      { ts: '1.1', user: 'U1', text: 'a', hasFiles: false },
      { ts: '2.1', text: 'b', hasFiles: true },
    ]);
    expect(String(calls[1]!.init.body)).toContain('cursor=c2');
    expect(String(calls[0]!.init.body)).toContain('channel=C1');
  });

  it('stops at the limit even when Slack has more', async () => {
    const { calls, slack } = api(() => ({
      ok: true,
      messages: [{ ts: '1.1', text: 'a' }],
      response_metadata: { next_cursor: 'more' },
    }));
    expect(await slack.threadMessages('C1', '1.1', 3)).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });

  it('prefers the display name, then the real name', async () => {
    expect(
      await api([
        { ok: true, user: { name: 'ada', profile: { display_name: ' ', real_name: 'Ada L' } } },
      ]).slack.userName('U1'),
    ).toBe('Ada L');
    expect(await api([{ ok: true, user: { name: 'ada', profile: {} } }]).slack.userName('U1')).toBe('ada');
  });

  it('returns a permalink', async () => {
    expect(await api([{ ok: true, permalink: 'https://x/p1' }]).slack.permalink('C1', '1.1')).toBe('https://x/p1');
  });

  it("reports Slack's error code only", async () => {
    const error = await api([{ ok: false, error: 'not_in_channel', secret: 'xoxb-secret' }])
      .slack.threadMessages('C1', '1.1', 5)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackApiError);
    expect((error as Error).message).toBe('not_in_channel');
  });

  it('reports a network failure without its details', async () => {
    const error = await api(() => new Error('connect failed for xoxb-secret'))
      .slack.permalink('C1', '1.1')
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('xoxb-secret');
  });
});
