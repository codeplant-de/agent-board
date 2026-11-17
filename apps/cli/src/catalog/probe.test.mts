import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { probeClaude, readProbeAnswer } from './probe.mts';
import type { ProbeProcess, ProbeSpawn } from './probe.mts';

// A synthetic answer of `initialize`: the keys the probe reads, and some it does not.
const ANSWER = {
  commands: [
    { name: 'review-pr', description: '  Review\n a pull   request ', argumentHint: '<number>' },
    { name: 'plugin:docx', description: 'Word files', argumentHint: '' },
    { name: 'deploy', description: 'x'.repeat(300), argumentHint: 'y'.repeat(150), aliases: ['d'] },
    { name: 'compact', description: 'Compact the conversation', argumentHint: '', builtin: true },
    { name: 'claude.ai Notion:search (MCP)', description: 'an MCP prompt', argumentHint: '' },
    { name: 7 },
    'junk',
  ],
  agents: [{ name: 'a' }],
  models: [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus' },
    { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true },
    { value: 'bad value', displayName: 'Bad' },
    { value: 'haiku', displayName: '', description: '' },
  ],
  claude_code_version: '2.1.326',
  account: { email: 'someone@example.com' },
};

interface FakeProcess extends ProbeProcess {
  written: string[];
  signals: string[];
  stdinEnded: boolean;
  out: (text: string) => void;
  exit: () => void;
  fail: () => void;
}

function fakeProcess(): FakeProcess {
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const state: FakeProcess = {
    written: [],
    signals: [],
    stdinEnded: false,
    stdin: {
      write: (text) => void state.written.push(text),
      end: () => void (state.stdinEnded = true),
      on: () => undefined,
    },
    stdout: { setEncoding: () => undefined, on: (_event, listener) => void stdout.on('data', listener) },
    on: (event, listener) => void events.on(event, listener),
    kill: (signal) => void state.signals.push(signal),
    out: (text) => void stdout.emit('data', text),
    exit: () => void events.emit('close'),
    fail: () => void events.emit('error'),
  };
  return state;
}

// What `claude` answers a request: the control response with the same request id, among other lines.
const responding = (child: FakeProcess, payload: unknown = ANSWER, subtype = 'success'): ProbeSpawn => {
  return () => {
    const originalWrite = child.stdin.write;
    child.stdin.write = (text) => {
      originalWrite(text);
      const { request_id: id } = JSON.parse(text) as { request_id: string };
      child.out('{"type":"system","subtype":"hook_started"}\nnot json\n');
      child.out(
        `${JSON.stringify({ type: 'control_response', response: { subtype, request_id: 'other', response: {} } })}\n`,
      );
      child.out(
        `${JSON.stringify({ type: 'control_response', response: { subtype, request_id: id, response: payload } })}\n`,
      );
      setImmediate(() => child.exit());
    };
    return child;
  };
};

test('a probe sends one initialize request and no prompt, takes the answer with its request id, and ends the process and its group', async () => {
  const child = fakeProcess();
  let started: { command: string; args: string[]; cwd: string } | undefined;
  const spawn: ProbeSpawn = (command, args, { cwd }) => {
    started = { command, args, cwd };
    return responding(child)(command, args, { cwd, env: {} });
  };
  const result = await probeClaude('/work/app', { spawn });
  assert.deepEqual(started, {
    command: 'claude',
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'],
    cwd: '/work/app',
  });
  assert.equal(child.written.length, 1);
  const request = JSON.parse(child.written[0]!) as { type: string; request: unknown };
  assert.deepEqual([request.type, request.request], ['control_request', { subtype: 'initialize' }]);
  assert.equal(child.stdinEnded, true);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result?.claude, '2.1.326');
});

test('the answer is cleaned: safe skill names only, text on one line and cut, default model dropped, nothing else kept', () => {
  assert.deepEqual(readProbeAnswer(ANSWER), {
    claude: '2.1.326',
    models: [
      { value: 'opus', label: 'Opus 5.5', description: 'For complex work' },
      { value: 'haiku', label: 'haiku' },
    ],
    commands: [
      { name: 'review-pr', description: 'Review a pull request', argumentHint: '<number>', builtin: false },
      { name: 'plugin:docx', description: 'Word files', builtin: false },
      { name: 'deploy', description: 'x'.repeat(200), argumentHint: 'y'.repeat(100), builtin: false },
      { name: 'compact', description: 'Compact the conversation', builtin: true },
    ],
  });
});

test('an answer without a list of commands, or with models that are no list, is of an unknown shape', () => {
  for (const bad of [undefined, null, 'x', [], {}, { commands: {} }, { commands: [], models: 'opus' }])
    assert.equal(readProbeAnswer(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(readProbeAnswer({ commands: [] }), { models: [], commands: [] });
});

test('a probe that gets an error response, no response, or an answer of another shape finds nothing', async () => {
  assert.equal(await probeClaude('/w', { spawn: responding(fakeProcess(), {}, 'error') }), undefined);
  assert.equal(await probeClaude('/w', { spawn: responding(fakeProcess(), { commands: 5 }) }), undefined);
  const silent = fakeProcess();
  const closing: ProbeSpawn = () => {
    setImmediate(() => silent.exit());
    return silent;
  };
  assert.equal(await probeClaude('/w', { spawn: closing }), undefined);
});

test('a program that cannot start, or throws on spawn, finds nothing', async () => {
  const broken = fakeProcess();
  const failing: ProbeSpawn = () => {
    setImmediate(() => broken.fail());
    return broken;
  };
  assert.equal(await probeClaude('/w', { spawn: failing }), undefined);
  assert.equal(
    await probeClaude('/w', {
      spawn: () => {
        throw new Error('no claude');
      },
    }),
    undefined,
  );
});

test('a probe that is not answered in time is ended: stdin closed, SIGTERM, and SIGKILL when the process stays', async () => {
  const child = fakeProcess();
  const started = Date.now();
  const result = await probeClaude('/w', { spawn: () => child, timeoutMs: 20, exitGraceMs: 20 });
  assert.equal(result, undefined);
  assert.ok(Date.now() - started >= 20);
  assert.equal(child.stdinEnded, true);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('an answer that comes in pieces is put together', async () => {
  const child = fakeProcess();
  const spawn: ProbeSpawn = () => {
    const write = child.stdin.write;
    child.stdin.write = (text) => {
      write(text);
      const { request_id: id } = JSON.parse(text) as { request_id: string };
      const line = JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: id, response: ANSWER },
      });
      child.out(line.slice(0, 40));
      child.out(`${line.slice(40)}\n`);
      setImmediate(() => child.exit());
    };
    return child;
  };
  assert.equal((await probeClaude('/w', { spawn }))?.commands.length, 4);
});
