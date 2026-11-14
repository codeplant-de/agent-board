import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXEC_PATH, isCompiledBinary, selfCommand } from '../src/self.mts';
import { createSystem } from '../src/system.mts';
import { hookCommand } from '../src/worker.mts';

test('the command that starts a worker ends in main.mts internal worker <id>', async () => {
  const printed: string[] = [];
  await createSystem({ dryRun: true, print: (line) => printed.push(line) }).startWorker('Ab3dEf9x');
  assert.match(printed[0] ?? '', /-- \S+ \S+\/src\/main\.mts internal worker Ab3dEf9x$/);
});

test('the hook command of a run ends in main.mts internal hook <dir> <id>', () => {
  assert.match(hookCommand('/run/x', 'Ab3dEf9x'), /\/src\/main\.mts' 'internal' 'hook' '\/run\/x' Ab3dEf9x$/);
});

test('a checkout is not a compiled binary, and the running program is read once at load', () => {
  assert.equal(isCompiledBinary(), false);
  assert.equal(EXEC_PATH, process.execPath);
});

test('the entry does not depend on how the process was started', () => {
  const [exec, main, ...rest] = selfCommand('internal', 'hook');
  assert.equal(exec, EXEC_PATH);
  assert.ok(main?.endsWith('/src/main.mts'));
  assert.deepEqual(rest, ['internal', 'hook']);
});
