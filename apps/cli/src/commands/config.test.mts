import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { BackendError } from '../backend/backend.mts';
import { UsageError } from '../cli.mts';
import type { LinkingContext } from '../cli.mts';
import { runBoard } from './program.mts';
import type { ProgramOptions } from './program-shared.mts';
import { CONFIG, fakeBackend, linkTo } from '../__tests__/helpers/fakes.mts';

interface Fixture {
  root: string;
  configFile: string;
  text: () => string;
  json: () => Record<string, unknown>;
}

const BASE = {
  machine: 'here',
  lanes: { general: { skills: ['*'], slots: 3 }, reviews: { skills: ['/review'], slots: 2 } },
  repos: { 'acme/app.js': '/srv/app' },
  agents: { reviewer: { description: 'Reviews', tools: ['Read'] } },
};

function fixture(context: TestContext, config: Record<string, unknown> | string | null = BASE): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-config-test-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config'));
  const configFile = join(root, 'config', 'config.json');
  if (config !== null)
    writeFileSync(configFile, typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o640,
    });
  return {
    root,
    configFile,
    text: () => readFileSync(configFile, 'utf8'),
    json: () => JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>,
  };
}

interface Run {
  backend: ReturnType<typeof fakeBackend>;
  printed: string[];
  out: string[];
  go: (argv: string[], overrides?: ProgramOptions) => Promise<void>;
}

function runner(fx: Fixture, base: ProgramOptions = {}): Run {
  const backend = fakeBackend([]);
  const printed: string[] = [];
  const out: string[] = [];
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
      writeOut: (text) => out.push(text.trimEnd()),
      writeErr: (text) => printed.push(text.trimEnd()),
      ...base,
      ...overrides,
    });
  return { backend, printed, out, go };
}

const said = (run: Run): string => run.printed.join('\n');
const dirsWrites = (run: Run): string[] => run.backend.writes.filter((write) => write.startsWith('dirs '));

test('show prints the path, the settings with their defaults marked, lanes, repos, agents and dirs', async (context) => {
  const fx = fixture(context, { ...BASE, autoUpdate: 'never', pauseAfterMinutes: 9 });
  const run = runner(fx);
  await run.go(['config']);
  const lines = run.printed;
  assert.equal(lines[0], fx.configFile);
  assert.ok(lines.includes('machine            here'));
  assert.ok(lines.includes('pauseAfterMinutes  9'));
  assert.ok(lines.includes('autoUpdate         never'));
  assert.ok(lines.some((line) => /^inactivityMinutes {2}15 {2}\(default\)$/.test(line)));
  assert.ok(lines.some((line) => /^defaultCwd .*\(default\)$/.test(line)));
  assert.ok(lines.some((line) => /^ {2}reviews {2}skills \/?review {2}slots 2$/.test(line)));
  assert.ok(lines.includes('  acme/app.js  /srv/app'));
  assert.ok(lines.includes('  reviewer'));
  assert.ok(lines.some((line) => line.startsWith('dirs') && line.includes('not set')));
  assert.ok(!lines.some((line) => line.startsWith('warning')));
  const explicit = runner(fx);
  await explicit.go(['config', 'show']);
  assert.deepEqual(explicit.printed, lines);
});

test('show lists a broken agent with its error, the dirs list and the warnings of the file', async (context) => {
  const fx = fixture(context, {
    ...BASE,
    agents: { reviewer: { description: 'Reviews', tools: ['Read'] }, broken: { description: 'x', tool: ['Read'] } },
    dirs: { '/srv/a': {}, '/srv/b': {} },
    inactivityMinuts: 3,
  });
  const run = runner(fx);
  await run.go(['config']);
  assert.ok(run.printed.some((line) => line.startsWith('  broken  broken: config: agents.broken has no key "tool"')));
  assert.ok(run.printed.some((line) => line.startsWith('dirs') && line.includes('2 listed, enforced')));
  assert.ok(run.printed.some((line) => line.startsWith('warning: unknown key "inactivityMinuts"')));
});

