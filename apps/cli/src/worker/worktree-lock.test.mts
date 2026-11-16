import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createWorktreeLocks, lockReason } from './worktree-lock.mts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'ab-locks-')));
after(() => rmSync(base, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A repository with one commit and a linked worktree at <repo>/.claude/worktrees/<name>.
function repoWithWorktree(name: string): { repo: string; worktree: string } {
  const repo = join(base, name);
  execFileSync('git', ['init', '-q', repo]);
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = join(repo, '.claude', 'worktrees', name);
  git(repo, 'worktree', 'add', '-q', '-b', name, worktree);
  return { repo, worktree };
}

const removes = (repo: string, worktree: string): boolean =>
  spawnSync('git', ['-C', repo, 'worktree', 'remove', worktree], { stdio: 'ignore' }).status === 0;

test("a task's lock makes git worktree remove refuse until the task lets go of it", () => {
  const { repo, worktree } = repoWithWorktree('feat-a');
  const locks = createWorktreeLocks(join(base, 'state-a'));
  mkdirSync(join(worktree, 'src'));
  assert.equal(locks.hold('t1', join(worktree, 'src')), `locked the worktree ${worktree} for this task`);
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), new RegExp(`locked ${lockReason('t1')}`));
  assert.equal(locks.hold('t1', worktree), undefined, 'held already');
  assert.deepEqual(locks.tasks(), ['t1']);
  assert.equal(removes(repo, worktree), false);

  assert.deepEqual(locks.release('t1', worktree), [], 'the kept worktree stays locked');
  assert.deepEqual(locks.release('t1'), [`unlocked the worktree ${worktree}`]);
  assert.deepEqual(locks.tasks(), []);
  assert.equal(removes(repo, worktree), true);
});

test('a main checkout, a directory outside git and a missing one are not locked', () => {
  const { repo } = repoWithWorktree('feat-b');
  const locks = createWorktreeLocks(join(base, 'state-b'));
  assert.equal(locks.hold('t1', repo), undefined);
  assert.equal(locks.hold('t1', base), undefined);
  assert.equal(locks.hold('t1', join(base, 'missing')), undefined);
  assert.deepEqual(locks.tasks(), []);
});

test("a worktree someone else locked is left alone, and another task's lock is not undone", () => {
  const { repo, worktree } = repoWithWorktree('feat-c');
  git(repo, 'worktree', 'lock', '--reason', 'on a usb stick', worktree);
  const locks = createWorktreeLocks(join(base, 'state-c'));
  assert.match(locks.hold('t1', worktree) ?? '', /locked already \(on a usb stick\)/);
  assert.deepEqual(locks.tasks(), []);
  git(repo, 'worktree', 'unlock', worktree);

  locks.hold('t1', worktree);
  // Unlocked and locked again for another task by hand: t1 no longer holds it.
  git(repo, 'worktree', 'unlock', worktree);
  git(repo, 'worktree', 'lock', '--reason', lockReason('t2'), worktree);
  assert.deepEqual(locks.release('t1'), []);
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), new RegExp(`locked ${lockReason('t2')}`));
});

test('a worktree that was deleted anyway is dropped from the record', () => {
  const { repo, worktree } = repoWithWorktree('feat-d');
  const locks = createWorktreeLocks(join(base, 'state-d'));
  locks.hold('t1', worktree);
  git(repo, 'worktree', 'remove', '-f', '-f', worktree);
  assert.deepEqual(locks.release('t1'), []);
  assert.deepEqual(locks.tasks(), []);
});
