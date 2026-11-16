import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { BackendError } from '../src/backend.mts';
import { UsageError } from '../src/cli.mts';
import type { LinkingContext } from '../src/cli.mts';
import { runBoard } from '../src/commands.mts';
import type { ProgramOptions } from '../src/commands.mts';
import { ConfigError } from '../src/config.mts';
import { changeDirs, coveringDir, isAllowedDir } from '../src/dirs.mts';
import { CONFIG, fakeBackend, linkTo, schedule, task } from './helpers.mts';

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

interface Fixture {
  root: string;
  home: string;
  configFile: string;
  // A directory under the root; created unless `missing`.
  make: (name: string) => string;
  config: () => Record<string, unknown>;
  text: () => string;
}

function fixture(context: TestContext, config: Record<string, unknown> | string | null = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-dirs-test-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'config'));
  const configFile = join(root, 'config', 'config.json');
  if (config !== null)
    writeFileSync(
      configFile,
      typeof config === 'string'
        ? config
        : `${JSON.stringify({ machine: 'here', defaultCwd: home, ...config }, null, 2)}\n`,
      { mode: 0o640 },
    );
  return {
    root,
    home,
    configFile,
    make: (name) => {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    config: () => JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>,
    text: () => readFileSync(configFile, 'utf8'),
  };
}

const dirsOf = (fx: Fixture): string[] => Object.keys((fx.config()['dirs'] ?? {}) as object);

interface Run {
  backend: ReturnType<typeof fakeBackend>;
  printed: string[];
  go: (argv: string[], overrides?: ProgramOptions) => Promise<void>;
}

function runner(fx: Fixture, cwd: string = fx.root): Run {
  const backend = fakeBackend([]);
  const printed: string[] = [];
  const makeContext = (dryRun: boolean): LinkingContext => ({
    config: CONFIG,
    backend,
    dryRun,
    taskLink: linkTo,
    print: (line) => printed.push(line),
  });
  const go = (argv: string[], overrides: ProgramOptions = {}) =>
    runBoard(argv, {
      env: { AGENT_BOARD_CONFIG_DIR: join(fx.root, 'config') },
      context: makeContext,
      writeOut: (text) => printed.push(text.trimEnd()),
      writeErr: (text) => printed.push(text.trimEnd()),
      cwd,
      home: fx.home,
      ...overrides,
    });
  return { backend, printed, go };
}

const said = (run: Run): string => run.printed.join('\n');

test('the writer changes only the dirs key: other keys keep their values and order, the mode stays, no temp file is left', (context) => {
  const fx = fixture(context, {
    autoUpdate: 'never',
    lanes: { general: { skills: ['*'], slots: 3 } },
    repos: { 'a/b': '/srv/b' },
    zzz: [1, 2, { x: null }],
  });
  chmodSync(fx.configFile, 0o640);
  const before = fx.config();
  changeDirs(fx.configFile, (keys) => [...keys.map(({ key }) => key), '/srv/one']);
  const after = fx.config();
  assert.deepEqual(Object.keys(after), [...Object.keys(before), 'dirs']);
  for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
  assert.deepEqual(after['dirs'], { '/srv/one': {} });
  assert.equal(statSync(fx.configFile).mode & 0o777, 0o640);
  assert.ok(fx.text().endsWith('}\n') && fx.text().includes('\n  "machine": "here"'));
  assert.deepEqual(readdirSync(join(fx.root, 'config')), ['config.json']);

  changeDirs(fx.configFile, (keys) => [...keys.map(({ key }) => key), '~/two']);
  assert.deepEqual(Object.keys(fx.config()), [...Object.keys(before), 'dirs'], 'a second change keeps dirs in place');
  assert.deepEqual(Object.keys(fx.config()['dirs'] as object), ['/srv/one', '~/two']);
});

test('the writer refuses a missing file, a file that is not JSON and a config that does not parse, and leaves them as they are', (context) => {
  const missing = fixture(context, null);
  assert.throws(
    () => changeDirs(missing.configFile, () => []),
    (error) => error instanceof ConfigError && /missing.*board init/.test(error.message),
  );
  assert.deepEqual(readdirSync(join(missing.root, 'config')), []);

  const broken = fixture(context, '{ "machine": ');
  assert.throws(() => changeDirs(broken.configFile, () => ['/x']), /not valid JSON/);
  assert.equal(broken.text(), '{ "machine": ');

  const invalid = fixture(context, JSON.stringify({ machine: 'here', lanes: {} }));
  assert.throws(() => changeDirs(invalid.configFile, () => ['/x']), /lanes/);
  assert.equal(invalid.text(), JSON.stringify({ machine: 'here', lanes: {} }));
  assert.deepEqual(readdirSync(join(invalid.root, 'config')), ['config.json']);
});

