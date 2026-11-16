import { isRecord, SLACK_ID_PATTERN } from '@agent-board/shared';
import { IntakeError, NotLinkedError, type IntakeClient } from './intake';
import {
  FORM_FAILED_TEXT,
  NO_BOT_TOKEN_TEXT,
  NOT_LINKED_TEXT,
  NOTHING_TO_SEND_TEXT,
  threadAddedText,
  UNAVAILABLE_TEXT,
} from './messages';
import { isSlackResponseUrl } from './reply';
import type { SlackApi } from './slackApi';
import { composeInboxText, formatMessage, threadUserIds } from './threadText';

export const SHORTCUT_CALLBACK_ID = 'send_to_board';
export const MODAL_CALLBACK_ID = 'send_to_board_modal';

const NOTE_BLOCK_ID = 'note';
const NOTE_ACTION_ID = 'text';
const NOTE_MAX = 3000;
const THREAD_MESSAGES_MAX = 500;
const USERS_MAX = 50;
const TS_PATTERN = /^\d{1,12}\.\d{1,9}$/;
/** The link check has to leave time for views.open: Slack's trigger_id expires three seconds after the click. */
const LINK_CHECK_MS = 1_500;

/** An interactive payload as it arrives over the socket; its fields are checked before use. */
export interface InteractiveEvent {
  body: Record<string, unknown>;
  ack: (response?: object) => Promise<void>;
}

export interface ShortcutDeps {
  /** Null without a bot token: the shortcut then only says so. */
  api: SlackApi | null;
  intake: IntakeClient;
  reply: (responseUrl: string, text: string) => Promise<void>;
  /** Gets a failure as safe text; the text of a message never reaches it. */
  onError: (message: string, error: unknown) => void;
}

/** What the modal carries from the shortcut to its submission. Never message text: Slack caps it at 3000 characters. */
interface Context {
  channel: string;
  threadTs: string;
  messageTs: string;
  teamId: string;
  responseUrl: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const field = (value: unknown, name: string): unknown => (isRecord(value) ? value[name] : undefined);

const slackId = (value: unknown): string | undefined => {
  const id = text(value);
  return id !== undefined && SLACK_ID_PATTERN.test(id) ? id : undefined;
};
const slackTs = (value: unknown): string | undefined => {
  const ts = text(value);
  return ts !== undefined && TS_PATTERN.test(ts) ? ts : undefined;
};
const slackResponseUrl = (value: unknown): string | undefined => {
  const url = text(value);
  return url !== undefined && isSlackResponseUrl(url) ? url : undefined;
};

function readContext(raw: string | undefined): Context | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    return null;
  }
  const channel = slackId(field(parsed, 'c'));
  const threadTs = slackTs(field(parsed, 't'));
  const messageTs = slackTs(field(parsed, 'm'));
  const teamId = slackId(field(parsed, 'w'));
  const responseUrl = slackResponseUrl(field(parsed, 'r'));
  if (!channel || !threadTs || !messageTs || !teamId || !responseUrl) return null;
  return { channel, threadTs, messageTs, teamId, responseUrl };
}

function readShortcut(body: Record<string, unknown>): { triggerId: string; context: Context } | null {
  const message = body['message'];
  const messageTs = slackTs(field(message, 'ts'));
  const triggerId = text(body['trigger_id']);
  const channel = slackId(field(body['channel'], 'id'));
  const teamId = slackId(field(body['team'], 'id'));
  const responseUrl = slackResponseUrl(body['response_url']);
  if (!triggerId || !messageTs || !channel || !teamId || !responseUrl) return null;
  const threadTs = slackTs(field(message, 'thread_ts')) ?? messageTs;
  return { triggerId, context: { channel, threadTs, messageTs, teamId, responseUrl } };
}

