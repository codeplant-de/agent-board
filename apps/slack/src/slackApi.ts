import { isRecord } from '@agent-board/shared';
import type { ThreadMessage } from './threadText';

/** A Slack Web API call that failed. The message is Slack's error code (`not_in_channel`) or a short reason, never a payload. */
export class SlackApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface SlackApi {
  /** Opens a modal for the `trigger_id` of an interaction; Slack lets it expire after three seconds. */
  openView(triggerId: string, view: object): Promise<void>;
  /** The thread's messages, oldest first, at most `limit` of them. */
  threadMessages(channel: string, threadTs: string, limit: number): Promise<ThreadMessage[]>;
  /** The display name of a user, or null when Slack has none. */
  userName(userId: string): Promise<string | null>;
  permalink(channel: string, messageTs: string): Promise<string>;
}

export interface SlackApiOptions {
  botToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const PAGE_SIZE = 100;

function toMessage(raw: unknown): ThreadMessage | null {
  if (!isRecord(raw) || typeof raw['ts'] !== 'string') return null;
  const { ts, user, username, text, files } = raw;
  return {
    ts,
    ...(typeof user === 'string' ? { user } : {}),
    ...(typeof username === 'string' ? { username } : {}),
    text: typeof text === 'string' ? text : '',
    hasFiles: Array.isArray(files) && files.length > 0,
  };
}

/** The few Web API methods the shortcut needs, over `fetch`. Errors carry Slack's error code only. */
export function createSlackApi({ botToken, fetch: fetchImpl = fetch, timeoutMs = 10_000 }: SlackApiOptions): SlackApi {
  async function call(method: string, params: Record<string, string>, json?: object): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${botToken}`,
          'content-type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
        },
        body: json ? JSON.stringify(json) : new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SlackApiError(`${method} unreachable (${error instanceof Error ? error.name : 'failed'})`);
    }
    const answer: unknown = await response.json().catch(() => null);
    if (!isRecord(answer)) throw new SlackApiError(`${method} answered ${response.status} without JSON`);
    if (answer['ok'] !== true) {
      const code = typeof answer['error'] === 'string' ? answer['error'].slice(0, 60) : 'unknown_error';
      throw new SlackApiError(code);
    }
    return answer;
  }

  return {
    async openView(triggerId, view) {
      await call('views.open', {}, { trigger_id: triggerId, view });
    },
    async threadMessages(channel, threadTs, limit) {
      const messages: ThreadMessage[] = [];
      let cursor = '';
      while (messages.length < limit) {
        const page = await call('conversations.replies', {
          channel,
          ts: threadTs,
          limit: String(Math.min(PAGE_SIZE, limit - messages.length)),
          ...(cursor ? { cursor } : {}),
        });
        const raw = Array.isArray(page['messages']) ? page['messages'] : [];
        messages.push(...raw.map(toMessage).filter((message): message is ThreadMessage => message !== null));
        const meta = page['response_metadata'];
        cursor = isRecord(meta) && typeof meta['next_cursor'] === 'string' ? meta['next_cursor'] : '';
        if (!cursor) break;
      }
      return messages;
    },
    async userName(userId) {
      const { user } = await call('users.info', { user: userId });
      if (!isRecord(user)) return null;
      const profile = isRecord(user['profile']) ? user['profile'] : {};
      const name = [profile['display_name'], profile['real_name'], user['real_name'], user['name']].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
      );
      return name?.trim() ?? null;
    },
    async permalink(channel, messageTs) {
      const { permalink } = await call('chat.getPermalink', { channel, message_ts: messageTs });
      if (typeof permalink !== 'string') throw new SlackApiError('no permalink');
      return permalink;
    },
  };
}
