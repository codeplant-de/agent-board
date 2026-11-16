import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../examples/github-reviews.sh', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;
const skip = hasJq ? false : 'jq is not installed';

const REPO = 'acme/app';
const url = (n: number, repo = REPO): string => `https://github.com/${repo}/pull/${n}`;
const TAB = '\t';

interface FakePr {
  n: number;
  sha?: string | null;
  minutesAgo?: number;
  title?: string;
  author?: string | null;
}

// A page of the search answer, as `gh api graphql` prints it.
function searchAnswer(prs: FakePr[]): string {
  const nodes = prs.map(({ n, sha = `abc${n}0`, minutesAgo = 30, title = `PR ${n}`, author = 'alice' }) => ({
    url: url(n),
    number: n,
    headRefOid: sha,
    title,
    author: author === null ? null : { login: author },
    commits: {
      nodes: [
        { commit: { committedDate: new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d+Z$/, 'Z') } },
      ],
    },
  }));
  return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
}

// A `gh` that answers the search from a file, running the script's own --jq with the real jq, and a `board` that records every
// call and answers like the real one for schedule, tasks and move.
function fixture(context: TestContext, prs: FakePr[]) {
  const root = mkdtempSync(join(tmpdir(), 'board-reviews-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const tmp = join(root, 'tmp');
  const stateHome = join(root, 'state-home');
  mkdirSync(bin);
  mkdirSync(tmp);
  const answer = join(root, 'answer.json');
  const calls = join(root, 'calls.log');
  writeFileSync(answer, searchAnswer(prs));
  writeFileSync(join(root, 'todo.json'), '[]');
  writeFileSync(calls, '');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
if [ -e "$FAKE/gh-fails" ]; then echo "HTTP 502: bad gateway" >&2; exit 1; fi
jq=
while [ "$#" -gt 0 ]; do if [ "$1" = --jq ]; then jq=$2; fi; shift; done
exec jq -r "$jq" "$FAKE/answer.json"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'board'),
    `#!/bin/sh
cmd=$1
{ printf '%s' "$1"; shift; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$FAKE/calls.log"
case $cmd in
  schedule)
    pwd >> "$FAKE/cwds.log"
    [ -e "$FAKE/schedule-fails" ] && { echo "board: the board cannot be reached" >&2; exit 1; }
    key=; for a in "$@"; do [ "$prev" = --key ] && key=$a; prev=$a; done
    echo "{ \\"id\\": \\"T\${key##*/}\\", \\"url\\": \\"https://board.test/t/T\${key##*/}\\", \\"result\\": \\"created\\", \\"status\\": \\"todo\\" }"
    ;;
  tasks)
    [ -e "$FAKE/tasks-fails" ] && { echo "board: the board cannot be reached" >&2; exit 1; }
    cat "$FAKE/todo.json"
    ;;
  move)
    [ -e "$FAKE/move-hangs" ] && { : > "$FAKE/move-started"; sleep 30; }
    [ -e "$FAKE/move-moved-on" ] && { echo "board: not in todo any more" >&2; exit 3; }
    [ -e "$FAKE/move-fails" ] && { echo "board: no" >&2; exit 1; }
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  const stateFile = join(stateHome, 'agent-board', 'github-reviews.tsv');
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    TMPDIR: tmp,
    XDG_STATE_HOME: stateHome,
    FAKE: root,
  };
  return {
    root,
    tmp,
    env,
    stateFile,
    setState(lines: string[]) {
      mkdirSync(join(stateHome, 'agent-board'), { recursive: true });
      writeFileSync(stateFile, lines.map((line) => `${line}\n`).join(''));
    },
    state: () =>
      existsSync(stateFile) ? readFileSync(stateFile, 'utf8').split('\n').filter(Boolean).sort() : undefined,
    checkout,
    // The Todo listing; an id given as [id, 'resume'] is a task that was answered or paused.
    setTodo(ids: (string | [string, string])[]) {
      const listing = ids.map((entry) => {
        const [id, next] = typeof entry === 'string' ? [entry, 'fresh'] : entry;
        return { id, title: `"id": "decoy" ${id}`, status: 'todo', next, notBefore: null };
      });
      writeFileSync(join(root, 'todo.json'), JSON.stringify(listing, null, 2));
    },
    cwds: () =>
      existsSync(join(root, 'cwds.log'))
        ? readFileSync(join(root, 'cwds.log'), 'utf8').split('\n').filter(Boolean)
        : [],
    flag: (name: string) => writeFileSync(join(root, name), ''),
    // Every call of `board`, as its words.
    calls: () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(TAB)),
    run(args: string[] = [`${REPO}=${checkout}`], extra: Record<string, string> = {}) {
      const result = spawnSync('/bin/sh', [script, ...args], {
        env: { ...env, ...extra },
        encoding: 'utf8',
        cwd: root,
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    },
  };
}

const schedules = (fx: ReturnType<typeof fixture>) => fx.calls().filter(([command]) => command === 'schedule');

test(
  'a settled PR is scheduled with its URL as the key, its head as the version and a clean title',
  { skip },
  (context) => {
    const fx = fixture(context, [
      { n: 1, sha: 'abc123', title: 'Show postal code', author: 'alice' },
      { n: 2, title: 'Two\nlines\tand \u001b[31mescapes\\ here' },
      { n: 3, minutesAgo: 2 },
    ]);
    const result = fx.run();
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(schedules(fx), [
      [
        'schedule',
        '--agent',
        'reviewer',
        '--key',
        url(1),
        '--version',
        'abc123',
        '--title',
        '#1 Show postal code (alice)',
        '--json',
        '--',
        '/review-pr',
        url(1),
        '--auto',
      ],
      [
        'schedule',
        '--agent',
        'reviewer',
        '--key',
        url(2),
        '--version',
        'abc20',
        '--title',
        '#2 Two lines and [31mescapes here (alice)',
        '--json',
        '--',
        '/review-pr',
        url(2),
        '--auto',
      ],
    ]);
    assert.match(result.out, /skip #3: head not settled/);
    assert.match(result.out, /#1 created T1/);
    assert.deepEqual(fx.state(), [`${url(1)}${TAB}T1`, `${url(2)}${TAB}T2`]);
  },
);

test('BOARD_AGENT names the agent and KEY_PREFIX goes in front of the URL, for the key only', { skip }, (context) => {
  const fx = fixture(context, [{ n: 1 }]);
  assert.equal(fx.run(undefined, { BOARD_AGENT: 'looker', KEY_PREFIX: 'github-review:' }).code, 0);
  const [call] = schedules(fx);
  assert.equal(call?.[call.indexOf('--agent') + 1], 'looker');
  assert.equal(call?.[call.indexOf('--key') + 1], `github-review:${url(1)}`);
  assert.equal(call?.at(-2), url(1));
});

test('a PR the search lists but cannot be read is not scheduled, and its task is not closed', { skip }, (context) => {
  const fx = fixture(context, [{ n: 1, sha: null }]);
  fx.setState([`${url(1)}${TAB}T1`]);
  fx.setTodo(['T1']);
  assert.equal(fx.run().code, 0);
  assert.deepEqual(schedules(fx), []);
  assert.ok(!fx.calls().some(([command]) => command === 'move'));
  assert.deepEqual(fx.state(), [`${url(1)}${TAB}T1`]);
});

test('a Todo task whose PR no longer asks for the review is moved to Done, and its entry goes', { skip }, (context) => {
  const other = `https://github.com/else/where/pull/4`;
  const fx = fixture(context, [{ n: 1 }]);
  fx.setState([`${url(9)}${TAB}T9`, `${url(8)}${TAB}T8`, `${url(1)}${TAB}T1old`, `${other}${TAB}T4`]);
  fx.setTodo(['T9', 'T1old', 'T4']);
  const result = fx.run();
  assert.equal(result.code, 0, result.err + result.out);
  assert.deepEqual(
    fx.calls().filter(([command]) => command === 'move'),
    [['move', 'T9', 'done', '--expect', 'todo']],
    'only the Todo task of an unlisted PR of the given repository',
  );
  assert.match(result.out, /done T9/);
  assert.deepEqual(fx.state(), [`${url(1)}${TAB}T1`, `${other}${TAB}T4`].sort());
});

