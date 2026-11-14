import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  logLine,
  MAX_BATCH_EVENTS,
  MAX_OUTPUT_CHARS,
  parseWireTranscriptBatch,
  StreamCondenser,
  toolSummary,
  TranscriptError,
} from '../src/transcript.mts';
import { deriveKeys, generateDataKey, seal } from '../src/crypto.mts';

// A real `claude -p --output-format stream-json --verbose` run (Claude Code 2.1.325): thinking, two Bash calls (one
// failing), a subagent with its own Bash call, and the final result.
const lines = readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8').split('\n');
const at = new Date('2026-11-13T12:00:00Z');

test('a real stream condenses to notes, thinking, tool calls with results, text and the result', () => {
  const condenser = new StreamCondenser(() => at);
  const events = lines.flatMap((line) => condenser.line(line));
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i),
    'numbered in order',
  );
  assert.match(events[0]?.kind === 'note' ? events[0].text : '', /^Claude Code 2\.1\.325, claude-haiku-5-5, in \/tmp$/);
  const thinking = events.find((e) => e.kind === 'thinking');
  assert.ok(thinking?.kind === 'thinking' && thinking.tokens === 252, 'thinking keeps the token estimate');
  const failed = events.find((e) => e.kind === 'tool_result' && e.isError);
  assert.ok(failed?.kind === 'tool_result' && /nonexistent-file-xyz/.test(failed.output));
  const sub = events.filter((e) => e.parent !== null);
  assert.ok(
    sub.some((e) => e.kind === 'tool_use' && e.name === 'Bash' && toolSummary(e.name, e.input) === 'echo from-sub'),
    'subagent calls carry their parent',
  );
  assert.ok(events.some((e) => e.kind === 'result' && /done/.test(e.text)));
  assert.equal(events.find((e) => e.kind === 'tool_use')?.at, at.toISOString());
});

test('log lines show calls, failures and text, and skip the rest', () => {
  const condenser = new StreamCondenser(() => at);
  const log = lines
    .flatMap((line) => condenser.line(line))
    .map(logLine)
    .filter((line) => line !== undefined);
  assert.ok(log.includes('→ Bash: echo hello'));
  assert.ok(log.some((line) => line.startsWith('✗ Exit code 1')));
  assert.ok(log.includes('    → Bash: echo from-sub'), 'subagent lines are indented');
});

test('a huge tool result is cut with a note; a non-JSON line becomes a note', () => {
  const condenser = new StreamCondenser(() => at);
  const big = 'x'.repeat(MAX_OUTPUT_CHARS + 10);
  const [result] = condenser.line(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } }),
  );
  assert.ok(
    result?.kind === 'tool_result' &&
      result.output.endsWith(`cut at ${MAX_OUTPUT_CHARS} of ${MAX_OUTPUT_CHARS + 10} characters`),
  );
  assert.deepEqual(
    condenser.line('Error: not json').map((e) => e.kind),
    ['note'],
  );
  assert.deepEqual(condenser.line('   '), []);
});

test('permission denials end up in the result', () => {
  const [result] = new StreamCondenser(() => at).line(
    JSON.stringify({
      type: 'result',
      result: 'x',
      is_error: false,
      num_turns: 3,
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }],
    }),
  );
  assert.ok(result?.kind === 'result' && result.denials[0] === 'Bash {"command":"git push"}' && result.turns === 3);
});

test('tool summaries name what a person looks for', () => {
  assert.equal(toolSummary('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(toolSummary('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
  assert.equal(toolSummary('Skill', { skill: 'review-pr', args: '17741 --auto' }), 'review-pr 17741 --auto');
});

const keys = await deriveKeys(generateDataKey(), 'alice');
const DATA = await seal(keys, 'tr.data', 'run:0', '{"kind":"note","text":"x"}');
const OUTPUT = await seal(keys, 'tr.output', 'run:1', 'out');

const note = { seq: 0, at: at.toISOString(), parent: null, kind: 'note', data: DATA };
const result = {
  seq: 1,
  at: at.toISOString(),
  parent: null,
  kind: 'tool_result',
  data: DATA,
  output: OUTPUT,
  outputSize: 3,
};
const batch = {
  runId: '1b9a7c6e-aaaa',
  startedAt: at.toISOString(),
  sessionId: 's',
  resumed: true,
  events: [note, result],
};

test('a batch is checked for shape', () => {
  const parsed = parseWireTranscriptBatch(batch);
  assert.deepEqual(parsed.events, [note, result]);
  assert.throws(() => parseWireTranscriptBatch({ ...batch, runId: '../x' }), TranscriptError);
  assert.throws(
    () => parseWireTranscriptBatch({ ...batch, events: [{ seq: 0, at: 'x', kind: 'weird' }] }),
    /known kind/,
  );
});

test('a batch needs an integer seq from 0, a date and at most the batch limit', () => {
  for (const bad of [{ seq: -1 }, { seq: 1.5 }, { seq: '1' }, { at: 'soon' }, { at: 5 }]) {
    assert.throws(() => parseWireTranscriptBatch({ ...batch, events: [{ ...note, ...bad }] }), TranscriptError);
  }
  assert.equal(
    parseWireTranscriptBatch({
      ...batch,
      events: Array.from({ length: MAX_BATCH_EVENTS }, (_, seq) => ({ ...note, seq })),
    }).events.length,
    MAX_BATCH_EVENTS,
  );
  assert.throws(
    () =>
      parseWireTranscriptBatch({
        ...batch,
        events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, seq) => ({ ...note, seq })),
      }),
    /at most 5000/,
  );
});

test('the server refuses plaintext data and plaintext output, and checks the output size it cannot measure', () => {
  const withEvents = (...events: unknown[]) => ({ ...batch, events });
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, data: '{"kind":"note"}' })), /must be encrypted/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...result, output: 'plain output' })), /must be encrypted/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...result, output: undefined })), /output/);
  for (const outputSize of [-1, 1.5, '3', null, MAX_OUTPUT_CHARS + 2048])
    assert.throws(() => parseWireTranscriptBatch(withEvents({ ...result, outputSize })), /outputSize/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, output: OUTPUT })), /only a tool result/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, outputSize: 3 })), /only a tool result/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, parent: 5 })), /parent/);
});
