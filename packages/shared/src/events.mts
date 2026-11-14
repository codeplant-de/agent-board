// The events the board server writes into a thread itself, in plain text ("Marked done."). They are the only note bodies
// that are not sealed, so a client accepts a plain body only when it is one of these texts: the server writes them with
// `formatServerEvent`, and `isServerEventText` is what both clients check a plain note against.
import { MACHINE_NAME_PATTERN, PRIORITIES, STATUSES, TAKE_BACK_AFTER_MS } from './contract.mts';
import type { Priority, Status } from './contract.mts';

export type ServerEvent =
  | { type: 'done' }
  | { type: 'rerun' }
  | { type: 'closed' }
  | { type: 'reopened' }
  | { type: 'archived'; days: number }
  | { type: 'moved'; from: Status; to: Status }
  | { type: 'priority'; from: Priority; to: Priority }
  | { type: 'start-cleared' }
  | { type: 'start-set'; at: Date }
  // `machine` is the one that ran the task, or null when it never had one.
  | { type: 'taken-back'; machine: string | null };

const TAKE_BACK_MINUTES = TAKE_BACK_AFTER_MS / 60_000;

export function formatServerEvent(event: ServerEvent): string {
  switch (event.type) {
    case 'done':
      return 'Marked done.';
    case 'rerun':
      return 'Queued for a fresh run.';
    case 'closed':
      return 'Closed.';
    case 'reopened':
      return 'Reopened.';
    case 'archived':
      return `Closed after ${event.days} days in Done.`;
    case 'moved':
      return `Moved from ${event.from} to ${event.to}.`;
    case 'priority':
      return `Priority ${event.from} → ${event.to}.`;
    case 'start-cleared':
      return 'Start time cleared.';
    case 'start-set':
      return `Start time set to ${event.at.toISOString()}.`;
    case 'taken-back':
      return `Taken back from ${event.machine ?? 'its worker'}: no sign of life for ${TAKE_BACK_MINUTES} minutes.`;
  }
}

const oneOf = (values: readonly string[]): string => `(?:${values.join('|')})`;
const STATUS = oneOf(STATUSES);
const PRIORITY = oneOf(PRIORITIES);

// One per `formatServerEvent` case; the tests check that every text it writes matches and that near misses do not.
const SERVER_EVENT_PATTERNS: RegExp[] = [
  /^Marked done\.$/,
  /^Queued for a fresh run\.$/,
  /^Closed\.$/,
  /^Reopened\.$/,
  /^Closed after \d{1,4} days in Done\.$/,
  new RegExp(`^Moved from ${STATUS} to ${STATUS}\\.$`),
  new RegExp(`^Priority ${PRIORITY} → ${PRIORITY}\\.$`),
  /^Start time cleared\.$/,
  /^Start time set to \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/,
  new RegExp(
    `^Taken back from (?:${MACHINE_NAME_PATTERN}|its worker): no sign of life for ${TAKE_BACK_MINUTES} minutes\\.$`,
  ),
];

/** Whether a plain note body is one of the texts the server writes. Anything else in plain text is not the board's. */
export function isServerEventText(text: string): boolean {
  return SERVER_EVENT_PATTERNS.some((pattern) => pattern.test(text));
}
