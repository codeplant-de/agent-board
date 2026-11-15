import { describeError } from './errors';
import { handleCommand, type SlashCommand } from './handleCommand';
import type { IntakeClient } from './intake';

export interface Log {
  info(message: string): void;
  error(message: string): void;
}

/** A slash command as Slack delivers it over the socket. */
export interface SlashCommandEvent {
  body: SlashCommand & { response_url?: string };
  ack: (response?: object) => Promise<void>;
}

/** The part of the Slack Socket Mode client this app uses; tests hand in their own. */
export interface SocketLike {
  onCommand(listener: (event: SlashCommandEvent) => void): void;
  onError(listener: (error: unknown) => void): void;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface SlackAppDeps {
  socket: SocketLike;
  intake: IntakeClient;
  /** Sends the answer to a command's `response_url`. */
  reply: (responseUrl: string, text: string) => Promise<void>;
  log: Log;
  /** Secrets that must never reach the log, whatever an error says. */
  secrets?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface SlackApp {
  stop(): Promise<void>;
}

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * Answers `/board` and connects to Slack in the background. Slack or the board being down never stops it: a command that
 * cannot be answered costs a log line, and the connection is retried until it holds. Nothing here logs a token or what a
 * user typed.
 */
export function startSlackApp({
  socket,
  intake,
  reply,
  log,
  secrets = [],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: SlackAppDeps): SlackApp {
  const describe = (error: unknown): string => describeError(error, secrets);
  let stopped = false;

  const answer = async ({ body, ack }: SlashCommandEvent): Promise<void> => {
    // Slack wants the acknowledgement within three seconds; the board's answer follows through the response URL.
    await ack();
    const text = await handleCommand(intake, body, (error) => log.error(`/board: ${describe(error)}`)).catch(
      (error: unknown) => {
        log.error(`/board failed: ${describe(error)}`);
        return 'Something went wrong. Try again in a moment.';
      },
    );
    if (body.response_url) await reply(body.response_url, text);
  };

  socket.onCommand((event) => {
    answer(event).catch((error: unknown) => log.error(`/board answer not sent: ${describe(error)}`));
  });
  socket.onError((error) => log.error(`Slack socket: ${describe(error)}`));

  const connect = async (): Promise<void> => {
    for (let delay = RETRY_FIRST_MS; !stopped; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
      try {
        await socket.start();
        log.info('connected to Slack');
        return;
      } catch (error) {
        log.error(`Slack did not connect: ${describe(error)}`);
        await sleep(delay);
      }
    }
  };
  void connect();

  return {
    stop: async () => {
      stopped = true;
      await socket.disconnect().catch(() => undefined);
    },
  };
}
