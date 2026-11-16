import { describe, expect, it } from 'vitest';
import { IntakeError, NotLinkedError, type IntakeClient } from './intake';
import { NO_BOT_TOKEN_TEXT, NOT_LINKED_TEXT } from './messages';
import { createShortcutHandler, MODAL_CALLBACK_ID, SHORTCUT_CALLBACK_ID, type InteractiveEvent } from './shortcut';
import { SlackApiError, type SlackApi } from './slackApi';

const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/1/x';

function setup({
  api = {},
  intake = {},
  noApi = false,
}: { api?: Partial<SlackApi>; intake?: Partial<IntakeClient>; noApi?: boolean } = {}) {
  const order: string[] = [];
  const replies: { url: string; text: string }[] = [];
  const errors: string[] = [];
  const added: { who: object; text: string }[] = [];
  const slackApi: SlackApi = {
    openView: async () => void order.push('openView'),
    threadMessages: async () => {
      order.push('threadMessages');
      return [
        { ts: '1763285400.000100', user: 'U1', text: 'ship it <@U2>', hasFiles: false },
        { ts: '1763285460.000100', user: 'U2', text: 'ok', hasFiles: false },
      ];
    },
    userName: async (id) => ({ U1: 'Ada', U2: 'Bob' })[id] ?? null,
    permalink: async () => 'https://x.slack.com/archives/C1/p1763285460000100',
    ...api,
  };
  const intakeClient: IntakeClient = {
    addToInbox: async (who, text) => {
      added.push({ who, text });
      return { boardUrl: 'https://board' };
    },
    startLink: async () => ({ url: '', minutes: 1 }),
    unlink: async () => true,
    ...intake,
  };
  const handle = createShortcutHandler({
    api: noApi ? null : slackApi,
    intake: intakeClient,
    reply: async (url, text) => void replies.push({ url, text }),
    onError: (message) => void errors.push(message),
  });
  const event = (body: Record<string, unknown>): InteractiveEvent => ({
    body,
    ack: async (...args) => void order.push(args.length ? 'ack+body' : 'ack'),
  });
  return { handle, event, order, replies, errors, added };
}

const shortcutBody = (extra: Record<string, unknown> = {}) => ({
  type: 'message_action',
  callback_id: SHORTCUT_CALLBACK_ID,
  trigger_id: 'trig1',
  response_url: RESPONSE_URL,
  team: { id: 'T1' },
  user: { id: 'U1' },
  channel: { id: 'C1' },
  message: { ts: '1763285460.000100', thread_ts: '1763285400.000100', text: 'SECRET MESSAGE' },
  ...extra,
});

const submissionBody = (over: { metadata?: unknown; note?: string | null; user?: string } = {}) => ({
  type: 'view_submission',
  user: { id: over.user ?? 'U7' },
  view: {
    callback_id: MODAL_CALLBACK_ID,
    private_metadata:
      typeof over.metadata === 'string'
        ? over.metadata
        : JSON.stringify(
            over.metadata ?? { c: 'C1', t: '1763285400.000100', m: '1763285460.000100', w: 'T1', r: RESPONSE_URL },
          ),
    state: {
      values: {
        note: { text: { type: 'plain_text_input', value: over.note === undefined ? 'follow up' : over.note } },
      },
    },
  },
});

describe('the Send to board shortcut', () => {
  it('acks, then opens the modal before any other call, with no message text in the metadata', async () => {
    let view: { private_metadata: string; callback_id: string } | undefined;
    let trigger = '';
    const app = setup({
      api: {
        openView: async (t, v) => {
          app.order.push('openView');
          trigger = t;
          view = v as typeof view;
        },
      },
    });
    await app.handle(app.event(shortcutBody()));
    expect(app.order).toEqual(['ack', 'openView']);
    expect(trigger).toBe('trig1');
    expect(view?.callback_id).toBe(MODAL_CALLBACK_ID);
    expect(JSON.parse(view!.private_metadata)).toEqual({
      c: 'C1',
      t: '1763285400.000100',
      m: '1763285460.000100',
      w: 'T1',
      r: RESPONSE_URL,
    });
    expect(view!.private_metadata).not.toContain('SECRET');
    expect(view!.private_metadata.length).toBeLessThan(3000);
  });

  it('uses the clicked message as the thread root outside a thread', async () => {
    let metadata = '';
    const app = setup({
      api: { openView: async (_t, v) => void (metadata = (v as { private_metadata: string }).private_metadata) },
    });
    await app.handle(app.event(shortcutBody({ message: { ts: '1763285460.000100' } })));
    expect(JSON.parse(metadata)).toMatchObject({ t: '1763285460.000100', m: '1763285460.000100' });
  });

  it('says there is no bot token when none is configured', async () => {
    const app = setup({ noApi: true });
    await app.handle(app.event(shortcutBody()));
    expect(app.order).toEqual(['ack']);
    expect(app.replies).toEqual([{ url: RESPONSE_URL, text: NO_BOT_TOKEN_TEXT }]);
  });

  it('tells the user when the form does not open', async () => {
    const app = setup({ api: { openView: async () => Promise.reject(new SlackApiError('expired_trigger_id')) } });
    await app.handle(app.event(shortcutBody()));
    expect(app.replies).toHaveLength(1);
    expect(app.errors).toEqual(['shortcut form not opened']);
  });

  it("ignores a payload with a response URL that is not Slack's", async () => {
    const app = setup();
    await app.handle(app.event(shortcutBody({ response_url: 'https://evil.test/x' })));
    expect(app.order).toEqual(['ack']);
    expect(app.replies).toEqual([]);
  });

  it('only acks other interactions', async () => {
    const app = setup();
    await app.handle(app.event({ type: 'block_actions' }));
    await app.handle(app.event({ type: 'message_action', callback_id: 'other' }));
    expect(app.order).toEqual(['ack', 'ack']);
  });
});