function buildModal(context: Context): object {
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      c: context.channel,
      t: context.threadTs,
      m: context.messageTs,
      w: context.teamId,
      r: context.responseUrl,
    }),
    title: { type: 'plain_text', text: 'Send to board' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: NOTE_BLOCK_ID,
        optional: true,
        label: { type: 'plain_text', text: 'What should happen?' },
        element: {
          type: 'plain_text_input',
          action_id: NOTE_ACTION_ID,
          multiline: true,
          max_length: NOTE_MAX,
          placeholder: { type: 'plain_text', text: 'For example: schedule a follow-up' },
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'The whole thread and a link to it go to your board inbox.' }],
      },
    ],
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The handler of interactive payloads: the "Send to board" message shortcut and its modal. */
export function createShortcutHandler({
  api,
  intake,
  reply,
  onError,
}: ShortcutDeps): (event: InteractiveEvent) => Promise<void> {
  const say = async (responseUrl: string | undefined, message: string): Promise<void> => {
    if (responseUrl)
      await reply(responseUrl, message).catch((error: unknown) => onError('shortcut reply not sent', error));
  };

  async function onShortcut({ body, ack }: InteractiveEvent): Promise<void> {
    await ack();
    const responseUrl = slackResponseUrl(body['response_url']);
    if (!api) return say(responseUrl, NO_BOT_TOKEN_TEXT);
    const shortcut = readShortcut(body);
    if (!shortcut) {
      onError('shortcut payload is incomplete', null);
      return;
    }
    const userId = slackId(field(body['user'], 'id'));
    if (!userId) {
      onError('shortcut payload is incomplete', null);
      return;
    }
    // Someone without a link gets no form, and no thread is read for them. A check that fails or is slow lets the form
    // open: the submission is refused for a missing link anyway.
    const linked = await withTimeout(
      intake.isLinked({ teamId: shortcut.context.teamId, slackUserId: userId }),
      LINK_CHECK_MS,
    ).catch((error: unknown) => {
      onError('link check failed', error);
      return null;
    });
    if (linked === false) return say(shortcut.context.responseUrl, NOT_LINKED_TEXT);
    try {
      await api.openView(shortcut.triggerId, buildModal(shortcut.context));
    } catch (error) {
      onError('shortcut form not opened', error);
      await say(shortcut.context.responseUrl, FORM_FAILED_TEXT);
    }
  }

  async function composeText(context: Context, note: string): Promise<{ text: string; readThread: boolean } | null> {
    if (!api) return null;
    const [thread, permalink] = await Promise.allSettled([
      api.threadMessages(context.channel, context.threadTs, THREAD_MESSAGES_MAX),
      api.permalink(context.channel, context.messageTs),
    ]);
    if (thread.status === 'rejected') onError('thread not read', thread.reason);
    if (permalink.status === 'rejected') onError('permalink not read', permalink.reason);
    const link = permalink.status === 'fulfilled' ? permalink.value : null;
    const messages = thread.status === 'fulfilled' ? thread.value : null;
    if (!note && !link && !messages?.length) return null;

    const names = new Map<string, string>();
    if (messages) {
      await Promise.all(
        threadUserIds(messages)
          .slice(0, USERS_MAX)
          .map(async (id) => {
            const name = await api.userName(id).catch(() => null);
            if (name) names.set(id, name);
          }),
      );
    }
    const lines = messages ? messages.map((message) => formatMessage(message, names)) : null;
    return { text: composeInboxText({ note, permalink: link, lines }), readThread: lines !== null };
  }

  async function onSubmission({ body, ack }: InteractiveEvent): Promise<void> {
    await ack();
    const view = body['view'];
    const context = readContext(text(field(view, 'private_metadata')));
    const userId = slackId(field(body['user'], 'id'));
    if (!context || !userId) {
      onError('submission payload is invalid', null);
      return;
    }
    const input = field(field(field(field(view, 'state'), 'values'), NOTE_BLOCK_ID), NOTE_ACTION_ID);
    const note = text(field(input, 'value'))?.slice(0, NOTE_MAX) ?? '';
    const composed = await composeText(context, note);
    if (composed === null) return say(context.responseUrl, NOTHING_TO_SEND_TEXT);
    try {
      const { boardUrl } = await intake.addToInbox({ teamId: context.teamId, slackUserId: userId }, composed.text);
      await say(context.responseUrl, threadAddedText(boardUrl, composed.readThread));
    } catch (error) {
      if (error instanceof NotLinkedError) return say(context.responseUrl, NOT_LINKED_TEXT);
      if (!(error instanceof IntakeError)) throw error;
      onError('inbox not added', error);
      await say(context.responseUrl, UNAVAILABLE_TEXT);
    }
  }

  return async (event) => {
    const { body } = event;
    if (body['type'] === 'message_action' && body['callback_id'] === SHORTCUT_CALLBACK_ID) return onShortcut(event);
    if (body['type'] === 'view_submission' && field(body['view'], 'callback_id') === MODAL_CALLBACK_ID) {
      return onSubmission(event);
    }
    await event.ack();
  };
}
