import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const SCRIPT = new URL('../examples/intakes/github-reviews.sh', import.meta.url).pathname;
const hasJq = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const url = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`;

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

const node = (
  number: number,
  overrides: Record<string, unknown> = {},
  committedAt: string | null = minutesAgo(60),
) => ({
  url: url('acme/app', number),
  title: `Title ${number}`,
  number,
  headRefOid: `sha${number}`,
  author: { login: `author${number}` },
  commits: { nodes: committedAt === null ? [] : [{ commit: { committedDate: committedAt } }] },
  ...overrides,
});

interface Setup {
  dir: string;
  run: (args: string[], env?: Record<string, string>) => { code: number | null; calls: string[]; stderr: string };
}

// A `gh` that evaluates the --jq filter with the real jq on a fixture, and a `board` that records its calls.
function setup(search: unknown[], tasks: string[], options: { ghFails?: boolean; moveCode?: number } = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'board-script-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ data: { search: { nodes: search } } }));
  writeFileSync(join(dir, 'tasks.tsv'), tasks.map((line) => `${line}\n`).join(''));
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
printf 'gh' >> '${log}'; printf ' <%s>' "$@" >> '${log}'; echo >> '${log}'
${options.ghFails ? 'exit 1' : ''}
filter=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --jq ]; then filter=$2; fi
  shift
done
jq -r "$filter" '${join(dir, 'fixture.json')}'
`,
  );
  writeFileSync(
    join(bin, 'board'),
    `#!/bin/sh
printf 'board' >> '${log}'; printf ' <%s>' "$@" >> '${log}'; echo >> '${log}'
case "$1" in
  tasks)
    cat '${join(dir, 'tasks.tsv')}'
    if [ -n "\${STUB_SIGNAL:-}" ]; then kill -TERM "$PPID"; sleep 1; fi
    if [ -n "\${STUB_DROP_URLS:-}" ]; then rm -f "$TMPDIR"/tmp.*/urls "$TMPDIR"/*/urls; fi ;;
  move) exit ${options.moveCode ?? 0} ;;
esac
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'board'), 0o755);
  return {
    dir,
    run: (args, env = {}) => {
      const result = spawnSync('sh', [SCRIPT, ...args], {
        env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir, ...env },
        encoding: 'utf8',
      });
      const text = (() => {
        try {
          return readFileSync(log, 'utf8');
        } catch {
          return '';
        }
      })();
      return { code: result.status, calls: text.split('\n').filter((line) => line !== ''), stderr: result.stderr };
    },
  };
}

function requireJq(context: TestContext): boolean {
  if (hasJq) return true;
  if (process.env['CI']) assert.fail('jq is not installed, but CI must run the script checks');
  context.skip('jq is not installed; the script was not run');
  return false;
}

const creates = (calls: string[]): string[] => calls.filter((call) => call.startsWith('board <create>'));
const moves = (calls: string[]): string[] => calls.filter((call) => call.startsWith('board <move>'));

test('the script creates a task for each settled pull request, and skips a young head and an unreadable one', (context) => {
  if (!requireJq(context)) return;
  const search = [
    node(1, { title: 'Fix\tthe\nthing' }),
    node(2, {}, minutesAgo(2)),
    node(3, {}, null),
    node(4, { author: null }),
  ];
  const { dir, run } = setup(search, []);
  try {
    const { code, calls, stderr } = run(['acme/app']);
    assert.equal(code, 0, stderr);
    assert.deepEqual(creates(calls), [
      `board <create> <--source> <github-reviews> <--skill> <review-pr> <--key> <${url('acme/app', 1)}> <--version> <sha1> <--title> <#1 Fix the thing (author1)> <--> <${url('acme/app', 1)}> <--auto>`,
      `board <create> <--source> <github-reviews> <--skill> <review-pr> <--key> <${url('acme/app', 4)}> <--version> <sha4> <--title> <#4 Title 4 (ghost)> <--> <${url('acme/app', 4)}> <--auto>`,
    ]);
    assert.match(calls.join('\n'), /<q=is:pr is:open draft:false review-requested:@me repo:acme\/app>/);
    assert.deepEqual(moves(calls), []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the script moves the Todo tasks of listed repositories whose pull request is no longer listed, and only those', (context) => {
  if (!requireJq(context)) return;
  const search = [node(1), node(2, {}, minutesAgo(2)), node(3, {}, null)];
  const tasks = [
    ...[1, 2, 3, 9].map((number) => `T${number}\tgithub-reviews\t${url('acme/app', number)}\ttitle`),
    `Other\tgithub-reviews\t${url('other/repo', 5)}\ttitle`,
    'Plain\tgithub-reviews\tSC-123\ttitle',
  ];
  const { dir, run } = setup(search, tasks);
  try {
    const { code, calls, stderr } = run(['acme/app']);
    assert.equal(code, 0, stderr);
    assert.ok(calls.includes('board <tasks> <--source> <github-reviews> <--status> <todo>'));
    assert.deepEqual(moves(calls), ['board <move> <T9> <done> <--expect> <todo> <--clear-version>']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a failed listing creates nothing, prunes nothing and fails; board is not called', (context) => {
  if (!requireJq(context)) return;
  const { dir, run } = setup([node(1)], [`T9\tgithub-reviews\t${url('acme/app', 9)}\ttitle`], { ghFails: true });
  try {
    const { code, calls, stderr } = run(['acme/app']);
    assert.equal(code, 1);
    assert.match(stderr, /could not list the pull requests/);
    assert.deepEqual(
      calls.filter((call) => call.startsWith('board')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a move that finds the task changed (exit 3) is fine; any other failure fails the run', (context) => {
  if (!requireJq(context)) return;
  const tasks = [`T9\tgithub-reviews\t${url('acme/app', 9)}\ttitle`];
  for (const [moveCode, expected] of [
    [3, 0],
    [1, 1],
  ] as const) {
    const { dir, run } = setup([], tasks, { moveCode });
    try {
      assert.equal(run(['acme/app']).code, expected, `move exits ${moveCode}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test('BOARD_RAW_KEY=1 adds --raw-key to every create; a wrong repository name is refused before anything runs', (context) => {
  if (!requireJq(context)) return;
  const { dir, run } = setup([node(1)], []);
  try {
    const { calls } = run(['acme/app'], { BOARD_RAW_KEY: '1' });
    assert.match(creates(calls)[0]!, /<--source> <github-reviews> <--raw-key> <--skill>/);
    for (const bad of ['acme', 'a/b/c', '-x/y', 'a b/c', '']) {
      const refused = run([bad]);
      assert.equal(refused.code, 2, bad);
    }
    assert.equal(run([]).code, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a signal during the prune, or a lost listing file, ends the run without another move', (context) => {
  if (!requireJq(context)) return;
  const tasks = [1, 2, 3].map((number) => `T${number}\tgithub-reviews\t${url('acme/app', number + 8)}\ttitle`);
  for (const env of [{ STUB_SIGNAL: '1' }, { STUB_DROP_URLS: '1' }] as Record<string, string>[]) {
    const { dir, run } = setup([node(1)], tasks);
    try {
      const { code, calls } = run(['acme/app'], env);
      assert.notEqual(code, 0, JSON.stringify(env));
      assert.deepEqual(moves(calls), [], JSON.stringify(env));
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});
