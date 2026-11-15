import { describe, expect, it } from 'vitest';
import { startSlackApp, type SlashCommandEvent, type SocketLike } from './app';
import { IntakeError, type IntakeClient } from './intake';

function fakeSocket(starts: (attempt: number) => Promise<unknown> = async () => undefined) {
  let command: (event: SlashCommandEvent) => void = () => undefined;
  let error: (error: unknown) => void = () => undefined;
  let attempts = 0;
  const socket: SocketLike = {
    onCommand: (listener) => void (command = listener),
    onError: (listener) => void (error = listener),
    start: () => starts((attempts += 1)),
    disconnect: async () => undefined,
  };
  return {
    socket,
    send: (event: SlashCommandEvent) => command(event),
    fail: (e: unknown) => error(e),
    attempts: () => attempts,
  };
}

const intake: IntakeClient = {
  addToInbox: async () => ({ boardUrl: 'https://board' }),
  startLink: async () => ({ url: 'https://board/slack/link?code=c', minutes: 15 }),
  unlink: async () => true,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(
  overrides: {
    intake?: IntakeClient;
    reply?: (url: string, text: string) => Promise<void>;
    start?: (n: number) => Promise<unknown>;
  } = {},
) {
  const fake = fakeSocket(overrides.start);
  const logs: string[] = [];
  const replies: { url: string; text: string }[] = [];
  startSlackApp({
    socket: fake.socket,
    intake: overrides.intake ?? intake,
    reply: overrides.reply ?? (async (url, text) => void replies.push({ url, text })),
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    secrets: ['intake-secret'],
    sleep: async () => undefined,
  });
  const acks: unknown[][] = [];
  const event = (text: string, extra: object = {}): SlashCommandEvent => ({
    body: { team_id: 'T1', user_id: 'U1', text, response_url: 'https://hooks.slack.com/commands/T1/1/x', ...extra },
    ack: async (...args) => void acks.push(args),
  });
  return { ...fake, logs, replies, acks, event };
}

describe('the Slack app', () => {
  it('acknowledges at once and answers through the response URL', async () => {
    const app = setup();
    app.send(app.event('link'));
    await settle();
    expect(app.acks).toEqual([[]]);
    expect(app.replies).toHaveLength(1);
    expect(app.replies[0]).toMatchObject({ url: 'https://hooks.slack.com/commands/T1/1/x' });
    expect(app.replies[0]!.text).toContain('this link');
  });

  it('answers with an error text when the handler fails unexpectedly, and logs no text', async () => {
    const app = setup({
      intake: {
        ...intake,
        addToInbox: async () => {
          throw new Error('boom PRIVATE intake-secret');
        },
      },
    });
    app.send(app.event('PRIVATE'));
    await settle();
    expect(app.replies[0]!.text).toContain('Something went wrong');
    expect(app.logs.join()).toContain('boom');
    expect(app.logs.join()).not.toContain('intake-secret');
  });

  it('answers a board outage and keeps running', async () => {
    const app = setup({
      intake: {
        ...intake,
        addToInbox: async () => {
          throw new IntakeError('the board is unreachable (TypeError)');
        },
      },
    });
    app.send(app.event('do it'));
    await settle();
    expect(app.replies[0]!.text).toContain('did not answer');
    expect(app.logs).toContain('/board: the board is unreachable (TypeError)');
  });

  it('survives an acknowledgement that Slack no longer takes', async () => {
    const app = setup();
    const rejected = app.event('help');
    rejected.ack = () => Promise.reject(new Error('socket closed'));
    app.send(rejected);
    await settle();
    expect(app.logs.some((m) => m.includes('answer not sent: socket closed'))).toBe(true);
  });

  it('survives a response URL that fails', async () => {
    const app = setup({ reply: () => Promise.reject(new Error('hooks.slack.com unreachable')) });
    app.send(app.event('help'));
    await settle();
    expect(app.logs.some((m) => m.includes('answer not sent: hooks.slack.com unreachable'))).toBe(true);
  });

  it('sends no answer when the command has no response URL', async () => {
    const app = setup();
    app.send(app.event('help', { response_url: undefined }));
    await settle();
    expect(app.replies).toEqual([]);
  });

  it('retries the connection until it holds, logging each failure', async () => {
    const app = setup({ start: async (n) => (n < 3 ? Promise.reject(new Error('dns xapp-1-A-secret')) : undefined) });
    await settle();
    expect(app.attempts()).toBe(3);
    expect(app.logs.filter((m) => m.startsWith('Slack did not connect'))).toEqual([
      'Slack did not connect: dns [token]',
      'Slack did not connect: dns [token]',
    ]);
    expect(app.logs).toContain('connected to Slack');
  });

  it('logs socket errors', async () => {
    const app = setup();
    app.fail(new Error('ping timeout'));
    expect(app.logs).toContain('Slack socket: ping timeout');
  });
});
