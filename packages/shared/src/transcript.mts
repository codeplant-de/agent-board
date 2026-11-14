// A run's transcript: Claude Code's `--output-format stream-json` events, condensed to what a person reads when
// they want to know why the agent did something. The worker sends them to the board in batches while the run goes on.
import { isRecord } from './guards.mts';

interface EventBase {
  // Order within the run, from 0.
  seq: number;
  at: string;
  // The Agent call a subagent's event belongs to; null for the main agent.
  parent: string | null;
}

export type TranscriptEvent = EventBase &
  (
    | { kind: 'text'; text: string }
    // Claude Code passes thinking on without its text; what is left is that it happened and roughly how long it was.
    | { kind: 'thinking'; text: string; tokens: number | null }
    | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
    | { kind: 'tool_result'; toolUseId: string; isError: boolean; output: string }
    | {
        kind: 'result';
        text: string;
        isError: boolean;
        turns: number | null;
        durationMs: number | null;
        costUsd: number | null;
        denials: string[];
      }
    | { kind: 'note'; text: string }
  );

// An event without its position: one member of the union per kind.
export type TranscriptEventBody = TranscriptEvent extends infer E
  ? E extends TranscriptEvent
    ? Omit<E, keyof EventBase>
    : never
  : never;

// An event as the board lists it: a tool result without its output, with the output's length instead.
export type TranscriptEventView = TranscriptEvent extends infer E
  ? E extends TranscriptEvent
    ? Omit<E, 'output'> & { outputSize: number | null }
    : never
  : never;

export interface TranscriptBatch {
  // One per worker run; a resume or a re-run is a new run.
  runId: string;
  startedAt: string;
  sessionId: string | null;
  resumed: boolean;
  events: TranscriptEvent[];
}

// A tool result past this is cut, with a note; the full one stays in the session file on the machine.
export const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;