test('the writer removes its temp file when the rename fails, and writes through a link', (context) => {
  const fx = fixture(context, {});
  const target = join(fx.root, 'dotfiles-config.json');
  writeFileSync(target, fx.text());
  rmSync(fx.configFile);
  symlinkSync(target, fx.configFile);
  changeDirs(fx.configFile, () => ['/srv/x']);
  assert.ok(statSync(fx.configFile).isFile());
  assert.equal(JSON.stringify(JSON.parse(readFileSync(target, 'utf8')).dirs), '{"/srv/x":{}}');
  assert.deepEqual(readdirSync(join(fx.root, 'config')), ['config.json']);
  assert.deepEqual(
    readdirSync(fx.root).filter((name) => name.includes('.tmp-')),
    [],
  );

  const failing = fixture(context, {});
  assert.throws(() =>
    changeDirs(failing.configFile, () => {
      throw new Error('stop');
    }),
  );
  assert.deepEqual(readdirSync(join(failing.root, 'config')), ['config.json']);
});

test('dirs lists the entries, marks a missing directory, and says how to start when there are none', async (context) => {
  const empty = fixture(context, {});
  const first = runner(empty);
  await first.go(['dirs']);
  assert.match(said(first), /no directories are listed: the dirs key is not set/);
  assert.match(said(first), /board dirs add/);

  const fx = fixture(context, { dirs: { [fixture(context, {}).root]: {} } });
  const gone = join(fx.root, 'gone');
  changeDirs(fx.configFile, (keys) => [...keys.map(({ key }) => key), gone]);
  const run = runner(fx);
  await run.go(['dirs', 'list']);
  const lines = run.printed;
  assert.match(lines[0] ?? '', /^dirs \(2\), enforced/);
  assert.ok(lines[1] !== undefined && !lines[1].includes('missing'));
  assert.equal(lines[2], `  ${gone}  missing`);
});

test('dirs list works inside a board run; add and rm do not', async (context) => {
  const fx = fixture(context, { dirs: { '/srv/a': {} } });
  const run = runner(fx);
  const inRun = { env: { AGENT_BOARD_TASK: 'Zt0Test1', AGENT_BOARD_CONFIG_DIR: join(fx.root, 'config') } };
  await run.go(['dirs', 'list'], inRun);
  await assert.rejects(run.go(['dirs', 'add'], inRun), /not available inside a board run/);
  await assert.rejects(run.go(['dirs', 'rm', '/srv/a'], inRun), /not available inside a board run/);
  await assert.rejects(run.go(['dirs', 'add', '--from-config'], inRun), /not available inside a board run/);
  assert.deepEqual(dirsOf(fx), ['/srv/a']);
});

test('dirs refuses words and flags that do not belong', async (context) => {
  const run = runner(fixture(context, {}));
  for (const argv of [
    ['dirs', 'bogus'],
    ['dirs', 'list', '/x'],
    ['dirs', 'add', '/x', '/y'],
    ['dirs', 'add', '--force'],
    ['dirs', 'rm', '--from-config'],
    ['dirs', 'add', '--from-config', '/x'],
  ])
    await assert.rejects(run.go(argv), UsageError, argv.join(' '));
});

test('add lists the realpath of the working directory, creating the key with a note on the first add', async (context) => {
  const fx = fixture(context, { autoUpdate: 'never' });
  const project = fx.make('project');
  const link = join(fx.root, 'link');
  symlinkSync(project, link);
  const run = runner(fx, link);
  await run.go(['dirs', 'add']);
  assert.deepEqual(dirsOf(fx), [project]);
  assert.ok(Object.keys(fx.config()).at(-1) === 'dirs');
  assert.match(said(run), new RegExp(`listed ${project}`));
  assert.match(said(run), /now run tasks only in listed directories/);
  assert.match(said(run), /board dirs add --from-config/);

  const second = runner(fx, link);
  await second.go(['dirs', 'add', fx.make('other')]);
  assert.doesNotMatch(said(second), /now run tasks only in listed directories/, 'the note is for the first add only');
  assert.equal(dirsOf(fx).length, 2);
});

