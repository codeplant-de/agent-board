/**
 * The Slack intake API, for the Slack companion (`apps/slack`): POST /api/intake/<command> with the shared bearer token
 * INTAKE_TOKEN. The answer is {result} or {error}. The token reaches three things only: an inbox item for the board user a Slack
 * user is linked to, the start of a link, and the removal of a link. It reads and changes no task. Off unless INTAKE_TOKEN is set.
 */
import { INBOX_TEXT_MAX, isRecord, SLACK_ID_PATTERN, SLACK_NAME_MAX } from '@agent-board/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IntakeConfig } from './config';
import type { Db } from './db/client';
import { withOwner } from './db/scope';
import { AppError } from './services/errors';
import { addInboxItem, createLinkCode, LINK_CODE_MINUTES, ownerOf, removeLink } from './services/slack';
import type { SlackIdentity } from './services/slack';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Compares digests, so neither the length nor the content of the token shows in the time it takes. */
export function isIntakeToken(config: IntakeConfig, req: FastifyRequest): boolean {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  return timingSafeEqual(digest(given), digest(config.token));
}

function identityOf(body: Record<string, unknown>): SlackIdentity {
  const { teamId, slackUserId } = body;
  if (typeof teamId !== 'string' || !SLACK_ID_PATTERN.test(teamId))
    throw new AppError('BAD_REQUEST', 'teamId is required');
  if (typeof slackUserId !== 'string' || !SLACK_ID_PATTERN.test(slackUserId))
    throw new AppError('BAD_REQUEST', 'slackUserId is required');
  return { teamId, slackUserId };
}

function displayNameOf(body: Record<string, unknown>): string | null {
  const { displayName } = body;
  if (displayName === undefined || displayName === null) return null;
  if (typeof displayName !== 'string') throw new AppError('BAD_REQUEST', 'displayName must be text');
  return displayName.trim().slice(0, SLACK_NAME_MAX) || null;
}

function textOf(body: Record<string, unknown>): string {
  const { text } = body;
  if (typeof text !== 'string' || text.trim() === '') throw new AppError('BAD_REQUEST', 'text is required');
  if (text.length > INBOX_TEXT_MAX) throw new AppError('BAD_REQUEST', `text has at most ${INBOX_TEXT_MAX} characters`);
  return text;
}

export async function handleIntakeCall(
  db: Db,
  config: IntakeConfig,
  command: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case 'inbox-add': {
      const who = identityOf(body);
      const text = textOf(body);
      const owner = await ownerOf(db, who);
      if (owner === null) throw new AppError('CONFLICT', 'not linked');
      await addInboxItem(db, owner, { text, slackUserId: who.slackUserId });
      return { url: config.boardUrl };
    }
    case 'link': {
      const code = await createLinkCode(db, identityOf(body), displayNameOf(body));
      return { url: `${config.boardUrl}/slack/link?code=${code}`, minutes: LINK_CODE_MINUTES };
    }
    case 'unlink': {
      const who = identityOf(body);
      const owner = await ownerOf(db, who);
      const unlinked = owner !== null && (await withOwner(db, owner, (tx) => removeLink(tx, who)));
      return { unlinked };
    }
    default:
      throw new AppError('NOT_FOUND', `unknown command ${command.slice(0, 40)}`);
  }
}

/** A failed query's message carries its parameters, which here can be a user's text: only the driver's own error is logged. */
function reasonOf(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const source = cause instanceof Error ? cause : error;
  return (source instanceof Error ? source.message : String(source)).replace(/\nparams:[\s\S]*$/, '');
}

export function registerIntakeApi(app: FastifyInstance, db: Db, config: IntakeConfig): void {
  app.post<{ Params: { command: string } }>('/api/intake/:command', async (req) => {
    if (!isIntakeToken(config, req)) throw new AppError('UNAUTHORIZED', 'unknown intake token');
    const body = isRecord(req.body) ? req.body : {};
    try {
      return { result: await handleIntakeCall(db, config, req.params.command, body) };
    } catch (error) {
      if (error instanceof AppError) throw error;
      app.log.error({ command: req.params.command, reason: reasonOf(error) }, 'intake call failed');
      // eslint-disable-next-line preserve-caught-error -- the cause carries the user's text, and the error handler logs causes
      throw new Error('intake call failed');
    }
  });
}
