import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../../scripts/check-cli-release.sh', import.meta.url));

interface Source {
  // The line that names the API version: `API_VERSION` from CLI 0.8.0, `CONTRACT_VERSION` before.
  api: { name: 'API_VERSION' | 'CONTRACT_VERSION'; value: number };
  minClient?: number | undefined;
  version: string;
}

// A repository where each release tag is a commit of its own, followed by the commit under test.
function repo(releases: Record<string, Source>, head: Source): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-release-check-'));
  const git = (...args: string[]): void => {
    const result = spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  mkdirSync(join(dir, 'packages/shared/src'), { recursive: true });
  mkdirSync(join(dir, 'apps/cli'), { recursive: true });
  const commit = (source: Source, tag?: string): void => {
    writeFileSync(
      join(dir, 'packages/shared/src/contract.mts'),
      `export const ${source.api.name} = ${source.api.value};\n${source.minClient === undefined ? '' : `export const MIN_CLIENT = ${source.minClient};\n`}`,
    );
    writeFileSync(join(dir, 'apps/cli/package.json'), `{\n  "version": "${source.version}"\n}\n`);
    git('add', '.');
    git('commit', '-q', '--allow-empty', '-m', tag ?? 'head');
    if (tag !== undefined) git('tag', tag);
  };
  git('init', '-q', '-b', 'main');
  for (const [tag, source] of Object.entries(releases)) commit(source, tag);
  commit(head);
  return dir;
}

function check(dir: string, ...args: string[]): { code: number | null; out: string } {
  const result = spawnSync('sh', [script, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
}

const withRepo = (releases: Record<string, Source>, head: Source, body: (dir: string) => void): void => {
  const dir = repo(releases, head);
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const legacy = (value: number, version: string): Source => ({ api: { name: 'CONTRACT_VERSION', value }, version });
const ranged = (value: number, minClient: number, version: string): Source => ({
  api: { name: 'API_VERSION', value },
  minClient,
  version,
});

test('a release that is still served passes, and the release is tested', () => {
  withRepo({ 'cli-v0.7.0': legacy(9, '0.7.0') }, ranged(10, 9, '0.7.0'), (dir) => {
    assert.equal(check(dir).code, 0);
    assert.equal(check(dir, 'release-behind').code, 1);
  });
});

test('a MIN_CLIENT above the newest release needs a CLI version above the newest cli-v tag', () => {
  withRepo({ 'cli-v0.6.0': legacy(8, '0.6.0'), 'cli-v0.7.0': legacy(9, '0.7.0') }, ranged(10, 10, '0.7.0'), (dir) => {
    const same = check(dir);
    assert.equal(same.code, 1);
    assert.match(same.out, /MIN_CLIENT is 10, but the newest release cli-v0\.7\.0 speaks API 9/);
    assert.match(same.out, /"Upgrading" list/);
    assert.equal(check(dir, 'release-behind').code, 0);
  });
  withRepo({ 'cli-v0.7.0': legacy(9, '0.7.0') }, ranged(10, 10, '0.8.0'), (dir) => {
    assert.equal(check(dir).code, 0);
    assert.equal(check(dir, 'release-behind').code, 0);
  });
});

test('the API version of a release at 0.8.0 or later is its API_VERSION', () => {
  withRepo({ 'cli-v0.8.0': ranged(9, 9, '0.8.0') }, ranged(10, 10, '0.8.0'), (dir) => {
    assert.equal(check(dir).code, 1);
  });
  withRepo({ 'cli-v0.8.0': ranged(9, 9, '0.8.0') }, ranged(10, 10, '0.8.1'), (dir) => {
    assert.equal(check(dir).code, 0);
  });
  withRepo({ 'cli-v0.8.0': ranged(9, 9, '0.8.0') }, ranged(10, 10, '0.9.0'), (dir) => {
    assert.equal(check(dir, 'release-behind').code, 0);
  });
});

test('versions compare as numbers, and only strict x.y.z tags count', () => {
  const releases = {
    'cli-v0.9.0': legacy(7, '0.9.0'),
    'cli-v0.10.0': legacy(7, '0.10.0'),
    'cli-v1.0.0-rc1': legacy(9, '1.0.0'),
    'cli-v9.9.9-beta': legacy(9, '9.9.9'),
  };
  withRepo(releases, ranged(8, 8, '0.9.5'), (dir) => assert.equal(check(dir).code, 1, 'below 0.10.0'));
  withRepo(releases, ranged(8, 8, '0.10.1'), (dir) => assert.equal(check(dir).code, 0));
});

test('no release means nothing to compare with, and a head without MIN_CLIENT is an error', () => {
  withRepo({}, ranged(8, 8, '0.1.0'), (dir) => {
    assert.equal(check(dir).code, 0);
    assert.equal(check(dir, 'release-behind').code, 0);
  });
  withRepo(
    { 'cli-v0.5.0': legacy(7, '0.5.0') },
    { api: { name: 'API_VERSION', value: 8 }, version: '0.6.0' },
    (dir) => {
      assert.equal(check(dir).code, 2);
    },
  );
});