test('add takes a path relative to the working directory, and ~', async (context) => {
  const fx = fixture(context, {});
  fx.make('proj/sub');
  const run = runner(fx);
  await run.go(['dirs', 'add', 'proj/sub']);
  assert.deepEqual(dirsOf(fx), [join(fx.root, 'proj', 'sub')]);
});

test('adding a listed directory says so and writes nothing', async (context) => {
  const fx = fixture(context, {});
  const project = fx.make('project');
  const run = runner(fx);
  await run.go(['dirs', 'add', project]);
  const written = fx.text();
  const again = runner(fx);
  await again.go(['dirs', 'add', project]);
  assert.match(said(again), /already listed/);
  assert.equal(fx.text(), written);
});

test('adding a directory inside a listed one still lists it, and names the parent', async (context) => {
  const fx = fixture(context, {});
  const parent = fx.make('project');
  const child = fx.make('project/sub');
  await runner(fx).go(['dirs', 'add', parent]);
  const run = runner(fx);
  await run.go(['dirs', 'add', child]);
  assert.deepEqual(dirsOf(fx), [parent, child]);
  assert.match(said(run), new RegExp(`already allowed through ${parent}`));
});

test('add refuses /, a missing path and a file, and warns about the home directory', async (context) => {
  const fx = fixture(context, {});
  const run = runner(fx);
  await assert.rejects(run.go(['dirs', 'add', '/']), /would allow every directory/);
  await assert.rejects(run.go(['dirs', 'add', join(fx.root, 'nope')]), /not an existing directory/);
  writeFileSync(join(fx.root, 'file'), 'x');
  await assert.rejects(run.go(['dirs', 'add', join(fx.root, 'file')]), /not an existing directory/);
  assert.equal(fx.config()['dirs'], undefined);

  await run.go(['dirs', 'add', fx.home]);
  assert.deepEqual(dirsOf(fx), [fx.home]);
  assert.match(said(run), /warning: .*home directory.*every directory below/);
});

test('add refuses a 201st directory', async (context) => {
  const fx = fixture(context, {
    dirs: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`/srv/d${index}`, {}])),
  });
  await assert.rejects(runner(fx).go(['dirs', 'add', fx.make('one-more')]), /already has 200/);
  assert.equal(dirsOf(fx).length, 200);
});

test('add refuses when config.json is missing or broken', async (context) => {
  const missing = fixture(context, null);
  await assert.rejects(runner(missing).go(['dirs', 'add', missing.root]), /board init/);
  const broken = fixture(context, 'not json');
  await assert.rejects(runner(broken).go(['dirs', 'add', broken.root]), /not valid JSON/);
  assert.equal(broken.text(), 'not json');
});

test('a dry run prints what it would do and writes nothing', async (context) => {
  const fx = fixture(context, { dirs: { '/srv/a': {} } });
  const written = fx.text();
  const run = runner(fx);
  await run.go(['--dry-run', 'dirs', 'add', fx.root]);
  await run.go(['dirs', 'rm', '--dry-run', '--force', '/srv/a']);
  assert.match(said(run), /DRY list /);
  assert.match(said(run), /DRY unlist \/srv\/a/);
  assert.equal(fx.text(), written);
});

