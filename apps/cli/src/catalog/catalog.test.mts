import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machineCatalogJson, SEALED_LIMITS } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { CONFIG, fakeBackend, fakeCatalogStore } from '../__tests__/helpers/fakes.mts';
import {
  catalogDirs,
  composeCatalog,
  initSkillsIn,
  MAX_PROBED_DIRS,
  recordRunSkills,
  syncCatalog,
} from './catalog.mts';
import type { CatalogSyncDeps } from './catalog.mts';
import { hashSkillNames, RETRY_AFTER_FAILURE_MS } from './cache.mts';
import type { CatalogEntry } from './cache.mts';
import type { ProbeResult } from './probe.mts';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const cmd = (name: string, over: Record<string, unknown> = {}) => ({ name, builtin: false, ...over });
const probed = (commands: ProbeResult['commands'], over: Partial<ProbeResult> = {}): ProbeResult => ({
  claude: '2.1.326',
  models: [{ value: 'opus', label: 'Opus' }],
  commands,
  ...over,
});
const here = (
  path: string,
  result: ProbeResult,
  probedAt = NOW.toISOString(),
): CatalogEntry & { result: ProbeResult } => ({
  path,
  fingerprint: 'fp',
  probedAt,
  probedForInit: null,
  result,
});
const all = () => true;

test('directories to probe are the listed ones that exist, or without a list the routed ones, once each and at most twenty', () => {
  const listed = { ...CONFIG, dirs: [{ path: '/a' }, { path: '/gone' }, { path: '/a' }, { path: '/b', label: 'B' }] };
  assert.deepEqual(
    catalogDirs(listed, (path) => path !== '/gone'),
    ['/a', '/b'],
  );
  const routed = {
    ...CONFIG,
    defaultCwd: '/main',
    lanes: [
      { ...CONFIG.lanes[0]!, cwd: '/lane' },
      { ...CONFIG.lanes[0]!, name: 'x', cwd: '/main' },
    ],
    repos: { 'o/r': '/repo', 'o/gone': '/gone', 'o/rel': 'relative' },
  };
  delete (routed as { dirs?: unknown }).dirs;
  assert.deepEqual(
    catalogDirs(routed, (path) => path !== '/gone'),
    ['/main', '/lane', '/repo'],
  );
  const many = { ...CONFIG, dirs: Array.from({ length: 30 }, (_, i) => ({ path: `/d${i}` })) };
  assert.equal(catalogDirs(many, all).length, MAX_PROBED_DIRS);
  assert.deepEqual(catalogDirs({ ...CONFIG, dirs: [] }, all), []);
});

test('with one directory every skill of it is in skills, and Claude Code’s own commands only when a run reported them', () => {
  const entries = [
    here(
      '/a',
      probed([cmd('review', { description: 'R' }), cmd('compact', { builtin: true }), cmd('docx', { builtin: true })]),
    ),
  ];
  assert.deepEqual(composeCatalog(entries, new Set(['docx'])), {
    claude: '2.1.326',
    models: [{ value: 'opus', label: 'Opus' }],
    skills: [{ name: 'docx' }, { name: 'review', description: 'R' }],
    dirs: {},
  });
  assert.deepEqual(
    composeCatalog(entries, new Set())?.skills.map(({ name }) => name),
    ['review'],
  );
  assert.equal(composeCatalog([], new Set()), undefined);
});

test('with several directories skills are those every one has, and each directory lists the rest', () => {
  const catalog = composeCatalog(
    [
      here('/b', probed([cmd('shared', { description: 'from b' }), cmd('only-b')])),
      here('/a', probed([cmd('shared', { description: 'from a' }), cmd('only-a'), cmd('also-a')])),
      here('/c', probed([cmd('shared'), cmd('x')])),
    ],
    new Set(),
  );
  assert.deepEqual(catalog?.skills, [{ name: 'shared', description: 'from b' }]);
  assert.deepEqual(catalog?.dirs, {
    '/a': [{ name: 'also-a' }, { name: 'only-a' }],
    '/b': [{ name: 'only-b' }],
    '/c': [{ name: 'x' }],
  });
  const same = composeCatalog([here('/a', probed([cmd('s')])), here('/b', probed([cmd('s')]))], new Set());
  assert.deepEqual(same?.dirs, {}, 'a path with nothing of its own is left out');
});

