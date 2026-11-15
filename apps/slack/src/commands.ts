import { INBOX_TEXT_MAX } from '@agent-board/shared';

export type SlackCommand =
  | { kind: 'help' }
  | { kind: 'link' }
  | { kind: 'unlink' }
  | { kind: 'add'; text: string }
  | { kind: 'too-long'; length: number };

/** What follows `/board`. A subcommand is the whole text: `/board link the docs` proposes a task. */
export function parseCommand(raw: string): SlackCommand {
  // Slack sends & < > in a command's text as entities; `&amp;` goes last so `&amp;lt;` stays literal.
  const text = raw.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').trim();
  const word = text.toLowerCase();
  if (word === '' || word === 'help') return { kind: 'help' };
  if (word === 'link') return { kind: 'link' };
  if (word === 'unlink') return { kind: 'unlink' };
  if (text.length > INBOX_TEXT_MAX) return { kind: 'too-long', length: text.length };
  return { kind: 'add', text };
}
