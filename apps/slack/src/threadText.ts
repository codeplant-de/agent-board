import { INBOX_TEXT_MAX } from '@agent-board/shared';
import { mentionedUserIds, renderSlackText } from './slackText';

/** One message of a thread, reduced to what the inbox text uses. */
export interface ThreadMessage {
  ts: string;
  /** The author's user id; bots have none. */
  user?: string;
  username?: string;
  text: string;
  hasFiles: boolean;
}

const LINE_MAX = 4000;

export const UNREADABLE_THREAD_NOTE =
  '(The thread could not be read: invite @Agent Board to the channel to include it.)';

/** The user ids of authors and mentions in a thread, each once. */
export function threadUserIds(messages: readonly ThreadMessage[]): string[] {
  const ids = messages.flatMap(({ user, text }) => [...(user ? [user] : []), ...mentionedUserIds(text)]);
  return [...new Set(ids)];
}

const formatTime = (ts: string): string =>
  `${new Date(Number.parseFloat(ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `Name (2026-11-16 09:30 UTC): text`, with the text as plain text. */
export function formatMessage(message: ThreadMessage, names: ReadonlyMap<string, string>): string {
  const author = (message.user ? (names.get(message.user) ?? message.user) : message.username) ?? 'bot';
  const body = renderSlackText(message.text, names).trim() || (message.hasFiles ? '[file]' : '[no text]');
  return clip(`${author} (${formatTime(message.ts)}): ${body}`, LINE_MAX);
}

export interface InboxTextParts {
  note: string;
  /** Null when Slack gave no permalink. */
  permalink: string | null;
  /** The thread as formatted lines, oldest first; null when it could not be read. */
  lines: readonly string[] | null;
}

const omitted = (count: number): string => `[… ${count} message${count === 1 ? '' : 's'} left out …]`;

/**
 * The inbox text of a thread: the note, the link, then the messages. Over the inbox limit it keeps the first message and
 * the newest ones and leaves the middle out.
 */
export function composeInboxText({ note, permalink, lines }: InboxTextParts, max: number = INBOX_TEXT_MAX): string {
  const head = [note.trim(), permalink ? `From a Slack thread: ${permalink}` : ''].filter(Boolean).join('\n\n');
  if (lines === null) return `${head}\n${UNREADABLE_THREAD_NOTE}`.trim().slice(0, max);
  if (lines.length === 0) return head.slice(0, max);

  const prefix = `${head}${head ? '\n---\n' : ''}`;
  const full = `${prefix}${lines.join('\n')}`;
  if (full.length <= max) return full;

  const [first = '', ...rest] = lines;
  let budget = max - prefix.length - first.length - omitted(lines.length).length - 2;
  const kept: string[] = [];
  for (const line of rest.slice().reverse()) {
    if (line.length + 1 > budget) break;
    kept.unshift(line);
    budget -= line.length + 1;
  }
  const dropped = rest.length - kept.length;
  return [prefix + first, ...(dropped > 0 ? [omitted(dropped)] : []), ...kept].join('\n').slice(0, max);
}