test('the program and the models are those of the newest probe, and the caps hold', () => {
  const catalog = composeCatalog(
    [
      here('/a', probed([], { claude: '1.0.0', models: [{ value: 'old', label: 'Old' }] }), '2026-11-17T10:00:00.000Z'),
      here('/b', probed([], { claude: '2.0.0' }), '2026-11-17T11:00:00.000Z'),
    ],
    new Set(),
  );
  assert.deepEqual([catalog?.claude, catalog?.models], ['2.0.0', [{ value: 'opus', label: 'Opus' }]]);
  const lots = Array.from({ length: 600 }, (_, i) => cmd(`s${String(i).padStart(3, '0')}`));
  assert.equal(composeCatalog([here('/a', probed(lots))], new Set())?.skills.length, 500);
  const own = composeCatalog([here('/a', probed([...lots, ...[]])), here('/b', probed([cmd('s000')]))], new Set());
  assert.equal(own?.dirs['/a']?.length, 200);
});

test('a catalogue over the size limit is cut deterministically: directory descriptions, then all, then the lists', () => {
  const limit = SEALED_LIMITS['machine.catalog'];
  const bytes = (catalog: ReturnType<typeof composeCatalog>): number => Buffer.byteLength(machineCatalogJson(catalog!));
  const fat = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      cmd(`${prefix}${String(i).padStart(3, '0')}`, { description: 'd'.repeat(200), argumentHint: 'h'.repeat(100) }),
    );
  const trims: string[] = [];
  const onTrim = (what: string): void => void trims.push(what);

  // 20 directories of 200 skills of their own: the descriptions of those go first, the common skills keep theirs.
  const dirs = Array.from({ length: 20 }, (_, i) =>
    here(`/d${i}`, probed([cmd('shared', { description: 'kept' }), ...fat(`s${i}-`, 200)])),
  );
  const first = composeCatalog(dirs, new Set(), onTrim)!;
  assert.ok(bytes(first) <= limit);
  assert.deepEqual(first.skills, [{ name: 'shared', description: 'kept' }]);
  assert.equal(first.dirs['/d0']?.length, 200);
  assert.deepEqual(first.dirs['/d0']?.[0], { name: 's0-000' });
  assert.deepEqual(trims, ['the descriptions of the skills of single directories']);

  // Even the names of the directories' skills leave no room for the text of the common ones.
  trims.length = 0;
  const heavy = Array.from({ length: 20 }, (_, i) =>
    here(`/d${i}`, probed([...fat('c', 500), ...fat(`s${i}-${'x'.repeat(30)}-`, 200)])),
  );
  const names = composeCatalog(heavy, new Set(), onTrim)!;
  assert.ok(bytes(names) <= limit);
  assert.equal(names.skills.length, 500);
  assert.deepEqual(names.skills[0], { name: 'c000' });
  assert.deepEqual(trims, ['the descriptions of all skills']);

  // Long names and paths leave no room for all the names: the lists are halved until the document fits.
  trims.length = 0;
  const longName = (prefix: string, i: number) => cmd(`${prefix}${i}-${'n'.repeat(60)}`);
  const long = Array.from({ length: 20 }, (_, i) =>
    here(
      `/${'p'.repeat(3000)}${i}`,
      probed([
        ...Array.from({ length: 500 }, (_, k) => longName('c', k)),
        ...Array.from({ length: 200 }, (_, k) => longName(`s${i}-`, k)),
      ]),
    ),
  );
  const cut = composeCatalog(long, new Set(), onTrim)!;
  assert.ok(bytes(cut) <= limit);
  assert.ok(cut.skills.length < 500 && cut.skills.length > 0);
  assert.deepEqual(trims, ['descriptions and part of the skills']);
  assert.deepEqual(composeCatalog(long, new Set()), cut, 'the same input gives the same document');

  const small = composeCatalog([here('/a', probed([cmd('s', { description: 'D' })]))], new Set(), onTrim)!;
  assert.deepEqual(small.skills, [{ name: 's', description: 'D' }]);
  assert.equal(trims.length, 1, 'a catalogue that fits is not cut');
});

function syncSetup(over: Partial<CatalogSyncDeps> = {}, config: Partial<CatalogSyncDeps['config']> = {}) {
  const backend = fakeBackend([]);
  const store = fakeCatalogStore();
  const logs: string[] = [];
  const probes: string[] = [];
  let answer: ProbeResult | undefined = probed([cmd('review')]);
  const deps: CatalogSyncDeps = {
    backend,
    config: { ...CONFIG, dirs: [{ path: '/a' }, { path: '/b' }], ...config },
    store,
    fingerprintDeps: () => ({ claude: '/usr/bin/claude', mtime: () => 1, claudeDir: '/home/me/.claude' }),
    probe: async (dir) => {
      probes.push(dir);
      return answer;
    },
    now: () => NOW,
    dryRun: false,
    log: (line) => logs.push(line),
    exists: all,
    ...over,
  };
  return { deps, backend, store, logs, probes, answer: (next: ProbeResult | undefined) => void (answer = next) };
}