test('show --json prints the file as parsed; path prints the path alone', async (context) => {
  const fx = fixture(context);
  const run = runner(fx);
  await run.go(['config', 'show', '--json']);
  assert.deepEqual(JSON.parse(run.out.join('\n')), BASE);
  assert.deepEqual(run.printed, []);
  const other = runner(fx);
  await other.go(['config', 'path']);
  assert.deepEqual(other.printed, [fx.configFile]);
  await assert.rejects(other.go(['config', 'path', '--json']), /--json belongs to show/);
});

test('a missing config file is named for show, get and set, with the pointer to board init', async (context) => {
  const fx = fixture(context, null);
  const run = runner(fx);
  for (const argv of [['config'], ['config', 'get', 'machine'], ['config', 'set', 'maxRunHours', '3']])
    await assert.rejects(run.go(argv), /config file missing: .*config\.json \(run "board init"\)/);
});

test('get prints a string bare and anything else as JSON, and follows names that hold dots', async (context) => {
  const fx = fixture(context);
  const run = runner(fx);
  await run.go(['config', 'get', 'machine']);
  await run.go(['config', 'get', 'lanes.reviews.slots']);
  await run.go(['config', 'get', 'lanes.reviews']);
  await run.go(['config', 'get', 'agents.reviewer.tools']);
  await run.go(['config', 'get', 'repos.acme/app.js']);
  assert.deepEqual(run.printed, [
    'here',
    '2',
    JSON.stringify({ skills: ['/review'], slots: 2 }, null, 2),
    JSON.stringify(['Read'], null, 2),
    '/srv/app',
  ]);
});

test('get reads a dirs entry and its setting by path, and prints the default of a setting the file leaves out', async (context) => {
  const fx = fixture(context, { ...BASE, dirs: { '/srv/a.b': { label: 'Dotted' } } });
  const run = runner(fx);
  await run.go(['config', 'get', 'dirs./srv/a.b.label']);
  await run.go(['config', 'get', 'maxRunHours']);
  await run.go(['config', 'get', 'autoUpdate']);
  await run.go(['config', 'get', 'dirs']);
  assert.deepEqual(run.printed, [
    'Dotted',
    '6',
    'incompatible',
    JSON.stringify({ '/srv/a.b': { label: 'Dotted' } }, null, 2),
  ]);
  await assert.rejects(run.go(['config', 'get', 'lanes.nope.slots']), /lanes\.nope\.slots is not set in/);
  await assert.rejects(run.go(['config', 'get', 'intake']), UsageError);
});

test('set takes JSON or a string, creates the objects on the way and keeps the key order', async (context) => {
  const fx = fixture(context);
  const run = runner(fx);
  await run.go(['config', 'set', 'pauseAfterMinutes', '10']);
  await run.go(['config', 'set', 'autoUpdate', 'never']);
  await run.go(['config', 'set', 'lanes.docs', '{"skills":["/docs"],"slots":1}']);
  await run.go(['config', 'set', 'agents.reviewer.tools', '["Read","Bash"]']);
  await run.go(['config', 'set', 'repos.acme/web.js', fx.root]);
  await run.go(['config', 'set', 'agents.writer', '{"description":"Writes","tools":["Write"]}']);
  const after = fx.json();
  assert.equal(after['pauseAfterMinutes'], 10);
  assert.equal(after['autoUpdate'], 'never');
  assert.deepEqual((after['lanes'] as Record<string, unknown>)['docs'], { skills: ['/docs'], slots: 1 });
  assert.deepEqual((after['agents'] as Record<string, Record<string, unknown>>)['reviewer']?.['tools'], [
    'Read',
    'Bash',
  ]);
  assert.equal((after['repos'] as Record<string, unknown>)['acme/web.js'], fx.root);
  assert.deepEqual(Object.keys(after), ['machine', 'lanes', 'repos', 'agents', 'pauseAfterMinutes', 'autoUpdate']);
  assert.ok(fx.text().includes('\n  "machine": "here"') && fx.text().endsWith('}\n'));
  assert.ok(said(run).includes('set pauseAfterMinutes to 10'));
  assert.ok(said(run).includes('takes effect at the next dispatch tick'));
  await run.go(['config', 'set', 'maxRunHours', '3']);
  await run.go(['config', 'set', 'lanes.docs.slots', '4']);
  assert.equal(fx.json()['maxRunHours'], 3);
  assert.equal(((fx.json()['lanes'] as Record<string, Record<string, unknown>>)['docs'] ?? {})['slots'], 4);
  assert.deepEqual(readdirSync(join(fx.root, 'config')), ['config.json']);
});