export class TranscriptError extends Error {}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… cut at ${max} of ${text.length} characters`;
}

function capInput(input: unknown): unknown {
  const json = JSON.stringify(input ?? null);
  return json.length <= MAX_INPUT_CHARS ? input : { truncated: cap(json, MAX_INPUT_CHARS) };
}

// A tool result's content is a string or a list of blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  return content
    .map((block) =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
        ? block['text']
        : isRecord(block) && block['type'] === 'image'
          ? '[image]'
          : JSON.stringify(block),
    )
    .join('\n');
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Turns stream-json lines into transcript events. Keeps the little state the stream needs across lines: the event
 * counter and the last thinking-token estimate, which arrives before the (empty) thinking block it belongs to.
 */
export class StreamCondenser {
  private seq = 0;
  private thinkingTokens: number | null = null;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  line(raw: string): TranscriptEvent[] {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return raw.trim() === '' ? [] : [this.make(null, { kind: 'note', text: raw.trim() })];
    }
    if (!isRecord(event)) return [];
    const parent = typeof event['parent_tool_use_id'] === 'string' ? event['parent_tool_use_id'] : null;
    const type = event['type'];
    const message = isRecord(event['message']) ? event['message'] : undefined;
    const content = Array.isArray(message?.['content']) ? message['content'] : [];

    if (type === 'system') return this.system(event, parent);
    if (type === 'assistant') {
      return content.flatMap((block: unknown): TranscriptEvent[] => {
        if (!isRecord(block)) return [];
        if (block['type'] === 'text' && str(block['text']).trim() !== '')
          return [this.make(parent, { kind: 'text', text: str(block['text']) })];
        if (block['type'] === 'thinking') {
          const tokens = this.thinkingTokens;
          this.thinkingTokens = null;
          return [this.make(parent, { kind: 'thinking', text: str(block['thinking']), tokens })];
        }
        if (block['type'] === 'tool_use')
          return [
            this.make(parent, {
              kind: 'tool_use',
              toolUseId: str(block['id']),
              name: str(block['name']),
              input: capInput(block['input']),
            }),
          ];
        return [];
      });
    }
    if (type === 'user') {
      return content.flatMap((block: unknown): TranscriptEvent[] => {
        if (!isRecord(block) || block['type'] !== 'tool_result') return [];
        return [
          this.make(parent, {
            kind: 'tool_result',
            toolUseId: str(block['tool_use_id']),
            isError: block['is_error'] === true,
            output: cap(resultText(block['content']), MAX_OUTPUT_CHARS),
          }),
        ];
      });
    }
    if (type === 'result') {
      const denials = Array.isArray(event['permission_denials'])
        ? event['permission_denials'].map((denial: unknown) =>
            isRecord(denial)
              ? `${str(denial['tool_name'])} ${JSON.stringify(denial['tool_input'] ?? {})}`.trim()
              : String(denial),
          )
        : [];
      return [
        this.make(parent, {
          kind: 'result',
          text: str(event['result']),
          isError: event['is_error'] === true,
          turns: num(event['num_turns']),
          durationMs: num(event['duration_ms']),
          costUsd: num(event['total_cost_usd']),
          denials,
        }),
      ];
    }
    return [];
  }

  private system(event: Record<string, unknown>, parent: string | null): TranscriptEvent[] {
    const subtype = event['subtype'];
    if (subtype === 'thinking_tokens') {
      this.thinkingTokens = num(event['estimated_tokens']);
      return [];
    }
    if (subtype === 'init' && this.seq === 0) {
      return [
        this.make(parent, {
          kind: 'note',
          text: `Claude Code ${str(event['claude_code_version'])}, ${str(event['model'])}, in ${str(event['cwd'])}`.replace(
            / ,/g,
            ',',
          ),
        }),
      ];
    }
    if (subtype === 'task_notification' && str(event['summary']) !== '') {
      return [
        this.make(str(event['tool_use_id']) || parent, {
          kind: 'note',
          text: `Subagent ${str(event['status']) || 'finished'}: ${str(event['summary'])}`,
        }),
      ];
    }
    return [];
  }

  private make(parent: string | null, body: TranscriptEventBody): TranscriptEvent {
    return { seq: this.seq++, at: this.now().toISOString(), parent, ...body } as TranscriptEvent;
  }
}

// One line for a tool call: what it did, in the terms a person would look for.
export function toolSummary(name: string, input: unknown): string {
  const field = (key: string): string => (isRecord(input) && typeof input[key] === 'string' ? input[key] : '');
  const first = (text: string): string => text.split('\n')[0]?.slice(0, 160) ?? '';
  switch (name) {
    case 'Bash':
      return first(field('command'));
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return field('file_path') || field('notebook_path');
    case 'Grep':
    case 'Glob':
      return `${field('pattern')}${field('path') ? ` in ${field('path')}` : ''}`;
    case 'Agent':
    case 'Task':
      return field('description') || first(field('prompt'));
    case 'Skill':
      return `${field('skill')}${field('args') ? ` ${first(field('args'))}` : ''}`;
    case 'WebFetch':
      return field('url');
    case 'WebSearch':
      return field('query');
    default:
      return first(JSON.stringify(input ?? {})).slice(0, 120);
  }
}

// The line the worker writes to the local log for an event; undefined for events the log does not need.
export function logLine(event: TranscriptEvent): string | undefined {
  const indent = event.parent ? '    ' : '';
  switch (event.kind) {
    case 'text':
      return `${indent}${event.text}`;
    case 'tool_use':
      return `${indent}→ ${event.name}: ${toolSummary(event.name, event.input)}`;
    case 'tool_result':
      return event.isError ? `${indent}✗ ${event.output.split('\n').slice(0, 3).join(' | ').slice(0, 300)}` : undefined;
    case 'result':
      return (
        [event.denials.length > 0 ? `denied: ${event.denials.join('; ')}` : '', event.text]
          .filter(Boolean)
          .join('\n') || undefined
      );
    case 'note':
      return `${indent}· ${event.text}`;
    case 'thinking':
      return undefined;
  }
}

// The board takes at most this many events in one `transcript` call.
export const MAX_BATCH_EVENTS = 5000;

// The board lists a run's events in pages of this size; a shorter page is the last.
export const TRANSCRIPT_PAGE_SIZE = 2000;

const KINDS = ['text', 'thinking', 'tool_use', 'tool_result', 'result', 'note'];

// Stdin of `transcript`: checked for shape, not content; the worker made it.
export function parseTranscriptBatch(value: unknown): TranscriptBatch {
  if (!isRecord(value)) throw new TranscriptError('transcript batch must be an object');
  const runId = value['runId'];
  if (typeof runId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(runId))
    throw new TranscriptError('transcript runId must be an id');
  const startedAt = value['startedAt'];
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt)))
    throw new TranscriptError('transcript startedAt must be a date');
  const sessionId = value['sessionId'] ?? null;
  if (sessionId !== null && typeof sessionId !== 'string')
    throw new TranscriptError('transcript sessionId must be a string or null');
  const events = value['events'];
  if (!Array.isArray(events) || events.length > MAX_BATCH_EVENTS)
    throw new TranscriptError(`transcript events must be a list of at most ${MAX_BATCH_EVENTS}`);
  for (const event of events) {
    if (!isRecord(event) || !KINDS.includes(String(event['kind'])))
      throw new TranscriptError('transcript event needs a known kind');
    const { seq, at } = event;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)
      throw new TranscriptError('transcript event seq must be an integer from 0');
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)))
      throw new TranscriptError('transcript event at must be a date');
  }
  return { runId, startedAt, sessionId, resumed: value['resumed'] === true, events: events as TranscriptEvent[] };
}
