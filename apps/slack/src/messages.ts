import { INBOX_TEXT_MAX } from '@agent-board/shared';

export const HELP_TEXT = [
  '*Usage*',
  '`/board <text>`: propose a task; it lands in your board inbox, where you review it and create the task',
  '`/board link`: link this Slack account to your board account',
  '`/board unlink`: remove the link',
  '`/board help`: this text',
  'In a thread, where Slack refuses slash commands: open the message\'s "..." menu, pick *Send to board* and add a note. The whole thread goes to your inbox.',
].join('\n');

export const NOT_LINKED_TEXT =
  'Your Slack account is not linked to a board account yet. Run `/board link` first, then open the link it gives you.';

export const UNAVAILABLE_TEXT = 'The board did not answer. Try again in a moment.';

export const tooLongText = (length: number): string =>
  `That is ${length} characters; a proposal can have at most ${INBOX_TEXT_MAX}.`;

export const linkText = (url: string, minutes: number): string =>
  `Open <${url}|this link> while signed in to the board to link your Slack account. It works once, for ${minutes} minutes.`;

export const addedText = (boardUrl: string): string =>
  `Added to your board inbox: <${boardUrl}/|open the board>. The text is stored unencrypted until you turn it into a task.`;

export const UNLINKED_TEXT = 'Your Slack account is no longer linked.';
export const NOTHING_TO_UNLINK_TEXT = 'Your Slack account was not linked.';

export const NO_BOT_TOKEN_TEXT =
  "The board's Slack app has no bot token configured, so the Send to board shortcut is off. Use `/board <text>`.";

export const FORM_FAILED_TEXT = 'The Send to board form did not open. Try the shortcut again.';

export const NOTHING_TO_SEND_TEXT =
  'Nothing was sent: the message could not be read and you wrote no note. Invite @Agent Board to the channel, or write a note.';

export const threadAddedText = (boardUrl: string, readThread: boolean): string =>
  readThread
    ? addedText(boardUrl)
    : `${addedText(boardUrl)} Only your note and the link went in: the thread could not be read. Invite @Agent Board to the channel to include it.`;