test('set creates a nested object under a key the file lacks', async (context) => {
  const fx = fixture(context, { machine: 'here' });
  await runner(fx).go(['config', 'set', 'lanes.reviews.skills', '["/review"]']);
  assert.deepEqual(fx.json()['lanes'], { general: { skills: ['*'], slots: 3 }, reviews: { skills: ['/review'] } });
});

test('set below lanes in a file without lanes writes the default lane out too, and says so', async (context) => {
  const fx = fixture(context, { machine: 'here' });
  const run = runner(fx);
  await run.go(['config', 'set', 'lanes.reviews', '{"skills":["/review"],"slots":2}']);
  assert.deepEqual(fx.json()['lanes'], {
    general: { skills: ['*'], slots: 3 },
    reviews: { skills: ['/review'], slots: 2 },
  });
  assert.ok(said(run).includes('the default lane general is written out too'));
  const again = runner(fx);
  await again.go(['config', 'set', 'lanes.docs', '{"skills":["/docs"]}']);
  assert.ok(!said(again).includes('written out'), 'the lanes are in the file now');
  const dry = fixture(context, { machine: 'here' });
  const dryRun = runner(dry);
  await dryRun.go(['--dry-run', 'config', 'set', 'lanes.reviews', '{"skills":["/review"]}']);
  assert.ok(!('lanes' in dry.json()));
});

test('get lanes without the key prints the default as the file spells it, and a defaulted key reads from dirs', async (context) => {
  const fx = fixture(context, { machine: 'here' });
  const run = runner(fx);
  await run.go(['config', 'get', 'lanes']);
  assert.deepEqual(JSON.parse(run.printed.join('\n')), { general: { skills: ['*'], slots: 3 } });
  const work = join(fx.root, 'work');
  mkdirSync(work);
  writeFileSync(fx.configFile, JSON.stringify({ machine: 'here', dirs: { [work]: { default: true } } }));
  const dirs = runner(fx);
  await dirs.go(['config', 'get', 'defaultCwd']);
  assert.deepEqual(dirs.printed, [work]);
});

test('a repo name that continues an existing one with a dot can be set, and read back', async (context) => {
  const fx = fixture(context, null);
  writeFileSync(fx.configFile, JSON.stringify({ machine: 'here', repos: { 'acme/app': fx.root } }));
  const run = runner(fx);
  await run.go(['config', 'set', 'repos.acme/app.js', fx.root]);
  assert.deepEqual(fx.json()['repos'], { 'acme/app': fx.root, 'acme/app.js': fx.root });
  const read = runner(fx);
  await read.go(['config', 'get', 'repos.acme/app.js']);
  assert.deepEqual(read.printed, [fx.root]);
});

