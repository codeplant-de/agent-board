/**
 * What a sealed column holds: an `abe1.` envelope, or for a blind index an `abh1.` value, of the shape the encryption module
 * makes. The re-encryption script counts the values that are not, and a later release's migration makes the database refuse
 * them. `[.]` rather than an escaped dot keeps the SQL free of backslashes. Only the clients can tell whether a value opens,
 * but plain text cannot get in.
 */
export const ENVELOPE_PATTERN = '^abe1[.][A-Za-z0-9_-]{38,}$';
export const BLIND_INDEX_PATTERN = '^abh1[.][A-Za-z0-9_-]{43}$';

export interface SealedColumn {
  table: string;
  column: string;
  kind: 'envelope' | 'blind-index';
}

const envelope = (table: string, column: string): SealedColumn => ({ table, column, kind: 'envelope' });
const blindIndex = (table: string, column: string): SealedColumn => ({ table, column, kind: 'blind-index' });

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  envelope('task', 'title'),
  envelope('task', 'input'),
  envelope('task', 'workdir'),
  blindIndex('task', 'dedupe_key'),
  blindIndex('task', 'head'),
  envelope('schedule', 'title'),
  envelope('schedule', 'input'),
  envelope('schedule', 'workdir'),
  envelope('note', 'body'),
  envelope('note', 'preview'),
  envelope('note', 'questions'),
  envelope('note', 'answers'),
  envelope('transcript_event', 'data'),
  envelope('transcript_event', 'output'),
];

/** A note body is the only column that may hold plain text, and only on the events the server writes itself. */
export const PLAIN_NOTE_BODY = `(author::text = 'server' and kind = 'event')`;

/** The pattern a column must match. */
export const patternOf = ({ kind }: SealedColumn): string =>
  kind === 'envelope' ? ENVELOPE_PATTERN : BLIND_INDEX_PATTERN;
