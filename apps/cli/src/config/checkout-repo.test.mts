import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkoutRepo, parseGitHubRepo } from './checkout-repo.mts';
import type { GitRunner } from './checkout-repo.mts';

test('parseGitHubRepo reads the GitHub URL forms and nothing else', () => {
  for (const url of [
    'git@github.com:acme/app.git',
    'git@github.com:acme/app',
    'https://github.com/acme/app.git',
    'https://github.com/acme/app',
    'https://github.com/acme/app/',
    'ssh://git@github.com/acme/app.git',
    'ssh://git@github.com/acme/app',
    '  https://github.com/acme/app.git\n',
  ])
    assert.equal(parseGitHubRepo(url), 'acme/app', url);
  assert.equal(parseGitHubRepo('https://github.com/acme/app.js.git'), 'acme/app.js');
  for (const url of [
    '',
    'git@gitlab.com:acme/app.git',
    'https://gitlab.com/acme/app',
    'https://github.com.evil.example/acme/app',
    'https://github.com/acme',
    'https://github.com/acme/app/extra',
    'git@github.com:acme',
    'git@github.com:/app',
    'http://github.com/acme/app',
    '/srv/git/app.git',
    'github.com/acme/app',
  ])
    assert.equal(parseGitHubRepo(url), undefined, url);
});

// A fake git for a checkout at /w: `answers` by joined args, anything else fails.
const fakeGit =
  (answers: Record<string, string>): GitRunner =>
  (_cwd, args) =>
    answers[args.join(' ')];

const topLevel = { 'rev-parse --show-toplevel': '/', 'rev-parse --git-dir --git-common-dir': '.git\n.git' };

test('checkoutRepo prefers the upstream remote, falls back to origin, and gives up without a GitHub one', () => {
  const root = realpathSync(tmpdir());
  const base = { 'rev-parse --show-toplevel': root, 'rev-parse --git-dir --git-common-dir': '.git\n.git' };
  const origin = { ...base, 'remote get-url origin': 'git@github.com:acme/app.git' };
  assert.equal(checkoutRepo(root, fakeGit(origin)), 'acme/app');
  const fork = {
    ...origin,
    'symbolic-ref -q HEAD': 'refs/heads/main',
    'for-each-ref --format=%(upstream:remotename) refs/heads/main': 'upstream',
    'remote get-url upstream': 'https://github.com/other/app',
  };
  assert.equal(checkoutRepo(root, fakeGit(fork)), 'other/app', 'the upstream wins over origin');
  const noUpstream = { ...fork, 'for-each-ref --format=%(upstream:remotename) refs/heads/main': '' };
  assert.equal(checkoutRepo(root, fakeGit(noUpstream)), 'acme/app');
  const local = { ...fork, 'for-each-ref --format=%(upstream:remotename) refs/heads/main': '.' };
  assert.equal(checkoutRepo(root, fakeGit(local)), 'acme/app', 'a local upstream is no remote');
  const gitlabUpstream = { ...fork, 'remote get-url upstream': 'git@gitlab.com:o/n.git' };
  assert.equal(
    checkoutRepo(root, fakeGit(gitlabUpstream)),
    undefined,
    'the upstream remote decides, even when not GitHub',
  );
  assert.equal(checkoutRepo(root, fakeGit({ ...base, 'remote get-url origin': 'git@gitlab.com:o/n.git' })), undefined);
  assert.equal(checkoutRepo(root, fakeGit(base)), undefined, 'no remote');
  assert.equal(checkoutRepo(root, fakeGit({})), undefined, 'git missing or failing');
  assert.equal(checkoutRepo(root, fakeGit({ ...topLevel, 'remote get-url origin': 'git@github.com:a/b' })), undefined);
});

test('checkoutRepo refuses a subdirectory and a linked worktree', () => {
  const root = realpathSync(tmpdir());
  const answers = {
    'rev-parse --git-dir --git-common-dir': '.git\n.git',
    'remote get-url origin': 'git@github.com:acme/app.git',
  };
  assert.equal(
    checkoutRepo(join(root, 'sub'), fakeGit({ ...answers, 'rev-parse --show-toplevel': root })),
    undefined,
    'the top level is a parent',
  );
  const linked = {
    ...answers,
    'rev-parse --show-toplevel': root,
    'rev-parse --git-dir --git-common-dir': '/x/.git/worktrees/w\n/x/.git',
  };
  assert.equal(checkoutRepo(root, fakeGit(linked)), undefined);
});

function realRepo(context: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-checkout-repo-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'ignore',
  });
};

test('checkoutRepo with real git: a checkout, its subdirectory, a linked worktree and a plain directory', (context) => {
  const root = realRepo(context);
  const main = join(root, 'main');
  mkdirSync(join(main, 'sub'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
  assert.equal(checkoutRepo(main), 'acme/app');
  assert.equal(checkoutRepo(join(main, 'sub')), undefined);
  const worktree = join(root, 'wt');
  git(main, 'worktree', 'add', '-q', worktree);
  assert.equal(checkoutRepo(worktree), undefined);
  const plain = join(root, 'plain');
  mkdirSync(plain);
  assert.equal(checkoutRepo(plain), undefined);
});