test('set and unset refuse a route that was fine and now is not a directory or not listed, and name it', async (context) => {
  const fx = fixture(context, null);
  const listed = join(fx.root, 'listed');
  const other = join(fx.root, 'other');
  mkdirSync(listed);
  mkdirSync(other);
  writeFileSync(
    fx.configFile,
    JSON.stringify({
      machine: 'here',
      dirs: { [listed]: { default: true } },
      lanes: { general: { skills: ['*'], slots: 1 } },
    }),
  );
  const before = fx.text();
  const run = runner(fx);
  const refused = async (argv: string[], message: RegExp): Promise<void> => {
    await assert.rejects(run.go(['config', ...argv]), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, message);
      return true;
    });
    assert.equal(fx.text(), before);
  };
  await refused(
    ['set', 'lanes.general.cwd', join(fx.root, 'gone')],
    /lane general cwd .* is not an existing directory/,
  );
  await refused(
    ['set', 'lanes.general.cwd', other],
    /lane general cwd .* is in no listed directory: tasks routed there/,
  );
  await refused(['set', 'repos.acme/app', other], /repos acme\/app .* is in no listed directory/);
  await run.go(['config', 'set', 'lanes.general.cwd', listed]);
  assert.equal(((fx.json()['lanes'] as Record<string, Record<string, unknown>>)['general'] ?? {})['cwd'], listed);
  const plain = fixture(context);
  await assert.rejects(
    runner(plain).go(['config', 'set', 'defaultCwd', join(plain.root, 'gone')]),
    /defaultCwd .* is not an existing directory/,
  );
  await runner(plain).go(['config', 'set', 'maxRunHours', '2']);
  assert.equal(plain.json()['maxRunHours'], 2, 'a route that was broken already does not block other changes');
});

test('a changed dirs list that drops a directory warns that pinned work stops, and edit warns about a broken route', async (context) => {
  const fx = fixture(context, null);
  const a = join(fx.root, 'a');
  const b = join(fx.root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(fx.configFile, JSON.stringify({ machine: 'here', dirs: { [a]: { default: true }, [b]: {} } }));
  const run = runner(fx);
  await run.go(['config', 'set', 'dirs', JSON.stringify({ [a]: { default: true } })]);
  assert.ok(run.printed.some((line) => line.startsWith('warning: dirs no longer lists') && line.includes(b)));
  assert.ok(said(run).includes('"board dirs rm" checks'));
  const kept = runner(fx);
  await kept.go(['config', 'set', 'maxRunHours', '2']);
  assert.ok(!said(kept).includes('no longer lists'));
  const edit = editor(JSON.stringify({ machine: 'here', dirs: { [a]: {} }, repos: { 'x/y': join(fx.root, 'gone') } }));
  const edited = runner(fx);
  await edited.go(['config', 'edit'], withEditor(fx, { EDITOR: 'vi' }, { runEditor: edit.run }));
  assert.ok(edited.printed.some((line) => line.startsWith('warning: repos x/y') && line.includes('not an existing')));
  assert.equal((fx.json()['repos'] as Record<string, string>)['x/y'], join(fx.root, 'gone'));
});

test('a change of a limit says the dispatcher applies it to runs already going, and another key does not', async (context) => {
  const fx = fixture(context);
  const run = runner(fx);
  await run.go(['config', 'set', 'maxRunHours', '2']);
  assert.ok(
    said(run).includes(
      'the dispatcher applies the new maxRunHours (a run past it is stopped then) to runs that are already going from its next tick',
    ),
  );
  assert.ok(said(run).includes('keeps the other settings it started with'));
  const other = runner(fx);
  await other.go(['config', 'set', 'autoUpdate', 'never']);
  assert.ok(!said(other).includes('the dispatcher applies'));
});

test('set with the value already there says so and writes nothing', async (context) => {
  const fx = fixture(context);
  const before = fx.text();
  const run = runner(fx);
  await run.go(['config', 'set', 'machine', 'here']);
  await run.go(['config', 'set', 'lanes.reviews', '{"slots":2,"skills":["/review"]}']);
  assert.ok(run.printed.every((line) => line.includes('is already')));
  assert.equal(run.printed.length, 2);
  assert.equal(fx.text(), before);
});

test('set refuses a value the config would not load, an unknown key and a new broken agent, and writes nothing', async (context) => {
  const fx = fixture(context);
  const before = fx.text();
  const run = runner(fx);
  const refused = async (argv: string[], message: RegExp): Promise<void> => {
    await assert.rejects(run.go(['config', ...argv]), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, message);
      return true;
    });
    assert.equal(fx.text(), before);
  };
  await refused(
    ['set', 'pauseAfterMinutes', '0'],
    /pauseAfterMinutes cannot be 0: config: pauseAfterMinutes must be a positive integer/,
  );
  await refused(['set', 'autoUpdate', 'sometimes'], /autoUpdate must be one of/);
  await refused(
    ['set', 'pauseAfterMinuts', '3'],
    /unknown key "pauseAfterMinuts", ignored; did you mean "pauseAfterMinutes"\?/,
  );
  await refused(['set', 'lanes.reviews.slotz', '3'], /did you mean "lanes\.reviews\.slots"\?/);
  await refused(
    ['set', 'agents.reviewer.tool', '["Read"]'],
    /agents\.reviewer has no key "tool"; did you mean "tools"\?/,
  );
  await refused(['set', 'agents.writer', '{"description":"W"}'], /agents\.writer\.tools must be a non-empty list/);
  await refused(['set', 'machine', 'bad name'], /machine must be a name/);
  await refused(['set', 'lanes.reviews.skills.0', '"x"'], /is a list, not an object/);
  await refused(['set', 'lanes.reviews.slots.deep', '1'], /lanes\.reviews\.slots is a number, not an object/);
});

