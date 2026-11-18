import assert from 'node:assert/strict';
import { test } from 'node:test';
import { broadRule, deadAllowTools, grantFlags, looksSecret } from './agentGrants.mts';

test('broadRule and looksSecret', () => {
  for (const rule of [
    'Bash',
    'Bash(*)',
    'Bash(**)',
    'Bash(bash -c *)',
    'Bash(python3 *)',
    'Bash(* foo)',
    'Read',
    'WebFetch',
    'Read(//**)',
    'Edit(~/**)',
    'mcp__shortcut',
  ])
    assert.ok(broadRule(rule) !== undefined, rule);
  for (const rule of [
    'Grep',
    'Bash(git status)',
    'Bash(gh pr view *)',
    'Bash(board comment *)',
    'Edit(//tmp/pr-*)',
    'Read(~/.ssh/**)',
    'mcp__shortcut__get_story',
  ])
    assert.equal(broadRule(rule), undefined, rule);
  for (const name of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'API_KEY', 'DB_PASSWORD', 'SESSION_COOKIE'])
    assert.ok(looksSecret(name), name);
  for (const name of ['REGION', 'APP_REPLICA_ENDPOINT', 'KEYBOARD_LAYOUT']) assert.ok(!looksSecret(name), name);
});

test('deadAllowTools names each tool once that tools leaves out, and never an MCP rule', () => {
  assert.deepEqual(
    deadAllowTools({
      tools: ['Read'],
      allowedTools: ['Read(~/x)', 'Bash(git status)', 'Bash(git log *)', 'WebFetch', 'mcp__shortcut__get_story'],
    }),
    ['Bash', 'WebFetch'],
  );
  assert.deepEqual(deadAllowTools({ tools: ['Read', 'Bash'], allowedTools: ['Bash(git status)'] }), []);
});

test('grantFlags collects every flag of a definition', () => {
  assert.deepEqual(
    grantFlags({
      tools: ['Read'],
      allowedTools: ['Read', 'Bash(curl *)', 'Read(docs/**)'],
      disallowedTools: [],
      env: ['GITHUB_TOKEN', 'REGION'],
    }),
    {
      broad: [
        { rule: 'Read', reason: 'reads every file the deny list does not name' },
        { rule: 'Bash(curl *)', reason: 'runs curl, which can run or reach anything' },
      ],
      secrets: ['GITHUB_TOKEN'],
      emptyDenyList: true,
      deadTools: ['Bash'],
    },
  );
  const narrow = grantFlags({ tools: ['Grep'], allowedTools: ['Grep'], disallowedTools: ['Read(~/.ssh/**)'], env: [] });
  assert.deepEqual(narrow, { broad: [], secrets: [], emptyDenyList: false, deadTools: [] });
});
