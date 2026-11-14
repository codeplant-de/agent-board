import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetName, checksumOf, compareVersions, newestRelease, realGh, selfUpdate } from '../src/self-update.mts';
import type { SelfUpdateDeps } from '../src/self-update.mts';
import { fakeGh, sha256 } from './helpers-gh.mts';
import type { FakeRelease } from './helpers-gh.mts';
import { runBoard } from '../src/commands.mts';

const ASSET = 'board-linux-x64';

function fixture(releases: FakeRelease[], overrides: Partial<SelfUpdateDeps> = {}) {
  const gh = fakeGh(releases);
  const dir = mkdtempSync(join(tmpdir(), 'board-selfupdate-test-'));
  const execPath = join(dir, 'board');
  writeFileSync(execPath, 'old binary', { mode: 0o755 });
  const printed: string[] = [];
  const deps: SelfUpdateDeps = {
    compiled: true,
    version: '0.3.0',
    execPath,
    platform: 'linux',
    arch: 'x64',
    gh: realGh(gh.env),
    print: (line) => printed.push(line),
    ...overrides,
  };
  const clean = (): void => {
    rmSync(gh.dir, { recursive: true });
    rmSync(dir, { recursive: true });
  };
  return { gh, dir, execPath, printed, deps, clean };
}

test('versions compare numerically, and the newest published cli release wins', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.3.1'), -1);
  const listing = JSON.stringify([
    { tagName: 'cli-v0.9.0', isDraft: false, isPrerelease: false },
    { tagName: 'cli-v0.10.0', isDraft: false, isPrerelease: false },
    { tagName: 'cli-v0.11.0', isDraft: true, isPrerelease: false },
    { tagName: 'cli-v0.12.0-rc1', isDraft: false, isPrerelease: true },
    { tagName: 'cli-v0.13.0-rc.1', isDraft: false, isPrerelease: false },
    { tagName: 'cli-v1.0', isDraft: false, isPrerelease: false },
    { tagName: 'server-v9.0.0', isDraft: false, isPrerelease: false },
  ]);
  assert.deepEqual(newestRelease(listing), { tag: 'cli-v0.10.0', version: '0.10.0' });
  assert.equal(newestRelease('[]'), undefined);
  assert.throws(() => newestRelease('nope'), /did not return JSON/);
  assert.equal(assetName('linux', 'arm64'), 'board-linux-arm64');
  assert.equal(assetName('darwin', 'arm64'), 'board-darwin-arm64');
  assert.throws(() => assetName('win32', 'x64'), /no released binary/);
  assert.throws(() => assetName('darwin', 'x64'), /no released binary for darwin-x64/);
  assert.equal(
    checksumOf(`${'a'.repeat(64)}  board-linux-x64\n${'b'.repeat(64)} *board-darwin-arm64\n`, 'board-darwin-arm64'),
    'b'.repeat(64),
  );
});

test('in a checkout it says to pull, and touches nothing', async () => {
  const { deps, clean } = fixture([], { compiled: false, version: undefined });
  try {
    await assert.rejects(selfUpdate(deps, {}), /git pull.*pnpm install/);
  } finally {
    clean();
  }
});

test('a missing gh and a gh that is not logged in are named', async () => {
  const missing = fixture([], { gh: realGh({ PATH: '/nonexistent' }) });
  const loggedOut = fixture([{ tag: 'cli-v0.4.0' }]);
  try {
    await assert.rejects(selfUpdate(missing.deps, {}), /gh is not installed/);
    loggedOut.gh.loggedOut();
    await assert.rejects(selfUpdate(loggedOut.deps, {}), /gh is not logged in: run "gh auth login"/);
  } finally {
    missing.clean();
    loggedOut.clean();
  }
});

test('an up-to-date binary says so; --check reports a newer release and downloads nothing', async () => {
  const same = fixture([{ tag: 'cli-v0.3.0' }]);
  const newer = fixture([{ tag: 'cli-v0.3.0' }, { tag: 'cli-v0.4.0', assets: { [ASSET]: 'new binary' } }]);
  try {
    await selfUpdate(same.deps, {});
    assert.deepEqual(same.printed, ['board 0.3.0 is the newest release']);
    await selfUpdate(newer.deps, { check: true });
    assert.match(newer.printed[0] ?? '', /board 0\.4\.0 is available \(this is 0\.3\.0\)/);
    assert.equal(readFileSync(newer.execPath, 'utf8'), 'old binary');
  } finally {
    same.clean();
    newer.clean();
  }
});

test('an update replaces the binary beside itself with mode 755 and leaves nothing behind', async () => {
  const { deps, execPath, dir, printed, clean } = fixture([
    { tag: 'cli-v0.3.0', assets: { [ASSET]: 'v3' } },
    { tag: 'cli-v0.10.0', assets: { [ASSET]: 'the new binary', 'board-darwin-arm64': 'other' } },
    { tag: 'cli-v0.9.0', assets: { [ASSET]: 'v9' } },
  ]);
  try {
    chmodSync(execPath, 0o700);
    await selfUpdate(deps, {});
    assert.equal(readFileSync(execPath, 'utf8'), 'the new binary');
    assert.equal(statSync(execPath).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(dir), ['board']);
    assert.deepEqual(printed, ['updated board 0.3.0 -> 0.10.0']);
  } finally {
    clean();
  }
});

test('a download that does not match SHA256SUMS is refused, and so is a missing entry', async () => {
  const bad = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'tampered' }, sums: `${sha256('genuine')}  ${ASSET}` }]);
  const unlisted = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'x' }, sums: `${sha256('x')}  other-file` }]);
  try {
    await assert.rejects(selfUpdate(bad.deps, {}), /does not match SHA256SUMS; nothing was replaced/);
    assert.equal(readFileSync(bad.execPath, 'utf8'), 'old binary');
    await assert.rejects(selfUpdate(unlisted.deps, {}), /does not list board-linux-x64/);
    assert.equal(readFileSync(unlisted.execPath, 'utf8'), 'old binary');
  } finally {
    bad.clean();
    unlisted.clean();
  }
});

test('board self-update is refused inside a run, and in a checkout says to pull', async () => {
  await assert.rejects(
    runBoard(['self-update'], { env: { AGENT_BOARD_TASK: 'Zt0Test1' } }),
    /not available inside a board run/,
  );
  await assert.rejects(runBoard(['self-update', '--check'], { env: {} }), /git pull/);
});

test('the staging file beside the binary has an unpredictable name and is gone afterwards', async () => {
  const { deps, dir, clean } = fixture([
    { tag: 'cli-v0.3.0', assets: { [ASSET]: 'v3' } },
    { tag: 'cli-v0.4.0', assets: { [ASSET]: 'the new binary' } },
  ]);
  try {
    // A planted file of the old predictable name must not matter.
    writeFileSync(join(dir, `.board-update-${process.pid}`), 'planted');
    await selfUpdate(deps, {});
    assert.deepEqual(readdirSync(dir).sort(), ['.board-update-' + process.pid, 'board']);
    assert.equal(readFileSync(join(dir, `.board-update-${process.pid}`), 'utf8'), 'planted');
  } finally {
    clean();
  }
});
