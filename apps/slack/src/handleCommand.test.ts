import { INBOX_TEXT_MAX } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { handleCommand, type SlashCommand } from './handleCommand';
import { IntakeError, NotLinkedError, type IntakeClient } from './intake';

function fakeIntake(overrides: Partial<IntakeClient> = {}) {
  const calls: unknown[][] = [];
  const intake: IntakeClient = {
    addToInbox: async (...args) => (calls.push(['addToInbox', ...args]), { boardUrl: 'https://board' }),
    startLink: async (...args) => (
      calls.push(['startLink', ...args]),
      { url: 'https://board/slack/link?code=c', minutes: 15 }
    ),
    unlink: async (...args) => (calls.push(['unlink', ...args]), true),
    ...overrides,
  };
  return { intake, calls };
}

const command = (text: string): SlashCommand => ({ team_id: 'T1', user_id: 'U1', user_name: 'ada', text });
const who = { teamId: 'T1', slackUserId: 'U1' };
const run = (intake: IntakeClient, text: string, errors: IntakeError[] = []) =>
  handleCommand(intake, command(text), (e) => errors.push(e));

describe('handleCommand', () => {
  it('explains itself for empty text and help, without calling the board', async () => {
    const { intake, calls } = fakeIntake();
    expect(await run(intake, '')).toContain('/board link');
    expect(await run(intake, 'help')).toContain('/board unlink');
    expect(calls).toEqual([]);
  });

  it('hands out the link the board made, with the sender’s handle', async () => {
    const { intake, calls } = fakeIntake();
    expect(await run(intake, 'link')).toContain('<https://board/slack/link?code=c|this link>');
    expect(calls).toEqual([['startLink', who, 'ada']]);
  });

  it('sends other text to the inbox', async () => {
    const { intake, calls } = fakeIntake();
    expect(await run(intake, ' do the thing ')).toContain('Added to your board inbox');
    expect(calls).toEqual([['addToInbox', who, 'do the thing']]);
  });

  it('refuses text over the limit before asking the board', async () => {
    const { intake, calls } = fakeIntake();
    expect(await run(intake, 'a'.repeat(INBOX_TEXT_MAX + 1))).toContain(String(INBOX_TEXT_MAX + 1));
    expect(calls).toEqual([]);
  });

  it('tells an unlinked sender to run /board link first', async () => {
    const { intake } = fakeIntake({
      addToInbox: async () => {
        throw new NotLinkedError();
      },
    });
    expect(await run(intake, 'do the thing')).toContain('Run `/board link` first');
  });

  it('says whether there was a link to remove', async () => {
    expect(await run(fakeIntake().intake, 'unlink')).toContain('no longer linked');
    expect(await run(fakeIntake({ unlink: async () => false }).intake, 'unlink')).toContain('was not linked');
  });

  it('answers a board that failed, and hands the failure to the log', async () => {
    const failure = new IntakeError('the board is unreachable (TypeError)');
    const { intake } = fakeIntake({
      addToInbox: async () => {
        throw failure;
      },
    });
    const errors: IntakeError[] = [];
    expect(await run(intake, 'do the thing', errors)).toContain('did not answer');
    expect(errors).toEqual([failure]);
  });
});
