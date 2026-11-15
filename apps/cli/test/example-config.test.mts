import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isRecord } from '@agent-board/shared';
import { buildInvocation, expandRule } from '../src/decide.mts';
import { parseConfig } from '../src/config.mts';
import { task } from './helpers.mts';

const FRESH = { kind: 'fresh', sessionId: '11111111-1111-4111-8111-111111111111' } as const;

const raw: unknown = JSON.parse(readFileSync(new URL('../examples/config.reviews.json', import.meta.url), 'utf8'));
const config = parseConfig(raw);
// Restricted review runs are unattended on PR text: these are the only rules with a job to do.
const entry = config.skills['review-pr']!;

const neutral = parseConfig(
  JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')) as unknown,
);

test('the config board init copies is neutral: one general lane, no repos, no intake', () => {
  assert.deepEqual(
    neutral.lanes.map((lane) => [lane.name, lane.skills, lane.slots]),
    [['general', ['*'], 3]],
  );
  assert.deepEqual(neutral.repos, {});
  assert.equal(neutral.intakeEnabled, false);
  assert.ok(!readFileSync(new URL('../config.example.json', import.meta.url), 'utf8').includes('cosuno'));
});

test('the reviews example has an intake block, and the review rules are the profile of review-pr', () => {
  assert.equal(config.intakeEnabled, true);
  assert.deepEqual(Object.keys(config.skills), ['review-pr']);
  assert.ok(!(isRecord(raw) && isRecord(raw['intake']) && 'allowedTools' in raw['intake']));
});

test('the example has no backend entry: the CLI talks to the board directly', () => {
  assert.ok(!(isRecord(raw) && 'backend' in raw));
});

test('no shipped rule starts with a wildcard before a path', () => {
  for (const rule of [...entry.allowedTools, ...entry.disallowedTools]) assert.doesNotMatch(rule, /^Bash\(\*/);
});

test('git cannot be made to write files, and secrets are denied', () => {
  const secrets = [
    '~/.config/**',
    '~/.ssh/**',
    '~/.aws/**',
    '~/.gnupg/**',
    '~/.kube/**',
    '~/.docker/**',
    '~/.netrc',
    '~/.claude/.credentials.json',
    '**/.env*',
  ].map((path) => `Read(${path})`);
  for (const rule of [
    'Bash(git log *--output*)',
    'Bash(git show *--output*)',
    'Bash(git diff *--output*)',
    'Bash(git diff *--no-index*)',
    'Bash(git fetch *:**)',
    'Bash(git fetch *--up*)',
    ...secrets,
  ]) {
    assert.ok(entry.disallowedTools.includes(rule), rule);
  }
  for (const rule of ['Bash(jq *)', 'Bash(brain notes append *)']) assert.ok(!entry.allowedTools.includes(rule), rule);
});

test('the plugin placeholder resolves in every shipped script rule', () => {
  const plan = buildInvocation({
    run: FRESH,
    task: task({ id: 'a', input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto', createdBy: 'intake' }),
    repos: config.repos,
    defaultCwd: '/',
    skills: config.skills,
    home: '/h',
    pluginRoots: { 'pr-review': '/p', engineering: '/e' },
  });
  assert.ok(plan.ok);
  assert.ok(plan.invocation.args.every((arg) => !/\{[a-z-]+\}/.test(arg)));
  assert.equal(expandRule('Bash({pr-review}/skills/a.sh *)', '/h', { 'pr-review': '/p' }), 'Bash(/p/skills/a.sh *)');
});

test('the reviewer may write its findings file in /tmp, with the rule form Claude Code 2.1.322 honours for the Write tool', () => {
  assert.ok(entry.allowedTools.includes('Edit(//tmp/pr-*)'));
  assert.ok(
    !entry.allowedTools.some((rule) => rule.startsWith('Write(')),
    'Write(...) rules are not honoured; Edit(...) rules cover the Write tool',
  );
});

test('no rule ends in the legacy `:*` prefix syntax after a wildcard, which Claude Code would match as a literal', () => {
  const rules = [...entry.allowedTools, ...entry.disallowedTools];
  for (const rule of rules) assert.ok(!/\*.*:\*\)?$/.test(rule), rule);
});

test('the shipped lanes give reviews their own slots and everything else three', () => {
  assert.deepEqual(
    config.lanes.map((lane) => [lane.name, lane.skills, lane.slots]),
    [
      ['reviews', ['review-pr'], 2],
      ['general', ['*'], 3],
    ],
  );
  assert.equal(config.intake.prompt, '/review-pr {url} --auto');
});

// Claude Code's Bash rule matching as far as the shipped rules need it: `*` is any run of characters.
const allows = (command: string): boolean =>
  entry.allowedTools.some((rule) => {
    const pattern = /^Bash\((.*)\)$/.exec(rule)?.[1];
    return (
      pattern !== undefined &&
      new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ).test(command)
    );
  });

test('an intake run may report and propose through board, but never schedule or start work', () => {
  for (const command of [
    'board schedule /review-pr 1 --auto',
    'board schedule',
    'board schedules rm abc',
    'board schedules pause abc',
    'board internal worker abc',
    'board internal hook /run abc',
    'board',
    'board move abc todo',
    'board move abc running',
    'board move abc done',
    'board polish abc --title t --file /tmp/pr-x.md',
    'board tasks',
  ]) {
    assert.ok(!allows(command), command);
  }
  for (const command of [
    'board comment abc --file /tmp/pr-abc.md',
    'board ask abc --file /tmp/pr-abc-questions.json',
    'board add --title t --file /tmp/pr-x.md --parent abc',
    'board show abc',
    'board move abc needs-me',
  ]) {
    assert.ok(allows(command), command);
  }
  assert.ok(!entry.allowedTools.includes('Bash(board *)'));
  assert.ok(entry.disallowedTools.includes('Bash(board schedule *)'));
  assert.ok(entry.disallowedTools.includes('Bash(board schedules *)'));
  assert.ok(entry.disallowedTools.includes('Bash(board internal *)'));
});

test('a review run may not call the commands that create tasks for scripts', () => {
  for (const command of ['board create --skill review-pr x', 'board intake run']) assert.ok(!allows(command), command);
  assert.ok(entry.disallowedTools.includes('Bash(board create *)'));
  assert.ok(entry.disallowedTools.includes('Bash(board intake *)'));
});
