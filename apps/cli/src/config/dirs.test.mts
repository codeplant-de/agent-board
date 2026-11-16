import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import { CONFIG, fakeBackend } from '../__tests__/helpers/fakes.mts';
import { coveringDir, dirsToSend, isAllowedDir, isDirectory, syncDirs } from './dirs.mts';

const dir = (path: string) => ({ path });

test('coveringDir finds an equal entry, a parent, never a sibling that shares a prefix, and prefers the deepest', () => {
  const dirs = [dir('/a/b'), dir('/x'), dir('/a/b/c')];
  assert.deepEqual(coveringDir(dirs, '/a/b'), dir('/a/b'));
  assert.deepEqual(coveringDir(dirs, '/a/b/d/e'), dir('/a/b'));
  assert.equal(coveringDir(dirs, '/a/bc'), undefined);
  assert.equal(coveringDir(dirs, '/a'), undefined);
  assert.deepEqual(coveringDir(dirs, '/a/b/c/d'), dir('/a/b/c'));
  assert.deepEqual(coveringDir([dir('/')], '/anything'), dir('/'));
  assert.equal(coveringDir([], '/a'), undefined);
});

test('isAllowedDir allows everything without a list, nothing with an empty one, and decides on the real path', () => {
  const links: Record<string, string> = { '/a/link-out': '/outside', '/alias': '/a', '/gone': '' };
  const realpath = (path: string): string | undefined => (path === '/gone' ? undefined : (links[path] ?? path));
  assert.equal(isAllowedDir(undefined, '/anywhere', realpath), true);
  assert.equal(isAllowedDir([], '/a', realpath), false);
  assert.equal(isAllowedDir([dir('/a')], '/a/sub', realpath), true);
  assert.equal(isAllowedDir([dir('/a')], '/a/link-out', realpath), false, 'a link inside the list that leaves it');
  assert.equal(isAllowedDir([dir('/alias')], '/a/sub', realpath), true, 'a listed link counts through its target');
  assert.equal(isAllowedDir([dir('/a')], '/gone', realpath), false);
});

test('isDirectory is true only for a directory that is there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-isdir-'));
  try {
    writeFileSync(join(dir, 'file'), '');
    assert.equal(isDirectory(dir), true);
    assert.equal(isDirectory(join(dir, 'file')), false);
    assert.equal(isDirectory(join(dir, 'missing')), false);
    assert.equal(isDirectory(join(dir, 'file', 'below')), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('isDirectory is false for a path it may not look at', (context: TestContext) => {
  if (process.getuid?.() === 0) return context.skip('root can look at any path');
  const dir = mkdtempSync(join(tmpdir(), 'board-isdir-'));
  mkdirSync(join(dir, 'locked', 'inner'), { recursive: true });
  chmodSync(join(dir, 'locked'), 0o000);
  try {
    assert.equal(isDirectory(join(dir, 'locked', 'inner')), false);
  } finally {
    chmodSync(join(dir, 'locked'), 0o700);
    rmSync(dir, { recursive: true });
  }
});

const written = (backend: ReturnType<typeof fakeBackend>): string[] =>
  backend.writes.filter((w) => w.startsWith('dirs '));

test('syncDirs sends only what the board lacks: the listed directories that exist, as written, once', async () => {
  const backend = fakeBackend([]);
  const config = { ...CONFIG, dirs: [dir('/a'), dir('/gone'), dir('/b')] };
  const exists = (path: string): boolean => path !== '/gone';
  assert.deepEqual(await syncDirs({ backend, config }, exists), { result: 'sent', count: 2 });
  assert.deepEqual(written(backend), ['dirs here: /a,/b']);
  assert.deepEqual(await syncDirs({ backend, config }, exists), { result: 'unchanged' });
  assert.deepEqual(
    await syncDirs({ backend, config: { ...CONFIG, dirs: [dir('/a'), dir('/b'), dir('/gone')] } }, exists),
    {
      result: 'unchanged',
    },
  );
  assert.equal(written(backend).length, 1);
  assert.deepEqual(await syncDirs({ backend, config: { ...CONFIG, dirs: [dir('/a')] } }, exists), {
    result: 'sent',
    count: 1,
  });
  assert.deepEqual(written(backend), ['dirs here: /a,/b', 'dirs here: /a']);
  assert.deepEqual(await syncDirs({ backend, config: { ...CONFIG, dirs: [] } }, exists), { result: 'sent', count: 0 });
  assert.deepEqual(backend.boardDirs.held, []);
});

test('syncDirs does nothing without a dirs key, and nothing on a server that cannot hold a list', async () => {
  const backend = fakeBackend([]);
  let asked = 0;
  backend.checkDirs = async () => {
    asked += 1;
    return 'unsupported';
  };
  assert.deepEqual(await syncDirs({ backend, config: CONFIG }), { result: 'not-listed' });
  assert.equal(asked, 0, 'no key, no call');
  assert.deepEqual(await syncDirs({ backend, config: { ...CONFIG, dirs: [dir('/a')] } }, () => true), {
    result: 'unsupported',
  });
  assert.deepEqual(written(backend), []);
});

test('syncDirs lets a failure of the board through for the caller to word, and drops paths that are not safe', async () => {
  const backend = fakeBackend([]);
  backend.boardDirs.failure = new BackendError('cannot reach https://board.example.com');
  await assert.rejects(
    syncDirs({ backend, config: { ...CONFIG, dirs: [dir('/a')] } }, () => true),
    /cannot reach/,
  );
  assert.deepEqual(
    dirsToSend([dir('/a'), dir('/b\nc'), dir('/d')], () => true),
    [dir('/a'), dir('/d')],
  );
});

test('dirsToSend passes labels on and nothing else of the settings; a changed label is sent again', async () => {
  const backend = fakeBackend([]);
  const entry = { path: '/a', label: 'A', repo: 'o/n', default: true as const, lane: 'x' };
  assert.deepEqual(
    dirsToSend([entry, dir('/b')], () => true),
    [{ path: '/a', label: 'A' }, dir('/b')],
  );
  const config = { ...CONFIG, dirs: [entry, dir('/b')] };
  assert.deepEqual(await syncDirs({ backend, config }, () => true), { result: 'sent', count: 2 });
  assert.deepEqual(await syncDirs({ backend, config }, () => true), { result: 'unchanged' });
  const relabelled = { ...CONFIG, dirs: [{ ...entry, label: 'B' }, dir('/b')] };
  assert.deepEqual(await syncDirs({ backend, config: relabelled }, () => true), { result: 'sent', count: 2 });
  const same = { ...CONFIG, dirs: [{ ...entry, repo: 'p/q', lane: 'y' }, dir('/b')] };
  assert.deepEqual(
    await syncDirs({ backend, config: { ...same, dirs: [{ ...same.dirs[0]!, label: 'B' }, dir('/b')] } }, () => true),
    {
      result: 'unchanged',
    },
  );
  assert.deepEqual(written(backend), ['dirs here: /a=A,/b', 'dirs here: /a=B,/b']);
});
