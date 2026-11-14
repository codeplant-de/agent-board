import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedDuringPause, askedDecision, askedQuestions, hookDecision } from '../src/hook.mts';
import { createRunFiles } from '../src/runtime.mts';

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

test('without a pause the hook says nothing', () => {
  assert.equal(hookDecision(bash('git diff'), false, 't1'), '');
});

test('during a pause every call is refused but the status note', () => {
  const denied = JSON.parse(hookDecision({ tool_name: 'Read', tool_input: { file_path: '/x' } }, true, 't1'));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /board comment t1/);
  assert.equal(hookDecision(bash('board comment t1 "Paused after the resolver review"'), true, 't1'), '');
  assert.equal(
    allowedDuringPause(bash('board comment t1 "paused after step 3 of 8; steps 1-3 done"')),
    true,
    'a status may contain a semicolon',
  );
  assert.equal(allowedDuringPause(bash('board move t1 done')), false);
  assert.equal(allowedDuringPause({ tool_name: 'Agent', tool_input: { prompt: 'board comment' } }), false);
});

test('run files: lane record, heartbeat, pause request, clear', () => {
  const files = createRunFiles(join(mkdtempSync(join(tmpdir(), 'agent-board-run-')), 'agent-board'));
  const at = new Date('2026-11-13T10:00:00Z');
  files.writeRun('t1', { lane: 'reviews', borrowed: true, startedAt: at });
  assert.deepEqual(files.readRun('t1'), { lane: 'reviews', borrowed: true, startedAt: at });
  assert.equal(files.lastActive('t1'), undefined);
  files.touchAlive('t1', at);
  assert.equal(files.lastActive('t1')?.getTime(), at.getTime());
  files.requestPause('t1');
  assert.ok(files.pauseRequestedAt('t1'));
  assert.equal((statSync(files.dir).mode & 0o777).toString(8), '700');
  files.clear('t1');
  assert.deepEqual(
    [files.readRun('t1'), files.lastActive('t1'), files.pauseRequestedAt('t1')],
    [undefined, undefined, undefined],
  );
});

test("run files keep the agent's last working directory", () => {
  const files = createRunFiles(join(mkdtempSync(join(tmpdir(), 'agent-board-run-')), 'agent-board'));
  assert.equal(files.lastCwd('t1'), undefined);
  files.writeCwd('t1', '/repo/.claude/worktrees/feat-x');
  assert.equal(files.lastCwd('t1'), '/repo/.claude/worktrees/feat-x');
  files.clear('t1');
  assert.equal(files.lastCwd('t1'), undefined);
});

test('AskUserQuestion becomes a board question, with the recommended option flagged', () => {
  const input = {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          header: 'Draft',
          question: 'Append or replace?',
          multiSelect: false,
          options: [
            { label: 'Append (Recommended)', description: 'Keep what is there' },
            { label: 'Replace', description: 'Start over' },
          ],
        },
      ],
    },
  };
  assert.deepEqual(askedQuestions(input), [
    {
      header: 'Draft',
      question: 'Append or replace?',
      multiSelect: false,
      options: [
        { label: 'Append', description: 'Keep what is there', recommended: true },
        { label: 'Replace', description: 'Start over' },
      ],
    },
  ]);
  assert.equal(askedQuestions(bash('ls')), undefined);
  assert.throws(() => askedQuestions({ tool_name: 'AskUserQuestion', tool_input: {} }), /without questions/);
  const posted = JSON.parse(askedDecision('t1', undefined));
  assert.equal(posted.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(posted.hookSpecificOutput.permissionDecisionReason, /on the board now/);
  assert.match(
    JSON.parse(askedDecision('t1', 'board down')).hookSpecificOutput.permissionDecisionReason,
    /board down.*board comment t1/,
  );
  // An error text from the server stays one bounded line.
  const reason = JSON.parse(askedDecision('t1', `ask: error\n${'x'.repeat(2000)}`)).hookSpecificOutput
    .permissionDecisionReason as string;
  assert.ok(reason.length < 800 && !reason.includes('\n'));
});