test('a search that failed schedules and closes nothing, and keeps the state', { skip }, (context) => {
  const fx = fixture(context, [{ n: 1 }]);
  fx.setState([`${url(9)}${TAB}T9`]);
  fx.setTodo(['T9']);
  fx.flag('gh-fails');
  const result = fx.run();
  assert.equal(result.code, 1);
  assert.match(result.out, /the search failed, nothing scheduled or closed: HTTP 502/);
  assert.deepEqual(fx.calls(), []);
  assert.deepEqual(fx.state(), [`${url(9)}${TAB}T9`]);
});

test('without the list of Todo tasks nothing is closed, and the exit code says so', { skip }, (context) => {
  const fx = fixture(context, [{ n: 1 }]);
  fx.setState([`${url(9)}${TAB}T9`]);
  fx.setTodo(['T9']);
  fx.flag('tasks-fails');
  assert.equal(fx.run().code, 1);
  assert.ok(!fx.calls().some(([command]) => command === 'move'));
  assert.deepEqual(fx.state(), [`${url(1)}${TAB}T1`, `${url(9)}${TAB}T9`]);
});

test('a PR whose schedule failed keeps the task id it had, and the exit code is 1', { skip }, (context) => {
  const fx = fixture(context, [{ n: 1 }]);
  fx.setState([`${url(1)}${TAB}Tkept`]);
  fx.flag('schedule-fails');
  const result = fx.run();
  assert.equal(result.code, 1);
  assert.match(result.out, /#1 failed: board: the board cannot be reached/);
  assert.deepEqual(fx.state(), [`${url(1)}${TAB}Tkept`]);
});

test('a move that fails keeps the entry for the next run', { skip }, (context) => {
  const fx = fixture(context, []);
  fx.setState([`${url(9)}${TAB}T9`]);
  fx.setTodo(['T9']);
  fx.flag('move-fails');
  assert.equal(fx.run().code, 1);
  assert.deepEqual(fx.state(), [`${url(9)}${TAB}T9`]);
});

test(
  'a signal during the closing ends the script at once, closes nothing more and leaves no temporary files',
  { skip },
  async (context) => {
    const fx = fixture(context, []);
    fx.setState([`${url(7)}${TAB}T7`, `${url(8)}${TAB}T8`, `${url(9)}${TAB}T9`]);
    fx.setTodo(['T7', 'T8', 'T9']);
    fx.flag('move-hangs');
    const child = spawn('/bin/sh', [script, `${REPO}=${fx.checkout}`], {
      env: fx.env,
      cwd: fx.root,
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const started = join(fx.root, 'move-started');
    for (let waited = 0; !existsSync(started); waited += 20) {
      assert.ok(waited < 10_000, 'the script never reached the first move');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The whole group, as a terminal's Ctrl+C or systemd's stop does.
    process.kill(-(child.pid ?? 0), 'SIGTERM');
    assert.equal(await exited, 1);
    assert.deepEqual(
      fx.calls().filter(([command]) => command === 'move'),
      [['move', 'T7', 'done', '--expect', 'todo']],
    );
    assert.deepEqual(readdirSync(fx.tmp), [], 'the work directory is removed');
    assert.deepEqual(fx.state(), [`${url(7)}${TAB}T7`, `${url(8)}${TAB}T8`, `${url(9)}${TAB}T9`]);
    assert.ok(!existsSync(`${fx.stateFile}.new.${child.pid}`));
  },
);

test(
  'it refuses no repository, one without a directory, a malformed one, and a missing tool, before it asks anything',
  { skip },
  (context) => {
    const fx = fixture(context, [{ n: 1 }]);
    for (const args of [
      [],
      [REPO],
      [`${REPO}=`],
      [`${REPO}=${fx.root}/missing`],
      [`acme=${fx.checkout}`],
      [`acme/app/extra=${fx.checkout}`],
      [`acme/app; rm -rf /=${fx.checkout}`],
      [`/app=${fx.checkout}`],
      [`acme/=${fx.checkout}`],
    ]) {
      const result = fx.run(args);
      assert.equal(result.code, 2, args.join(' '));
      assert.deepEqual(fx.calls(), []);
    }
    const noBoard = spawnSync('/bin/sh', [script, `${REPO}=${fx.checkout}`], {
      env: { ...fx.env, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    assert.equal(noBoard.status, 2);
  },
);

test('each PR is scheduled from the directory of its own repository, and ~ is expanded', { skip }, (context) => {
  const fx = fixture(context, [{ n: 1 }]);
  const other = join(fx.root, 'other');
  mkdirSync(join(other, 'sub'), { recursive: true });
  const both = [`${REPO}=~/checkout`, `acme/other=~/other/sub`];
  const result = fx.run(both);
  assert.equal(result.code, 0, result.err + result.out);
  assert.deepEqual(fx.cwds(), [fx.checkout]);
  writeFileSync(
    join(fx.root, 'answer.json'),
    searchAnswer([{ n: 1 }]).replace('"url":"' + url(1) + '"', '"url":"' + url(2, 'acme/other') + '"'),
  );
  assert.equal(fx.run(both).code, 0);
  assert.deepEqual(fx.cwds(), [fx.checkout, join(other, 'sub')]);
});

test('a Todo task that is a resume, or that left Todo before the move, is not closed', { skip }, (context) => {
  const fx = fixture(context, []);
  fx.setState([`${url(7)}${TAB}T7`, `${url(8)}${TAB}T8`, `${url(9)}${TAB}T9`]);
  fx.setTodo([['T7', 'resume'], 'T8', 'T9']);
  fx.flag('move-moved-on');
  const result = fx.run();
  assert.equal(result.code, 0, result.err + result.out);
  assert.deepEqual(
    fx.calls().filter(([command]) => command === 'move'),
    [
      ['move', 'T8', 'done', '--expect', 'todo'],
      ['move', 'T9', 'done', '--expect', 'todo'],
    ],
  );
  assert.match(result.out, /skip T8: it left Todo since the listing/);
  assert.deepEqual(fx.state(), []);
});
