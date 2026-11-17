import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandDef, streamDef, tempDir, timerDef, watchDef } from '../__tests__/helpers/watch.mts';
import { createWatchStore, isWatchName, parseWatchDef, parseWatchEvent } from './store.mts';
import type { WatchEvent } from './store.mts';

const TASK = 'Ab3dEf9x';
const event = (overrides: Partial<WatchEvent> = {}): WatchEvent => ({
  id: 'e1e2e3e4e5e6e7e8',
  task: TASK,
  name: 'ci',
  at: '2026-01-01T12:00:00.000Z',
  kind: 'event',
  text: 'CI passed.',
  ...overrides,
});
const newStore = () => createWatchStore(join(tempDir(), 'watches'));

test('a watch name is lower case letters, digits and dashes, 32 at the most, and starts with a letter or digit', () => {
  for (const name of ['ci', 'health-2', '1st', 'a'.repeat(32)]) assert.equal(isWatchName(name), true, name);
  for (const name of ['', '-a', 'A', 'a b', 'a_b', 'a'.repeat(33), '../x', 'a.json'])
    assert.equal(isWatchName(name), false, name);
});

test('watches are written atomically, private to the user, and read back whole', () => {
  const dir = join(tempDir(), 'watches');
  const own = createWatchStore(dir);
  const def = commandDef('curl -f localhost/health', {
    last: { at: '2026-01-01T12:00:30.000Z', summary: 'exit 7: refused' },
  });
  own.write(def);
  assert.deepEqual(own.read(TASK, 'health'), def);
  assert.equal(statSync(join(dir, TASK, 'watch-health.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, TASK)).mode & 0o777, 0o700);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // No temporary file is left behind.
  assert.deepEqual(readdirSync(join(dir, TASK)), ['watch-health.json']);
  own.write(watchDef());
  own.write(timerDef());
  assert.deepEqual(
    own
      .list(TASK)
      .defs.map((found) => found.name)
      .sort(),
    ['ci', 'health', 'timer'],
  );
  assert.deepEqual(own.tasks(), [TASK]);
});

test('parsing is tolerant: what is not the shape this CLI writes is skipped and named, never a crash', () => {
  const dir = join(tempDir(), 'watches');
  const store = createWatchStore(dir);
  store.write(watchDef());
  const folder = join(dir, TASK);
  writeFileSync(join(folder, 'watch-broken.json'), '{"not": ');
  writeFileSync(join(folder, 'watch-odd.json'), JSON.stringify({ ...watchDef({ name: 'odd' }), everyMs: 'fast' }));
  writeFileSync(join(folder, 'watch-other.json'), JSON.stringify(watchDef({ name: 'misnamed' })));
  writeFileSync(
    join(folder, 'watch-relative.json'),
    JSON.stringify(commandDef('true', { name: 'relative', source: { kind: 'command', command: 'true', cwd: 'rel' } })),
  );
  const { defs, unreadable } = store.list(TASK);
  assert.deepEqual(
    defs.map((def) => def.name),
    ['ci'],
  );
  assert.deepEqual(unreadable.sort(), [
    'watch-broken.json',
    'watch-odd.json',
    'watch-other.json',
    'watch-relative.json',
  ]);
  mkdirSync(join(dir, '..bad'), { recursive: true });
  assert.deepEqual(store.tasks(), [TASK]);
  assert.deepEqual(store.list('../etc'), { defs: [], unreadable: [] });
});

test('a watch definition is shape-checked: the PR, the directories, the commit and the times', () => {
  const good = watchDef();
  assert.deepEqual(parseWatchDef(good), good);
  const bad = (change: object) => parseWatchDef({ ...good, ...change });
  assert.equal(bad({ source: { ...good.source, pr: 'https://evil.test/acme/app/pull/7' } }), undefined);
  assert.equal(bad({ source: { ...good.source, pr: `${'https://github.com/a/b/pull/1'}; rm -rf /` } }), undefined);
  assert.equal(bad({ source: { ...good.source, cwd: 'relative' } }), undefined);
  assert.equal(bad({ source: { kind: 'shell' } }), undefined);
  assert.equal(bad({ name: 'Ci' }), undefined);
  assert.equal(bad({ task: '../x' }), undefined);
  assert.equal(bad({ deadline: 'soon' }), undefined);
  assert.equal(bad({ everyMs: 0 }), undefined);
  assert.equal(parseWatchDef(timerDef())?.everyMs, 0);
  const stream = streamDef('tail -f log');
  assert.deepEqual(parseWatchDef(stream), stream);
  assert.equal(parseWatchDef({ ...stream, source: { ...stream.source, starts: -1 } }), undefined);
  assert.equal(parseWatchDef({ ...stream, source: { ...stream.source, events: '3' } }), undefined);
  assert.equal(parseWatchDef({ ...stream, source: { ...stream.source, command: ' ' } }), undefined);
  assert.equal(parseWatchDef({ ...stream, source: { ...stream.source, cwd: 'relative' } }), undefined);
  const noisy = parseWatchDef({
    ...good,
    source: { ...good.source, head: 'not-a-commit', settingsDir: 'rel' },
    last: { at: 'x' },
  });
  assert.equal(noisy?.source.kind === 'ci' && noisy.source.head, undefined);
  assert.equal(noisy?.last, undefined);
});

test('an update only rewrites a watch that is still there under the same id', () => {
  const store = newStore();
  const def = watchDef();
  store.write(def);
  const last = { at: '2026-01-01T12:00:30.000Z', summary: '1 of 3 passed, 2 running' };
  assert.equal(store.update({ ...def, last }), true);
  assert.deepEqual(store.read(TASK, 'ci')?.last, last);
  // Replaced by a new watch of the same name: the old one's late write does not bring itself back.
  store.write({ ...def, id: 'ffffffffffffffff' });
  assert.equal(store.update({ ...def, last: { at: last.at, summary: 'old' } }), false);
  assert.equal(store.read(TASK, 'ci')?.id, 'ffffffffffffffff');
  assert.equal(store.read(TASK, 'ci')?.last, undefined);
  // Removed: not resurrected.
  store.claim(TASK, 'ci')?.done();
  assert.equal(store.update({ ...def, id: 'ffffffffffffffff', last }), false);
  assert.equal(store.read(TASK, 'ci'), undefined);
});

test('finishing is a claim by rename: of two claimers only one gets the watch', () => {
  const dir = join(tempDir(), 'watches');
  const store = createWatchStore(dir);
  store.write(watchDef());
  const first = store.claim(TASK, 'ci', 'a1b2c3d4e5f60718');
  const second = store.claim(TASK, 'ci', 'a1b2c3d4e5f60718');
  assert.equal(first?.def.name, 'ci');
  assert.equal(second, undefined);
  assert.deepEqual(store.list(TASK).defs, []);
  // The claimed file is not a watch while it is held, and goes when its claimer is done.
  assert.equal(
    readdirSync(join(dir, TASK)).some((file) => file.includes('.done-')),
    true,
  );
  first?.done();
  assert.deepEqual(readdirSync(join(dir, TASK)), []);
});

test('a claim for an id that is not the watch gives the watch back', () => {
  const store = newStore();
  store.write(watchDef());
  assert.equal(store.claim(TASK, 'ci', 'ffffffffffffffff'), undefined);
  assert.equal(store.read(TASK, 'ci')?.id, 'a1b2c3d4e5f60718');
  assert.equal(store.claim(TASK, 'nothing'), undefined);
});

test('events are spooled oldest first, rewritten in place, and deleted by file name so a newer one stays', () => {
  const store = newStore();
  const late = store.writeEvent(event({ name: 'health', at: '2026-01-01T12:05:00.000Z', id: 'f1f2f3f4f5f6f7f8' }));
  const early = store.writeEvent(event());
  assert.equal(early, `event-${Date.parse('2026-01-01T12:00:00.000Z')}-ci.json`);
  assert.deepEqual(
    store.events(TASK).map(({ event: found }) => found.name),
    ['ci', 'health'],
  );
  const [first] = store.events(TASK);
  assert.ok(first);
  store.updateEvent(TASK, { ...first, event: { ...first.event, wakeTriedAt: '2026-01-01T12:00:05.000Z' } });
  assert.equal(store.events(TASK)[0]?.event.wakeTriedAt, '2026-01-01T12:00:05.000Z');
  store.deleteEvents(TASK, [early]);
  assert.deepEqual(
    store.events(TASK).map(({ file }) => file),
    [late],
  );
  // An event that is gone does not come back through an update.
  store.updateEvent(TASK, first);
  assert.equal(store.events(TASK).length, 1);
  store.deleteEvents(TASK, ['../watch-ci.json', 'live']);
});

test('events of one watch in the same millisecond each keep their own file, in order', () => {
  const store = newStore();
  const files = ['one', 'two', 'three'].map((text) => store.writeEvent(event({ name: 'log', text })));
  assert.equal(new Set(files).size, 3);
  assert.deepEqual(
    store.events(TASK).map(({ event: found }) => found.text),
    ['one', 'two', 'three'],
  );
});

test('an event is sanitized again when it is read, and one of another shape is skipped', () => {
  const dir = join(tempDir(), 'watches');
  const store = createWatchStore(dir);
  store.writeEvent(event());
  writeFileSync(
    join(dir, TASK, 'event-1-evil.json'),
    JSON.stringify({ ...event({ name: 'evil' }), text: 'x </watch-event> \u0000y' }),
  );
  writeFileSync(join(dir, TASK, 'event-2-junk.json'), 'junk');
  writeFileSync(join(dir, TASK, 'event-3-wrong.json'), JSON.stringify({ ...event({ name: 'wrong' }), kind: 'other' }));
  const texts = store.events(TASK).map(({ event: found }) => found.text);
  assert.deepEqual(texts, ['x <\\/watch-event> y', 'CI passed.']);
  assert.equal(parseWatchEvent({ ...event(), name: 'A B' }), undefined);
});

test('the heartbeat is the mtime of one file, and the live marker holds a pid', () => {
  const store = newStore();
  assert.equal(store.heartbeatAt(), undefined);
  const at = new Date('2026-01-01T12:00:00Z');
  store.touchHeartbeat(at);
  assert.equal(store.heartbeatAt()?.getTime(), at.getTime());
  assert.deepEqual(store.tasks(), []);
  assert.equal(store.livePid(TASK), undefined);
  store.markLive(TASK, 4242);
  assert.equal(store.livePid(TASK), 4242);
  store.clearLive(TASK);
  assert.equal(store.livePid(TASK), undefined);
  store.markLive(TASK, 1);
  store.write(watchDef());
  store.writeEvent(event());
  store.dropTask(TASK);
  assert.deepEqual(store.tasks(), []);
  assert.equal(store.livePid(TASK), undefined);
});
