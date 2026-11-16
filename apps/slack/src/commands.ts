import { INBOX_TEXT_MAX } from '@agent-board/shared';
import { decodeEntities } from './slackText';

export type SlackCommand =
  | { kind: 'help' }
  | { kind: 'link' }
  | { kind: 'unlink' }
  | { kind: 'add'; text: string }
  | { kind: 'too-long'; length: number };

/** What follows `/board`. A subcommand is the whole text: `/board link the docs` proposes a task. */
export function parseCommand(raw: string): SlackCommand {
  const text = decodeEntities(raw).trim();
  const word = text.toLowerCase();
  if (word === '' || word === 'help') return { kind: 'help' };
  if (word === 'link') return { kind: 'link' };
  if (word === 'unlink') return { kind: 'unlink' };
  if (text.length > INBOX_TEXT_MAX) return { kind: 'too-long', length: text.length };
  return { kind: 'add', text };
}
