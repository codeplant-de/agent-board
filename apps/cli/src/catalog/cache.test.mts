import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogFingerprint, createCatalogStore, hashSkillNames, isStale, RETRY_AFTER_FAILURE_MS } from './cache.mts';
import type { CatalogEntry, FingerprintDeps } from './cache.mts';

const RESULT = {
  claude: '2.1.326',
  models: [{ value: 'opus', label: 'Opus' }],
  commands: [{ name: 'a', builtin: false }],
};
const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  path: '/work/app',
  fingerprint: 'fp',
  probedAt: '2026-11-17T10:00:00.000Z',
  probedForInit: null,
  result: RESULT,
  ...over,
});
const NOW = new Date('2026-11-17T12:00:00.000Z');

function inTemp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-cache-'));
  try {
    run(join(dir, 'catalog'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an entry is written per directory and read back; another directory has none', () =>
  inTemp((dir) => {
    const store = createCatalogStore(dir);
    assert.equal(store.read('/work/app'), undefined);
    store.write(entry());
    store.write(entry({ path: '/work/lib', fingerprint: 'other' }));
    assert.deepEqual(store.read('/work/app'), entry());
    assert.equal(store.read('/work/lib')?.fingerprint, 'other');
    assert.equal(store.read('/work/none'), undefined);
    const failed = entry({ failure: { at: '2026-11-17T11:00:00.000Z', fingerprint: 'fp2' }, result: null });
    store.write(failed);
    assert.deepEqual(store.read('/work/app'), failed);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
      'no temporary file is left',
    );
  }));

test('a file that is not an entry for the path, or is damaged, reads as none', () =>
  inTemp((dir) => {
    const store = createCatalogStore(dir);
    store.write(entry());
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file!), '{"path":"/elsewhere"}');
    assert.equal(store.read('/work/app'), undefined);
    writeFileSync(join(dir, file!), 'not json');
    assert.equal(store.read('/work/app'), undefined);
    writeFileSync(join(dir, file!), JSON.stringify({ ...entry(), result: { commands: 5 } }));
    assert.equal(store.read('/work/app'), undefined);
  }));

test('a worker’s record of the run’s skills is a file of its own, so a probe’s write never loses it', () =>
  inTemp((dir) => {
    const store = createCatalogStore(dir);
    store.writeInit('/work/app', { hash: hashSkillNames(['b', 'a']), skills: ['a', 'b'] });
    store.write(entry());
    assert.deepEqual(store.readInit('/work/app'), { hash: hashSkillNames(['a', 'b']), skills: ['a', 'b'] });
    store.writeInit('/work/lib', { hash: 'h', skills: ['c', 'bad name'] });
    assert.deepEqual([...store.initSkills()].sort(), ['a', 'b', 'c']);
    assert.equal(store.readInit('/work/none'), undefined);
  }));

test('a store in a directory that is not there lists no skills and makes it on the first write', () =>
  inTemp((dir) => {
    const store = createCatalogStore(join(dir, 'deeper'));
    assert.deepEqual([...store.initSkills()], []);
    store.write(entry());
    assert.equal(store.read('/work/app')?.fingerprint, 'fp');
  }));

test('the hash of skill names does not depend on their order or repeats, and changes with the set', () => {
  assert.equal(hashSkillNames(['a', 'b']), hashSkillNames(['b', 'a', 'a']));
  assert.notEqual(hashSkillNames(['a', 'b']), hashSkillNames(['a']));
  assert.match(hashSkillNames([]), /^[0-9a-f]{16}$/);
});

const watched = (times: Record<string, number>, claude: string | undefined = '/usr/bin/claude'): FingerprintDeps => ({
  claude,
  mtime: (path) => times[path],
  claudeDir: '/home/me/.claude',
});

