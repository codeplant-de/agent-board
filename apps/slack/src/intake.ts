export interface SlackIdentity {
  teamId: string;
  slackUserId: string;
}

/** The sender has no board account linked. */
export class NotLinkedError extends Error {
  constructor() {
    super('not linked');
  }
}

/** The board did not take the call: unreachable, refused, or failed. Its message is safe to log. */
export class IntakeError extends Error {}

export interface IntakeClient {
  /** Puts `text` in the inbox of the board user `who` is linked to; throws NotLinkedError without a link. */
  addToInbox(who: SlackIdentity, text: string): Promise<{ boardUrl: string }>;
  /** Whether `who` has a board account linked. */
  isLinked(who: SlackIdentity): Promise<boolean>;
  startLink(who: SlackIdentity, displayName: string | null): Promise<{ url: string; minutes: number }>;
  /** False when there was no link to remove. */
  unlink(who: SlackIdentity): Promise<boolean>;
}

export interface IntakeClientOptions {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (result: unknown, name: string): string => {
  const value = isRecord(result) ? result[name] : undefined;
  if (typeof value !== 'string') throw new IntakeError(`the board's answer has no ${name}`);
  return value;
};

/** The calls of the backend's intake API (`POST /api/intake/<command>`), and nothing else. */
export function createIntakeClient({
  apiUrl,
  token,
  fetch: fetchImpl = fetch,
  timeoutMs = 10_000,
}: IntakeClientOptions): IntakeClient {
  async function call(command: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}/api/intake/${command}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new IntakeError(`the board is unreachable (${error instanceof Error ? error.name : 'failed'})`);
    }
    const answer: unknown = await response.json().catch(() => null);
    if (response.status === 409 && command === 'inbox-add') throw new NotLinkedError();
    if (!response.ok) {
      const reason = isRecord(answer) && typeof answer['error'] === 'string' ? answer['error'].slice(0, 120) : '';
      throw new IntakeError(`the board answered ${response.status} to ${command}${reason ? `: ${reason}` : ''}`);
    }
    if (!isRecord(answer)) throw new IntakeError(`the board's answer to ${command} is not JSON`);
    return answer['result'];
  }

  return {
    async addToInbox(who, text) {
      const result = await call('inbox-add', { ...who, text });
      return { boardUrl: stringField(result, 'url') };
    },
    async isLinked(who) {
      const result = await call('link-status', { ...who });
      const linked = isRecord(result) ? result['linked'] : undefined;
      if (typeof linked !== 'boolean') throw new IntakeError("the board's answer has no linked");
      return linked;
    },
    async startLink(who, displayName) {
      const result = await call('link', { ...who, displayName });
      const minutes = isRecord(result) ? result['minutes'] : undefined;
      if (typeof minutes !== 'number') throw new IntakeError("the board's answer has no minutes");
      return { url: stringField(result, 'url'), minutes };
    },
    async unlink(who) {
      const result = await call('unlink', { ...who });
      return isRecord(result) && result['unlinked'] === true;
    },
  };
}