describe('the submission of the modal', () => {
  it('acks first, then adds the whole thread for the submitter', async () => {
    const app = setup();
    await app.handle(app.event(submissionBody()));
    expect(app.order[0]).toBe('ack');
    expect(app.added).toHaveLength(1);
    expect(app.added[0]!.who).toEqual({ teamId: 'T1', slackUserId: 'U7' });
    expect(app.added[0]!.text).toBe(
      [
        'follow up',
        '',
        'From a Slack thread: https://x.slack.com/archives/C1/p1763285460000100',
        '---',
        'Ada (2025-11-16 09:30 UTC): ship it @Bob',
        'Bob (2025-11-16 09:31 UTC): ok',
      ].join('\n'),
    );
    expect(app.replies).toHaveLength(1);
    expect(app.replies[0]!.url).toBe(RESPONSE_URL);
    expect(app.replies[0]!.text).toContain('Added to your board inbox');
    expect(app.replies[0]!.text).not.toContain('could not be read');
  });

  it('falls back to the note and the link when the thread cannot be read, and says so', async () => {
    const app = setup({ api: { threadMessages: async () => Promise.reject(new SlackApiError('not_in_channel')) } });
    await app.handle(app.event(submissionBody()));
    expect(app.added[0]!.text).toContain('follow up');
    expect(app.added[0]!.text).toContain('From a Slack thread: https://x.slack.com');
    expect(app.added[0]!.text).toContain('could not be read: invite @Agent Board');
    expect(app.replies[0]!.text).toContain('Invite @Agent Board to the channel');
    expect(app.errors).toEqual(['thread not read']);
  });

  it('keeps the plain ids when user lookups fail', async () => {
    const app = setup({ api: { userName: async () => Promise.reject(new SlackApiError('missing_scope')) } });
    await app.handle(app.event(submissionBody()));
    expect(app.added[0]!.text).toContain('U1 (2025-11-16 09:30 UTC): ship it @U2');
  });

  it('sends the permalink alone when there is no note and the thread is empty', async () => {
    const app = setup({ api: { threadMessages: async () => [] } });
    await app.handle(app.event(submissionBody({ note: null })));
    expect(app.added[0]!.text).toBe('From a Slack thread: https://x.slack.com/archives/C1/p1763285460000100');
  });

  it('sends nothing when there is no note and nothing could be read', async () => {
    const app = setup({
      api: {
        threadMessages: async () => Promise.reject(new SlackApiError('channel_not_found')),
        permalink: async () => Promise.reject(new SlackApiError('channel_not_found')),
      },
    });
    await app.handle(app.event(submissionBody({ note: null })));
    expect(app.added).toEqual([]);
    expect(app.replies[0]!.text).toContain('Nothing was sent');
  });

  it('asks an unlinked submitter to link', async () => {
    const app = setup({ intake: { addToInbox: async () => Promise.reject(new NotLinkedError()) } });
    await app.handle(app.event(submissionBody()));
    expect(app.replies).toEqual([{ url: RESPONSE_URL, text: NOT_LINKED_TEXT }]);
  });

  it('says the board is unavailable when the intake fails', async () => {
    const app = setup({ intake: { addToInbox: async () => Promise.reject(new IntakeError('down')) } });
    await app.handle(app.event(submissionBody()));
    expect(app.replies[0]!.text).toContain('did not answer');
    expect(app.errors).toEqual(['inbox not added']);
  });

  it("does nothing with a response URL that is not Slack's or broken metadata", async () => {
    const app = setup();
    await app.handle(
      app.event(submissionBody({ metadata: { c: 'C1', t: '1.1', m: '1.1', w: 'T1', r: 'https://evil.test/hook' } })),
    );
    await app.handle(app.event(submissionBody({ metadata: 'not json' })));
    await app.handle(
      app.event(submissionBody({ metadata: { c: 'c1', t: '1.1', m: '1.1', w: 'T1', r: RESPONSE_URL } })),
    );
    expect(app.added).toEqual([]);
    expect(app.replies).toEqual([]);
    expect(app.errors).toHaveLength(3);
  });
});