test('set refuses a key below dirs and points to board dirs; the whole dirs object can be set', async (context) => {
  const fx = fixture(context, { ...BASE, dirs: { '/srv/a': {} } });
  const before = fx.text();
  const run = runner(fx);
  await assert.rejects(run.go(['config', 'set', 'dirs./srv/a.label', 'A']), /board dirs/);
  await assert.rejects(run.go(['config', 'unset', 'dirs./srv/a']), /board dirs/);
  assert.equal(fx.text(), before);
  await run.go(['config', 'set', 'dirs', '{"/srv/a":{"label":"A"},"/srv/b":{}}']);
  assert.deepEqual(Object.keys(fx.json()['dirs'] as object), ['/srv/a', '/srv/b']);
});

test('unset removes a key so the default applies, and says so when it is not there', async (context) => {
  const fx = fixture(context, { ...BASE, maxRunHours: 2 });
  const run = runner(fx);
  await run.go(['config', 'unset', 'maxRunHours']);
  await run.go(['config', 'unset', 'maxRunHours']);
  await run.go(['config', 'unset', 'lanes.reviews']);
  await run.go(['config', 'unset', 'repos.acme/app.js']);
  assert.ok(!('maxRunHours' in fx.json()));
  assert.deepEqual(Object.keys(fx.json()['lanes'] as object), ['general']);
  assert.deepEqual(fx.json()['repos'], {});
  assert.ok(said(run).includes('maxRunHours is not set'));
  assert.ok(said(run).includes('unset maxRunHours; the default applies again'));
});

test('unset refuses what would leave a config that does not load, and writes nothing', async (context) => {
  const fx = fixture(context, { ...BASE, dirs: { '/srv/a': { lane: 'reviews' } } });
  const before = fx.text();
  const run = runner(fx);
  await assert.rejects(
    run.go(['config', 'unset', 'lanes.reviews']),
    /cannot be removed: config: dirs\["\/srv\/a"\]\.lane must name a lane/,
  );
  await assert.rejects(run.go(['config', 'unset', 'lanes.general.skills']), /skills must be a non-empty list/);
  assert.equal(fx.text(), before);
});

