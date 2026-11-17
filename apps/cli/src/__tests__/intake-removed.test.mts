import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBoard } from '../commands/program.mts';
import { REMOVED_INTAKE } from '../config/config.mts';

test('board internal intake, run by a timer that setup has not deleted yet, says so and succeeds', async () => {
  const lines: string[] = [];
  await runBoard(['internal', 'intake'], { env: {}, platform: 'linux', writeOut: (text) => lines.push(text) });
  assert.equal(lines.join('').trim(), `${REMOVED_INTAKE}; run "board setup" to delete this timer`);
});