test('the fingerprint changes with the program, the plugin list, the settings and skills of the user and of the directory', () => {
  const base = { '/usr/bin/claude': 1, '/home/me/.claude/plugins/installed_plugins.json': 2 };
  const fingerprint = catalogFingerprint('/work/app', watched(base));
  assert.equal(fingerprint, catalogFingerprint('/work/app', watched({ ...base })));
  const changes: Record<string, number>[] = [
    { '/usr/bin/claude': 9 },
    { '/home/me/.claude/plugins/installed_plugins.json': 9 },
    { '/home/me/.claude/settings.json': 9 },
    { '/home/me/.claude/skills': 9 },
    { '/work/app/.claude/skills': 9 },
    { '/work/app/.claude/settings.json': 9 },
  ];
  for (const change of changes)
    assert.notEqual(
      catalogFingerprint('/work/app', watched({ ...base, ...change })),
      fingerprint,
      JSON.stringify(change),
    );
  assert.notEqual(catalogFingerprint('/work/app', watched(base, '/opt/claude')), fingerprint, 'another program');
  assert.notEqual(catalogFingerprint('/work/app', { ...watched(base), claude: undefined }), fingerprint, 'no program');
  assert.notEqual(
    catalogFingerprint('/work/lib', watched({ ...base, '/work/app/.claude/skills': 5 })),
    catalogFingerprint('/work/app', watched({ ...base, '/work/app/.claude/skills': 5 })),
  );
});

test('a directory is stale when never probed, when its fingerprint changed, or when a run saw other skills than the last probe', () => {
  assert.equal(isStale(undefined, NOW, 'fp', undefined), true);
  assert.equal(isStale(entry(), NOW, 'fp', undefined), false);
  assert.equal(isStale(entry(), NOW, 'changed', undefined), true);
  assert.equal(isStale(entry({ result: null }), NOW, 'fp', undefined), true);
  assert.equal(isStale(entry({ probedForInit: 'h1' }), NOW, 'fp', { hash: 'h1', skills: [] }), false);
  assert.equal(isStale(entry({ probedForInit: 'h1' }), NOW, 'fp', { hash: 'h2', skills: [] }), true);
  assert.equal(isStale(entry({ probedForInit: null }), NOW, 'fp', { hash: 'h2', skills: [] }), true);
  assert.equal(
    isStale(entry({ probedForInit: 'h1' }), NOW, 'fp', undefined),
    false,
    'no run reported since: nothing new',
  );
});

test('a probe that failed waits an hour at the same fingerprint, and goes ahead when the fingerprint changed', () => {
  const failed = (ago: number, fingerprint = 'fp') => ({
    at: new Date(NOW.getTime() - ago).toISOString(),
    fingerprint,
  });
  const never = entry({ result: null, fingerprint: '' });
  assert.equal(isStale({ ...never, failure: failed(60_000) }, NOW, 'fp', undefined), false);
  assert.equal(isStale({ ...never, failure: failed(RETRY_AFTER_FAILURE_MS + 1) }, NOW, 'fp', undefined), true);
  assert.equal(isStale({ ...never, failure: failed(60_000, 'older') }, NOW, 'fp', undefined), true);
  const old = entry({ probedForInit: 'h1', failure: failed(60_000) });
  assert.equal(
    isStale(old, NOW, 'fp', { hash: 'h2', skills: [] }),
    false,
    'a mismatch with a recent failure waits too',
  );
  assert.equal(
    isStale({ ...old, failure: failed(RETRY_AFTER_FAILURE_MS + 1) }, NOW, 'fp', { hash: 'h2', skills: [] }),
    true,
  );
});

test('writes from several processes to different directories do not touch each other', () =>
  inTemp((dir) => {
    mkdirSync(dir, { recursive: true });
    const a = createCatalogStore(dir);
    const b = createCatalogStore(dir);
    a.write(entry({ path: '/a' }));
    b.write(entry({ path: '/b', fingerprint: 'b' }));
    a.write(entry({ path: '/a', fingerprint: 'a2' }));
    assert.equal(b.read('/a')?.fingerprint, 'a2');
    assert.equal(a.read('/b')?.fingerprint, 'b');
  }));
