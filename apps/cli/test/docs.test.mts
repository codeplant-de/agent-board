import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COMMANDS_END, COMMANDS_START, renderCommandsDoc, withCommandsDoc } from '../src/docs.mts';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

test('the command reference of the README is the generated one; run `pnpm --filter @agent-board/cli docs` when this fails', () => {
  assert.equal(withCommandsDoc(readme), readme);
});

test('the generated reference covers every visible command, its flags and examples, and no hidden one', () => {
  const doc = renderCommandsDoc();
  assert.ok(doc.startsWith(COMMANDS_START) && doc.endsWith(COMMANDS_END));
  for (const name of ['tasks', 'comment', 'schedule', 'doctor', 'self-update', 'completion'])
    assert.ok(doc.includes(`#### board ${name}`), name);
  for (const text of ['--json', '--all', 'board completion bash >', 'Examples:']) assert.ok(doc.includes(text), text);
  assert.match(doc, /start of the\s+id/);
  assert.ok(!doc.includes('internal') && !doc.includes('__complete'));
});
