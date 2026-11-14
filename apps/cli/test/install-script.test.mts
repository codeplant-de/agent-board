import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeGh } from './helpers-gh.mts';
import type { FakeRelease } from './helpers-gh.mts';

const script = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const asset = `board-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

function install(
  releases: FakeRelease[],
  options: { loggedOut?: boolean; withoutGh?: boolean; onPath?: boolean } = {},
) {
  const gh = fakeGh(releases);
  const dir = mkdtempSync(join(tmpdir(), 'board-install-test-'));
  const installDir = join(dir, 'bin');
  let path = `${gh.env['PATH']}`;
  if (options.withoutGh) {
    // Only the tools the script itself needs, so a gh of this machine cannot answer.
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    for (const tool of [
      'uname',
      'grep',
      'sort',
      'tail',
      'printf',
      'mktemp',
      'rm',
      'awk',
      'sha256sum',
      'cp',
      'chmod',
      'mv',
      'mkdir',
      'cat',
      'dirname',
    ]) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found.startsWith('/')) symlinkSync(found, join(tools, tool));
    }
    path = tools;
  }
  if (options.onPath) path = `${installDir}:${path}`;
  if (options.loggedOut) gh.loggedOut();
  const result = spawnSync('/bin/sh', [script], {
    encoding: 'utf8',
    env: { PATH: path, HOME: dir, BOARD_INSTALL_DIR: installDir, FAKE_GH: gh.dir, FAKE_GH_JQ: 'tags' },
  });
  return { result, installDir, clean: () => (rmSync(dir, { recursive: true }), rmSync(gh.dir, { recursive: true })) };
}

test('it installs the newest cli release after checking its checksum, and prints the next steps', () => {
  const { result, installDir, clean } = install([
    { tag: 'cli-v0.9.0', assets: { [asset]: 'old' } },
    { tag: 'cli-v0.10.0', assets: { [asset]: '#!/bin/sh\necho the new board\n' } },
    { tag: 'cli-v0.11.0', draft: true, assets: { [asset]: 'draft' } },
    { tag: 'server-v5.0.0', assets: { [asset]: 'server' } },
  ]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(installDir, 'board'), 'utf8'), '#!/bin/sh\necho the new board\n');
    assert.equal(statSync(join(installDir, 'board')).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(installDir), ['board']);
    assert.match(result.stdout, /installed board 0\.10\.0 to /);
    assert.ok(result.stdout.indexOf('board init') < result.stdout.indexOf('board setup --enable'));
    assert.ok(result.stdout.indexOf('board setup --enable') < result.stdout.indexOf('board doctor'));
    assert.match(result.stderr, /is not on your PATH/);
  } finally {
    clean();
  }
});

test('no warning when the install directory is on PATH', () => {
  const { result, clean } = install([{ tag: 'cli-v0.3.0', assets: { [asset]: 'x' } }], { onPath: true });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /PATH/);
  } finally {
    clean();
  }
});

test('a checksum that does not match installs nothing', () => {
  const { result, installDir, clean } = install([
    { tag: 'cli-v0.3.0', assets: { [asset]: 'tampered' }, sums: `${'0'.repeat(64)}  ${asset}` },
  ]);
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match SHA256SUMS; nothing was installed/);
    assert.throws(() => readdirSync(installDir));
  } finally {
    clean();
  }
});

test('a missing entry in SHA256SUMS, no release, a missing gh and a gh that is not logged in are all refused', () => {
  const unlisted = install([{ tag: 'cli-v0.3.0', assets: { [asset]: 'x' }, sums: `${'0'.repeat(64)}  other` }]);
  const none = install([{ tag: 'server-v1.0.0' }]);
  const noGh = install([], { withoutGh: true });
  const loggedOut = install([{ tag: 'cli-v0.3.0', assets: { [asset]: 'x' } }], { loggedOut: true });
  try {
    assert.match(unlisted.result.stderr, /does not list/);
    assert.match(none.result.stderr, /no cli-v\* release/);
    assert.match(noGh.result.stderr, /gh is not installed/);
    assert.match(loggedOut.result.stderr, /gh is not logged in/);
    for (const { result } of [unlisted, none, noGh, loggedOut]) assert.equal(result.status, 1);
  } finally {
    for (const item of [unlisted, none, noGh, loggedOut]) item.clean();
  }
});

test('the scripts pass shellcheck when it is installed', (context) => {
  const found = spawnSync('shellcheck', ['--version']);
  if (found.status !== 0) return context.skip('shellcheck is not installed');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const result = spawnSync('shellcheck', ['scripts/install.sh', 'apps/cli/build.sh'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout);
});