test('a change keeps the mode of the file, and a config that is a link is changed where it points', async (context) => {
  const fx = fixture(context);
  const run = runner(fx);
  await run.go(['config', 'set', 'maxRunHours', '2']);
  assert.equal(statSync(fx.configFile).mode & 0o777, 0o640);

  const linked = fixture(context, null);
  const target = join(linked.root, 'dotfiles.json');
  writeFileSync(target, `${JSON.stringify(BASE)}\n`, { mode: 0o600 });
  symlinkSync(target, linked.configFile);
  await runner(linked).go(['config', 'set', 'maxRunHours', '2']);
  assert.ok(statSync(linked.configFile, { throwIfNoEntry: false })?.isFile());
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).maxRunHours, 2);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(linked.root, 'config')), ['config.json']);
});

test('a dry run prints what would be written and writes nothing', async (context) => {
  const fx = fixture(context);
  const before = fx.text();
  const run = runner(fx);
  await run.go(['config', '--dry-run', 'set', 'maxRunHours', '2']);
  await run.go(['config', 'unset', '--dry-run', 'lanes.reviews']);
  assert.equal(fx.text(), before);
  assert.ok(run.printed.some((line) => line.startsWith('DRY set maxRunHours to 2 (in ')));
  assert.ok(run.printed.some((line) => line.startsWith('DRY unset lanes.reviews (in ')));
  assert.ok(!said(run).includes('takes effect'));
  await assert.rejects(
    run.go(['--dry-run', 'config', 'set', 'maxRunHours', '0']),
    /cannot be 0/,
    'a dry run is refused for the same reasons',
  );
});

test('set, unset and edit are refused inside a board run; show, get and path work', async (context) => {
  const fx = fixture(context);
  const before = fx.text();
  const run = runner(fx);
  const inRun = { env: { AGENT_BOARD_TASK: 'Zt0Test1', AGENT_BOARD_CONFIG_DIR: join(fx.root, 'config') } };
  await run.go(['config'], inRun);
  await run.go(['config', 'get', 'machine'], inRun);
  await run.go(['config', 'path'], inRun);
  for (const argv of [['set', 'maxRunHours', '2'], ['unset', 'maxRunHours'], ['edit']])
    await assert.rejects(run.go(['config', ...argv], inRun), /not available inside a board run/);
  assert.equal(fx.text(), before);
});

test('words and flags that do not belong are refused', async (context) => {
  const run = runner(fixture(context));
  await assert.rejects(run.go(['config', 'frob']), /config takes nothing, or show, get, set, unset, edit, path/);
  await assert.rejects(run.go(['config', 'get']), /takes a key/);
  await assert.rejects(run.go(['config', 'set', 'machine']), /takes a key and a value/);
  await assert.rejects(run.go(['config', 'path', 'x']), /takes nothing more/);
  await assert.rejects(run.go(['config', 'get', 'a..b']), /is not a key of config\.json/);
});

test('a change to dirs is sent to the board, one to another key is not, and a failure is a warning', async (context) => {
  const fx = fixture(context, { ...BASE, dirs: { '/srv/a': {} } });
  const run = runner(fx);
  await run.go(['config', 'set', 'maxRunHours', '2']);
  assert.deepEqual(dirsWrites(run), []);
  await run.go(['config', 'set', 'dirs', '{"/srv/a":{"label":"A"}}']);
  assert.deepEqual(dirsWrites(run), ['dirs here: '], 'a directory that is not there is not sent');
  const dir = join(fx.root, 'work');
  mkdirSync(dir);
  await run.go(['config', 'set', 'dirs', JSON.stringify({ [dir]: { label: 'Work' } })]);
  assert.deepEqual(dirsWrites(run), ['dirs here: ', `dirs here: ${dir}=Work`]);
  assert.ok(said(run).includes('the board has the list'));

  const failing = runner(fx);
  failing.backend.checkDirs = () => Promise.reject(new BackendError('offline', 0, true));
  await failing.go(['config', 'unset', 'dirs']);
  assert.ok(!('dirs' in fx.json()));
  assert.ok(said(failing).includes('the dirs list is gone'));
});