test('add --from-config lists what the config routes to, skipping what is missing, covered, or too broad', async (context) => {
  const fx = fixture(context, {});
  const checkout = fx.make('checkout');
  const lane = fx.make('lane');
  const inside = fx.make('checkout/inner');
  const config = {
    machine: 'here',
    defaultCwd: fx.home,
    lanes: { reviews: { skills: ['/review-pr'], slots: 1, cwd: lane }, general: { skills: ['*'], slots: 1 } },
    repos: { 'a/checkout': checkout, 'a/inner': inside, 'a/gone': join(fx.root, 'gone'), 'a/root': '/' },
  };
  writeFileSync(fx.configFile, JSON.stringify(config));
  const run = runner(fx);
  await run.go(['dirs', 'add', '--from-config']);
  assert.deepEqual(dirsOf(fx), [lane, checkout]);
  const text = said(run);
  assert.match(text, /skipped defaultCwd: .*your home directory/);
  assert.match(text, new RegExp(`listed lane reviews cwd: ${lane}`));
  assert.match(text, new RegExp(`skipped repos a/inner: ${inside} \\(already allowed through ${checkout}\\)`));
  assert.match(text, /skipped repos a\/gone: .*not an existing directory/);
  assert.match(text, /skipped repos a\/root: \/ \(\/ would allow too much/);
  assert.match(text, /now run tasks only in listed directories/);

  const again = runner(fx);
  const written = fx.text();
  await again.go(['dirs', 'add', '--from-config']);
  assert.equal(fx.text(), written);
});

test('add --from-config with nothing to add does not create the key', async (context) => {
  const fx = fixture(context, {});
  await runner(fx).go(['dirs', 'add', '--from-config']);
  assert.equal(fx.config()['dirs'], undefined);
});

function listDirs(fx: Fixture, run: Run, listed: string[]): void {
  writeFileSync(
    fx.configFile,
    JSON.stringify({
      machine: 'here',
      defaultCwd: fx.home,
      dirs: Object.fromEntries(listed.map((path) => [path, {}])),
    }),
  );
  run.backend.tasks = [];
}

test('rm unlists a directory that nothing uses, without the board knowing of any work', async (context) => {
  const fx = fixture(context, {});
  const a = fx.make('a');
  const b = fx.make('b');
  const run = runner(fx);
  listDirs(fx, run, [a, b]);
  run.backend.tasks = [
    task({ id: 'other-machine', machine: 'elsewhere', workdir: a }),
    task({ id: 'done-task', machine: 'here', workdir: a, status: 'done' }),
    task({ id: 'closed-task', machine: 'here', workdir: a, closed: true }),
    task({ id: 'elsewhere-dir', machine: 'here', workdir: b }),
    task({ id: 'unreadable', machine: 'here', workdir: null }),
  ];
  run.backend.schedules = [
    schedule({ id: 'ended', machine: 'here', workdir: a, ended: true }),
    schedule({ id: 'foreign', machine: 'elsewhere', workdir: a }),
  ];
  await run.go(['dirs', 'rm', a]);
  assert.deepEqual(dirsOf(fx), [b]);
  assert.match(said(run), new RegExp(`unlisted ${a}`));
});

test('rm refuses while an open task or schedule of this machine would be left with no listed directory, unless --force', async (context) => {
  const fx = fixture(context, {});
  const parent = fx.make('parent');
  const child = fx.make('parent/child');
  const run = runner(fx);
  listDirs(fx, run, [parent, child]);
  run.backend.tasks = [task({ id: 'T1', machine: 'here', workdir: join(child, 'deep'), status: 'todo' })];
  run.backend.schedules = [schedule({ id: 'S1', machine: 'here', workdir: child })];
  await run.go(['dirs', 'rm', child]);
  assert.deepEqual(dirsOf(fx), [parent], 'the parent still covers the work');

  listDirs(fx, run, [parent, child]);
  run.backend.tasks = [task({ id: 'T1', machine: 'here', workdir: join(parent, 'x'), status: 'needs-me' })];
  run.backend.schedules = [schedule({ id: 'S1', machine: 'here', workdir: `${parent}/y\u001b[2J` })];
  await assert.rejects(run.go(['dirs', 'rm', parent]), (error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /task T1 in .*parent\/x/);
    assert.match(error.message, /schedule S1 in .*parent\/y\u241b\[2J/);
    assert.ok(!error.message.includes(String.fromCharCode(27)));
    assert.match(error.message, /stops in Needs me at its next start/);
    assert.match(error.message, /--force/);
    return true;
  });
  assert.deepEqual(dirsOf(fx), [parent, child]);
  await run.go(['dirs', 'rm', '--force', parent]);
  assert.deepEqual(dirsOf(fx), [child]);
});

test('rm refuses without --force when the board cannot be reached, and --force needs no board', async (context) => {
  const fx = fixture(context, {});
  const a = fx.make('a');
  const run = runner(fx);
  listDirs(fx, run, [a]);
  run.backend.listTasks = async () => {
    throw new BackendError('cannot reach https://board.example.com: fetch failed');
  };
  await assert.rejects(run.go(['dirs', 'rm', a]), /could not check.*--force/);
  assert.deepEqual(dirsOf(fx), [a]);
  await run.go(['dirs', 'rm', '--force', a]);
  assert.deepEqual(dirsOf(fx), []);
  assert.deepEqual(fx.config()['dirs'], {}, 'the last entry leaves an empty object');
  assert.match(said(run), /it allows nothing/);
});

test('rm matches a directory that is gone by its listed path, a link by its realpath, and errors on one that is not listed', async (context) => {
  const fx = fixture(context, {});
  const real = fx.make('real');
  const link = join(fx.root, 'link');
  symlinkSync(real, link);
  const gone = join(fx.root, 'gone');
  const run = runner(fx);
  listDirs(fx, run, [real, gone]);
  await run.go(['dirs', 'rm', link]);
  assert.deepEqual(dirsOf(fx), [gone]);
  await run.go(['dirs', 'rm', gone]);
  assert.deepEqual(dirsOf(fx), []);
  await assert.rejects(run.go(['dirs', 'rm', real]), /is not listed/);

  const unset = fixture(context, {});
  await assert.rejects(runner(unset).go(['dirs', 'rm', unset.root]), /no directories are listed/);
});

test('rm keeps the other keys and the other entries as written', async (context) => {
  const fx = fixture(context, { autoUpdate: 'never', dirs: { '~/keep': {}, '/srv/drop': {} } });
  const before = fx.config();
  await runner(fx).go(['dirs', 'rm', '--force', '/srv/drop']);
  const after = fx.config();
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(after['dirs'], { '~/keep': {} });
  assert.equal(after['autoUpdate'], 'never');
});

// `board schedule` and `board add` take the directory from where they run; with a list it has to be an allowed one.
function enforced(fx: Fixture, dirs: string[] | undefined, cwd: string, env: Record<string, string> = {}) {
  const backend = fakeBackend([]);
  const workdirs: (string | undefined)[] = [];
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => {
    workdirs.push(draft.workdir);
    return addTask(draft);
  };
  const go = (argv: string[]) =>
    runBoard(argv, {
      env,
      context: (dryRun): LinkingContext => ({
        config: { ...CONFIG, ...(dirs === undefined ? {} : { dirs: dirs.map(dir) }) },
        backend,
        dryRun,
        taskLink: linkTo,
        print: () => undefined,
      }),
      writeOut: () => undefined,
      writeErr: () => undefined,
      cwd,
      home: fx.home,
    });
  return { backend, workdirs, go };
}

test('board schedule refuses outside the list before it asks the board, and works inside it or without a list', async (context) => {
  const fx = fixture(context);
  const listed = fx.make('listed');
  const other = fx.make('other');
  const outside = enforced(fx, [listed], other);
  for (const argv of [
    ['schedule', '--new', 'x'],
    ['schedule', '--every', '2h', 'x'],
    ['schedule', '--cron', '0 9 * * 1', 'x'],
  ])
    await assert.rejects(outside.go(argv), (error: Error) => {
      assert.ok(error instanceof UsageError);
      assert.ok(
        error.message.includes(`${other} is not a listed directory`) && error.message.includes('board dirs add'),
      );
      return true;
    });
  assert.deepEqual(outside.backend.writes, []);

  const inside = enforced(fx, [listed], fx.make('listed/sub'));
  await inside.go(['schedule', '--new', 'x']);
  assert.equal(inside.backend.writes.length, 1);
  const unlimited = enforced(fx, undefined, other);
  await unlimited.go(['schedule', '--new', 'x']);
  assert.equal(unlimited.backend.writes.length, 1);
  await assert.rejects(enforced(fx, [], listed).go(['schedule', '--new', 'x']), /not a listed directory/);
});

test('board add outside the list proposes in the directory the run started in, or refuses', async (context) => {
  const fx = fixture(context);
  const listed = fx.make('listed');
  const other = fx.make('other');
  const file = join(fx.root, 'p.md');
  writeFileSync(file, 'follow up');
  const argv = ['add', '--title', 'Fix', '--file', file];

  const fallback = enforced(fx, [listed], other, { AGENT_BOARD_START_DIR: listed });
  await fallback.go(argv);
  assert.deepEqual(fallback.workdirs, [listed]);

  const inside = enforced(fx, [listed], listed, { AGENT_BOARD_START_DIR: other });
  await inside.go(argv);
  assert.deepEqual(inside.workdirs, [listed], 'an allowed directory is used as it is');

  for (const startDir of [undefined, other, 'relative/path', join(fx.root, 'nowhere')]) {
    const refused = enforced(fx, [listed], other, startDir === undefined ? {} : { AGENT_BOARD_START_DIR: startDir });
    await assert.rejects(refused.go(argv), /not a listed directory/);
    assert.deepEqual(refused.workdirs, []);
  }

  const unlimited = enforced(fx, undefined, other, { AGENT_BOARD_START_DIR: listed });
  await unlimited.go(argv);
  assert.deepEqual(unlimited.workdirs, [other]);
});