test('a tick probes one directory, sends what is cached so far, and the next tick takes the next directory', async () => {
  const { deps, backend, probes, store } = syncSetup();
  assert.deepEqual(await syncCatalog(deps), { result: 'sent', skills: 1, models: 1 });
  assert.deepEqual(probes, ['/a']);
  assert.deepEqual(await syncCatalog(deps), { result: 'unchanged' });
  assert.deepEqual(probes, ['/a', '/b']);
  assert.equal(backend.writes.filter((w) => w.startsWith('catalog ')).length, 1, 'the same document is not sent twice');
  assert.deepEqual(await syncCatalog(deps), { result: 'unchanged' });
  assert.deepEqual(probes, ['/a', '/b'], 'nothing is stale any more');
  assert.equal(store.entries.get('/a')?.probedAt, NOW.toISOString());
});

test('the lane names of this machine go with the catalogue, at most twenty, and a change of them sends it again', async () => {
  const lanes = (names: string[]) => names.map((name, index) => ({ name, slots: 1, default: index === 0 }));
  const { deps, backend } = syncSetup({}, { dirs: [{ path: '/a' }], lanes: lanes(['general', 'reviews']) });
  await syncCatalog(deps);
  assert.deepEqual(await syncCatalog(deps), { result: 'unchanged' });
  deps.config = { ...deps.config, lanes: lanes(['general', 'reviews', 'docs']) };
  assert.deepEqual(await syncCatalog(deps), { result: 'sent', skills: 1, models: 1 });
  assert.equal(backend.writes.filter((w) => w.startsWith('catalog ')).length, 2);
  const entry = { ...here('/a', probed([cmd('review')])) };
  const many = composeCatalog(
    [entry],
    new Set(),
    undefined,
    Array.from({ length: 30 }, (_, i) => `l${i}`),
  );
  assert.equal(many?.lanes?.length, 20);
  assert.equal(composeCatalog([entry], new Set())?.lanes, undefined);
});

test('a changed fingerprint, or a run that reported other skills, probes the directory again and sends the new catalogue', async () => {
  const { deps, backend, probes, answer, store } = syncSetup({}, { dirs: [{ path: '/a' }] });
  await syncCatalog(deps);
  answer(probed([cmd('review'), cmd('new')]));
  deps.fingerprintDeps = () => ({ claude: '/usr/bin/claude', mtime: () => 2, claudeDir: '/home/me/.claude' });
  assert.deepEqual(await syncCatalog(deps), { result: 'sent', skills: 2, models: 1 });
  store.writeInit('/a', { hash: 'h1', skills: ['review', 'new'] });
  assert.equal((await syncCatalog(deps)).result, 'unchanged');
  assert.deepEqual(probes, ['/a', '/a', '/a'], 'one more probe for the run’s skills');
  assert.equal(store.entries.get('/a')?.probedForInit, 'h1');
  await syncCatalog(deps);
  assert.equal(probes.length, 3, 'then it stays quiet');
  assert.equal(backend.writes.filter((w) => w.startsWith('catalog ')).length, 2);
});

test('a failed probe keeps the old catalogue, is logged, and is not tried again for an hour', async () => {
  const { deps, logs, probes, answer, store } = syncSetup({}, { dirs: [{ path: '/a' }] });
  answer(undefined);
  assert.deepEqual(await syncCatalog(deps), { result: 'nothing-probed' });
  assert.ok(logs.some((line) => /^WARN asking claude for its skills in \/a failed/.test(line)));
  assert.equal((await syncCatalog(deps)).result, 'nothing-probed');
  assert.equal(probes.length, 1, 'waits');
  deps.now = () => new Date(NOW.getTime() + RETRY_AFTER_FAILURE_MS + 1000);
  answer(probed([cmd('review')]));
  assert.equal((await syncCatalog(deps)).result, 'sent');
  assert.equal(probes.length, 2);
  assert.equal(store.entries.get('/a')?.failure, undefined);
  // A later failure leaves the old result in place.
  deps.fingerprintDeps = () => ({ claude: undefined, mtime: () => 3, claudeDir: '/home/me/.claude' });
  answer(undefined);
  assert.equal((await syncCatalog(deps)).result, 'unchanged');
  assert.equal(store.entries.get('/a')?.result?.commands[0]?.name, 'review');
  assert.ok(store.entries.get('/a')?.failure);
});