test('a change of machine warns what depends on the name', async (context) => {
  const fx = fixture(context);
  const run = runner(fx);
  await run.go(['config', 'set', 'machine', 'there']);
  assert.equal(fx.json()['machine'], 'there');
  const warning = run.printed.find((line) =>
    line.startsWith('warning: this machine\'s name changed from "here" to "there"'),
  );
  assert.ok(warning?.includes('by its token'));
  assert.ok(warning?.includes('will not resume here'));
  const other = runner(fx);
  await other.go(['config', 'set', 'maxRunHours', '2']);
  assert.ok(!said(other).includes('name changed'));
});

// An editor that replaces the content of the copy with `edited` (or leaves it when `edited` is undefined), and records its command line.
function editor(edited: string | undefined, status = 0): { run: (argv: string[]) => number; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (argv) => {
      calls.push(argv);
      if (edited !== undefined) writeFileSync(argv[argv.length - 1] ?? '', edited);
      return status;
    },
  };
}

const withEditor = (fx: Fixture, variables: Record<string, string>, extra: ProgramOptions): ProgramOptions => ({
  env: { AGENT_BOARD_CONFIG_DIR: join(fx.root, 'config'), ...variables },
  interactive: true,
  ...extra,
});

test('edit opens a copy in $VISUAL, then $EDITOR, and replaces the file with the valid result', async (context) => {
  const fx = fixture(context);
  const seen: string[] = [];
  const fake = editor(`${JSON.stringify({ ...BASE, maxRunHours: 2, zzz: 1 })}\n`);
  const run = runner(fx);
  await run.go(
    ['config', 'edit'],
    withEditor(
      fx,
      { VISUAL: 'code -w', EDITOR: 'vi' },
      {
        runEditor: (argv) => {
          seen.push(readFileSync(argv[argv.length - 1] ?? '', 'utf8'));
          return fake.run(argv);
        },
      },
    ),
  );
  assert.deepEqual(fake.calls[0]?.slice(0, 4), ['/bin/sh', '-c', 'code -w "$@"', 'editor']);
  assert.equal(fake.calls[0]?.length, 5);
  const copy = fake.calls[0]?.[4] ?? '';
  assert.equal(copy.startsWith(`${fx.configFile}.edit-`), true);
  assert.equal(seen[0]?.includes('"machine": "here"'), true, 'the copy starts as the file');
  assert.equal(fx.json()['maxRunHours'], 2);
  assert.equal(fx.text().startsWith('{"machine"'), true, 'the text is kept as the user wrote it');
  assert.equal(statSync(fx.configFile).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(join(fx.root, 'config')), ['config.json']);
  assert.ok(run.printed.some((line) => line.startsWith('warning: unknown key "zzz"')));
  assert.ok(said(run).includes(`edited ${fx.configFile}`));

  const second = editor(undefined);
  await run.go(['config', 'edit'], withEditor(fx, { EDITOR: 'nano' }, { runEditor: second.run }));
  assert.equal(second.calls[0]?.[2], 'nano "$@"');
});

test('edit runs the editor through the shell, so quotes and arguments in $EDITOR work', async (context) => {
  const fx = fixture(context);
  const folder = join(fx.root, 'with space');
  mkdirSync(folder);
  const script = join(folder, 'ed.sh');
  writeFileSync(script, '#!/bin/sh\nprintf "%s" "$1" > "$2.args"\nprintf \'{"machine":"here"}\' > "$3"\n', {
    mode: 0o755,
  });
  let copy = '';
  const real = (argv: string[]): number | undefined => {
    copy = argv[argv.length - 1] ?? '';
    return spawnSync(argv[0] ?? '', argv.slice(1)).status ?? undefined;
  };
  await runner(fx).go(
    ['config', 'edit'],
    withEditor(fx, { EDITOR: `"${script}" 'one two' ${join(fx.root, 'seen')}` }, { runEditor: real }),
  );
  assert.equal(readFileSync(join(fx.root, 'seen.args'), 'utf8'), 'one two');
  assert.ok(copy.startsWith(fx.configFile));
  assert.equal(fx.text(), '{"machine":"here"}');
});

