import { parseCommand } from './commands';
import { IntakeError, NotLinkedError, type IntakeClient } from './intake';
import {
  addedText,
  HELP_TEXT,
  linkText,
  NOT_LINKED_TEXT,
  NOTHING_TO_UNLINK_TEXT,
  tooLongText,
  UNAVAILABLE_TEXT,
  UNLINKED_TEXT,
} from './messages';

/** The fields of a `/board` slash command that matter here. */
export interface SlashCommand {
  team_id: string;
  user_id: string;
  user_name?: string;
  text?: string;
}

/**
 * The answer to a `/board` command, only ever shown to the person who sent it. A board that cannot be reached is an
 * answer too; `onError` gets the failure for the log, which never sees the command's text.
 */
export async function handleCommand(
  intake: IntakeClient,
  command: SlashCommand,
  onError: (error: IntakeError) => void,
): Promise<string> {
  const who = { teamId: command.team_id, slackUserId: command.user_id };
  const parsed = parseCommand(command.text ?? '');
  try {
    switch (parsed.kind) {
      case 'help':
        return HELP_TEXT;
      case 'too-long':
        return tooLongText(parsed.length);
      case 'link': {
        const { url, minutes } = await intake.startLink(who, command.user_name?.trim() || null);
        return linkText(url, minutes);
      }
      case 'unlink':
        return (await intake.unlink(who)) ? UNLINKED_TEXT : NOTHING_TO_UNLINK_TEXT;
      case 'add':
        return addedText((await intake.addToInbox(who, parsed.text)).boardUrl);
    }
  } catch (error) {
    if (error instanceof NotLinkedError) return NOT_LINKED_TEXT;
    if (!(error instanceof IntakeError)) throw error;
    onError(error);
    return UNAVAILABLE_TEXT;
  }
}