test('a directory that never worked is probed before one that is only out of date', async () => {
  const { deps, probes, store } = syncSetup();
  store.write({ ...here('/a', probed([cmd('review')])), fingerprint: 'old' });
  await syncCatalog(deps);
  assert.deepEqual(probes, ['/b']);
});

test('a server without catalogues is asked and left alone; a board failure throws for the caller to log', async () => {
  const { deps, backend } = syncSetup();
  backend.boardCatalog.supported = false;
  assert.deepEqual(await syncCatalog(deps), { result: 'unsupported' });
  backend.boardCatalog.failure = new BackendError('set-catalog: the server answered 502 without JSON', 502);
  await assert.rejects(syncCatalog(deps), /502/);
});

test('a machine with no directory to ask in sends nothing and starts no process', async () => {
  const { deps, probes } = syncSetup({}, { dirs: [] });
  assert.deepEqual(await syncCatalog(deps), { result: 'nothing-probed' });
  assert.deepEqual(probes, []);
});

test('a dry run starts no probe and prints what it would do; what is cached is still sent through the dry backend', async () => {
  const { deps, logs, probes, store } = syncSetup({ dryRun: true });
  assert.deepEqual(await syncCatalog(deps), { result: 'nothing-probed' });
  assert.deepEqual(logs, ['DRY probe claude in /a']);
  store.write(here('/b', probed([cmd('review')])));
  assert.equal((await syncCatalog(deps)).result, 'sent');
  assert.deepEqual(probes, []);
});

test('a cache that cannot be written is logged and the catalogue is still composed from what is there', async () => {
  const { deps, logs, store } = syncSetup();
  store.write = () => {
    throw new Error('disk full');
  };
  assert.deepEqual(await syncCatalog(deps), { result: 'nothing-probed' });
  assert.ok(logs.some((line) => line.includes('could not be updated: disk full')));
});

const reported = (dirs: string[]) => ({
  store: fakeCatalogStore(),
  config: { ...CONFIG, dirs: dirs.map((path) => ({ path })) },
  exists: all,
});

test('the skills a run reports are remembered for the probed directory that covers its directory, worktrees below it included', () => {
  const deps = { ...reported(['/work/app', '/work/lib']), realpath: (path: string) => path };
  assert.equal(recordRunSkills(deps, '/work/app', ['b', 'a', 'bad name', 5]), true);
  assert.deepEqual(deps.store.inits.get('/work/app'), { hash: hashSkillNames(['a', 'b']), skills: ['b', 'a'] });
  assert.equal(recordRunSkills(deps, '/work/lib/.claude/worktrees/feature', ['x']), true);
  assert.deepEqual(deps.store.inits.get('/work/lib')?.skills, ['x']);
  assert.equal(recordRunSkills(deps, '/work/application', ['y']), false, 'a sibling by name is not below it');
  assert.equal(recordRunSkills(deps, '/elsewhere', ['y']), false);
  assert.equal(deps.store.inits.size, 2);
  assert.equal(recordRunSkills(deps, '/work/app', 'not a list'), false);
});

test('a run in the real path of a listed link, or in the nearest of nested directories, is covered by the right one', () => {
  const real = (path: string) => (path === '/link' ? '/real/target' : path);
  const deps = { ...reported(['/link', '/link/inner']), realpath: real };
  assert.equal(recordRunSkills(deps, '/real/target/sub', ['x']), true);
  assert.deepEqual([...deps.store.inits.keys()], ['/link']);
  const nested = { ...reported(['/w', '/w/inner']), realpath: (path: string) => path };
  recordRunSkills(nested, '/w/inner/x', ['y']);
  assert.deepEqual([...nested.store.inits.keys()], ['/w/inner']);
});

test('the skills of a run are read from its start event only', () => {
  assert.deepEqual(initSkillsIn('{"type":"system","subtype":"init","skills":["a","docx"],"cwd":"/x"}'), ['a', 'docx']);
  for (const line of [
    '',
    'not json "init"',
    '{"type":"system","subtype":"hook_started"}',
    '{"type":"assistant","subtype":"init","skills":["a"]}',
    '{"type":"system","subtype":"init"}',
    '{"type":"system","subtype":"init","skills":"a"}',
  ])
    assert.equal(initSkillsIn(line), undefined, line);
});