test('edit with an invalid result keeps the file and the copy and names the copy', async (context) => {
  const fx = fixture(context);
  const before = fx.text();
  for (const edited of ['{ not json', '[]', JSON.stringify({ ...BASE, maxRunHours: 0 })]) {
    const fake = editor(edited);
    const run = runner(fx);
    let message = '';
    await run
      .go(['config', 'edit'], withEditor(fx, { EDITOR: 'vi' }, { runEditor: fake.run }))
      .catch((error: unknown) => {
        message = error instanceof Error ? error.message : '';
      });
    const copy = fake.calls[0]?.[4] ?? '';
    assert.ok(message.includes('is unchanged') && message.includes(copy), message);
    assert.equal(fx.text(), before);
    assert.equal(readFileSync(copy, 'utf8'), edited);
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    rmSync(copy);
  }
});

test('edit says unchanged and removes the copy, and does not run the editor without an editor variable or a terminal', async (context) => {
  const fx = fixture(context);
  const run = runner(fx);
  const same = editor(undefined);
  await run.go(['config', 'edit'], withEditor(fx, { EDITOR: 'vi' }, { runEditor: same.run }));
  assert.ok(said(run).includes('unchanged'));
  assert.deepEqual(readdirSync(join(fx.root, 'config')), ['config.json']);

  const never = editor('{}');
  await assert.rejects(
    run.go(['config', 'edit'], withEditor(fx, {}, { runEditor: never.run })),
    /no editor: set \$VISUAL or \$EDITOR/,
  );
  await assert.rejects(
    run.go(['config', 'edit'], withEditor(fx, { EDITOR: '  ' }, { runEditor: never.run })),
    /no editor/,
  );
  await assert.rejects(
    run.go(['config', 'edit'], withEditor(fx, { EDITOR: 'vi' }, { runEditor: never.run, interactive: false })),
    /needs a terminal/,
  );
  await assert.rejects(
    run.go(['--dry-run', 'config', 'edit'], withEditor(fx, { EDITOR: 'vi' }, { runEditor: never.run })),
    /--dry-run does not apply to edit/,
  );
  assert.deepEqual(never.calls, []);
});

test('edit that fails to start or ends with an error leaves the file and removes the copy', async (context) => {
  const fx = fixture(context);
  const before = fx.text();
  const run = runner(fx);
  await assert.rejects(
    run.go(['config', 'edit'], withEditor(fx, { EDITOR: 'nonesuch' }, { runEditor: () => undefined })),
    /could not start the editor "nonesuch"/,
  );
  await assert.rejects(
    run.go(['config', 'edit'], withEditor(fx, { EDITOR: 'vi' }, { runEditor: editor('{}', 1).run })),
    /ended with status 1/,
  );
  assert.equal(fx.text(), before);
  assert.deepEqual(readdirSync(join(fx.root, 'config')), ['config.json']);
});

test('edit repairs a file that is not valid JSON, and refuses to overwrite a change made meanwhile', async (context) => {
  const broken = fixture(context, '{ nope');
  await runner(broken).go(
    ['config', 'edit'],
    withEditor(broken, { EDITOR: 'vi' }, { runEditor: editor(`${JSON.stringify(BASE)}\n`).run }),
  );
  assert.deepEqual(broken.json(), BASE);

  const fx = fixture(context);
  const racing = (argv: string[]): number => {
    writeFileSync(fx.configFile, '{"machine":"other"}\n');
    writeFileSync(argv[argv.length - 1] ?? '', `${JSON.stringify(BASE)}\n`);
    return 0;
  };
  await assert.rejects(
    runner(fx).go(['config', 'edit'], withEditor(fx, { EDITOR: 'vi' }, { runEditor: racing })),
    /changed while the editor was open/,
  );
  assert.equal(fx.json()['machine'], 'other');
  assert.equal(readdirSync(join(fx.root, 'config')).length, 2, 'the copy with the edits is kept');
});
