import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ConfigError, loadConfig, parseConfig } from '../config/config.mts';
import { parseAgentDocument } from '../config/agent-document.mts';
import { parseAgentUrl, sha256Hex } from '../config/agent-fetch.mts';
import { agentsAdd, broadRule, grantSummary, looksSecret } from './agents.mts';
import type { AgentsDeps } from './agents.mts';
import { exampleText } from './example.mts';
import { runBoard } from './program.mts';
import type { ProgramOptions } from './program-shared.mts';

const SMALL = {
  name: 'small',
  description: 'A small agent',
  tools: ['Read', 'Bash'],
  allowedTools: ['Read', 'Bash(git status)'],
  disallowedTools: ['Read(~/.ssh/**)'],
};

const SMALL_YAML = `name: small
description: A small agent
tools: [Read, Bash]
allowedTools:
  - Read
  - Bash(git status)
disallowedTools:
  - Read(~/.ssh/**)
`;

interface Fixture {
  root: string;
  home: string;
  configDir: string;
  configFile: string;
  agentsDir: string;
  printed: string[];
  out: string[];
  go: (argv: string[], overrides?: ProgramOptions) => Promise<void>;
  deps: (overrides?: Partial<AgentsDeps>) => AgentsDeps;
}

function fixture(context: TestContext, config: Record<string, unknown> = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-agents-test-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  const configFile = join(configDir, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({ machine: 'here', ...config }, null, 2)}\n`, { mode: 0o640 });
  const printed: string[] = [];
  const out: string[] = [];
  const go = (argv: string[], overrides: ProgramOptions = {}) =>
    runBoard(argv, {
      env: { AGENT_BOARD_CONFIG_DIR: configDir },
      writeOut: (text) => out.push(text),
      writeErr: (text) => printed.push(text.trimEnd()),
      cwd: root,
      home,
      interactive: false,
      ...overrides,
    });
  const deps = (overrides: Partial<AgentsDeps> = {}): AgentsDeps => ({
    configFile,
    cwd: root,
    home,
    dryRun: false,
    print: (line) => printed.push(line),
    write: (text) => out.push(text),
    readStdin: () => Promise.resolve(''),
    confirm: undefined,
    ...overrides,
  });
  return { root, home, configDir, configFile, agentsDir: join(configDir, 'agents'), printed, out, go, deps };
}

const said = (fx: Fixture): string => [...fx.printed, ...fx.out].join('\n');

test('a definition parses from YAML and from JSON to the same agent; aliases and duplicate keys are refused', () => {
  const fromYaml = parseAgentDocument(SMALL_YAML, 'small.yaml');
  const fromJson = parseAgentDocument(JSON.stringify(SMALL), 'small.json');
  assert.deepEqual(fromYaml, SMALL);
  assert.deepEqual(fromJson, SMALL);
  assert.throws(
    () => parseAgentDocument('a: &x [1]\nb: *x\n', 'aliased.yaml'),
    (error) => error instanceof ConfigError && /aliased\.yaml is not valid YAML/.test(error.message),
  );
  assert.throws(() => parseAgentDocument('tools: [Read]\ntools: [Bash]\n', 'twice.yaml'), /not valid YAML/);
  assert.throws(() => parseAgentDocument('{ "tools": ', 'broken.json'), /broken\.json is not valid JSON/);
  assert.throws(() => parseAgentDocument(`x: "${'a'.repeat(300 * 1024)}"\n`, 'big.yaml'), /larger than 256 KB/);
});

test('add from a file writes agents/<name>.yaml, mode 600 in a 700 directory, and export then add round-trips it', async (context) => {
  const fx = fixture(context);
  writeFileSync(join(fx.root, 'small.yaml'), SMALL_YAML);
  await fx.go(['agents', 'add', 'small.yaml', '--yes']);
  const file = join(fx.agentsDir, 'small.yaml');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(fx.agentsDir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(fx.agentsDir), ['small.yaml'], 'no temp file is left');
  const config = loadConfig(fx.configFile);
  assert.deepEqual(config.agents['small'], {
    description: 'A small agent',
    tools: ['Read', 'Bash'],
    allowedTools: ['Read', 'Bash(git status)'],
    disallowedTools: ['Read(~/.ssh/**)'],
    env: [],
    mcpServers: [],
    source: join(fx.root, 'small.yaml'),
  });
  assert.deepEqual(config.agentFiles, { small: file });

  fx.out.length = 0;
  await fx.go(['agents', 'export', 'small']);
  const exported = fx.out.join('');
  assert.ok(!exported.includes('source'), 'export leaves out where this machine got it');
  writeFileSync(join(fx.root, 'exported.yaml'), exported);
  await fx.go(['agents', 'add', 'exported.yaml', '--name', 'copy', '--yes']);
  const again = loadConfig(fx.configFile);
  const { source: _a, ...first } = again.agents['small'] ?? {};
  const { source: _b, ...second } = again.agents['copy'] ?? {};
  assert.deepEqual(second, first);

  fx.out.length = 0;
  await fx.go(['agents', 'show', 'small', '--json']);
  assert.deepEqual(JSON.parse(fx.out.join('')), { ...SMALL, source: join(fx.root, 'small.yaml') });
});

test('add reads JSON on stdin, needs --yes there, and takes the name from --name', async (context) => {
  const fx = fixture(context);
  const json = JSON.stringify({ ...SMALL, name: undefined });
  await assert.rejects(
    fx.go(['agents', 'add', '-'], { readStdin: () => Promise.resolve(json) }),
    /has no name; give it one with --name/,
  );
  await assert.rejects(
    fx.go(['agents', 'add', '-', '--name', 'piped'], {
      readStdin: () => Promise.resolve(json),
      interactive: true,
      prompts: {
        text: () => Promise.reject(new Error('no')),
        secret: () => Promise.reject(new Error('no')),
        confirm: () => Promise.resolve(true),
      },
    }),
    /nothing was written: confirm at a terminal, or pass --yes/,
  );
  assert.ok(!existsSync(fx.agentsDir));
  await fx.go(['agents', 'add', '-', '--name', 'piped', '--yes'], { readStdin: () => Promise.resolve(json) });
  assert.equal(loadConfig(fx.configFile).agents['piped']?.source, 'stdin');
});

test('add asks at a terminal and writes nothing on no', async (context) => {
  const fx = fixture(context);
  writeFileSync(join(fx.root, 'small.yaml'), SMALL_YAML);
  const asked: string[] = [];
  await agentsAdd(fx.deps({ confirm: (question) => (asked.push(question), Promise.resolve(false)) }), 'small.yaml', {});
  assert.deepEqual(asked, ['Add agent small?']);
  assert.ok(!existsSync(join(fx.agentsDir, 'small.yaml')));
  assert.match(said(fx), /nothing was written/);
  await agentsAdd(fx.deps({ confirm: () => Promise.resolve(true) }), 'small.yaml', {});
  assert.ok(existsSync(join(fx.agentsDir, 'small.yaml')));
});

test('the summary before writing lists every tool, allow rule, deny rule, env name and MCP server, and flags the broad ones', async (context) => {
  const fx = fixture(context);
  const wide = {
    name: 'wide',
    description: 'Too much',
    tools: ['Bash', 'Read', 'Edit'],
    allowedTools: [
      'Bash(*)',
      'Bash(git log *)',
      'Bash(* --help)',
      'Bash(curl *)',
      'Bash(board *)',
      'Edit',
      'Read(~/**)',
    ],
    disallowedTools: [],
    env: ['GITHUB_TOKEN', 'REGION'],
    mcpServers: ['shortcut'],
  };
  writeFileSync(join(fx.root, 'wide.json'), JSON.stringify(wide));
  await fx.go(['agents', 'add', 'wide.json', '--dry-run']);
  const text = said(fx);
  for (const value of [...wide.tools, ...wide.allowedTools, ...wide.env, ...wide.mcpServers])
    assert.ok(text.includes(value), value);
  for (const flagged of ['Bash(*)', 'Bash(* --help)', 'Bash(curl *)', 'Bash(board *)', 'Edit', 'Read(~/**)'])
    assert.match(text, new RegExp(`! allow rule ${flagged.replace(/[()*~/]/g, '\\$&')}:`), flagged);
  assert.doesNotMatch(text, /! allow rule Bash\(git log \*\)/);
  assert.match(text, /! env GITHUB_TOKEN looks like a secret/);
  assert.doesNotMatch(text, /! env REGION/);
  assert.match(text, /the deny list is empty/);
  assert.match(text, /DRY write .*agents\/wide\.yaml/);
  assert.ok(!existsSync(fx.agentsDir), 'a dry run writes nothing');

  const summary = grantSummary(
    'reviewer',
    { ...wide, disallowedTools: ['Read(~/.ssh/**)', 'Bash(git push *)'] },
    fx.home,
  );
  for (const rule of ['Read(~/.ssh/**)', 'Bash(git push *)'])
    assert.ok(summary.lines.some((line) => line.includes(rule)));
  assert.ok(!summary.warnings.some((warning) => warning.includes('deny list is empty')));
});

test('broadRule and looksSecret', () => {
  for (const rule of [
    'Bash',
    'Bash(*)',
    'Bash(**)',
    'Bash(bash -c *)',
    'Bash(python3 *)',
    'Bash(* foo)',
    'Read',
    'WebFetch',
    'Read(//**)',
    'Edit(~/**)',
    'mcp__shortcut',
  ])
    assert.ok(broadRule(rule) !== undefined, rule);
  for (const rule of [
    'Grep',
    'Bash(git status)',
    'Bash(gh pr view *)',
    'Bash(board comment *)',
    'Edit(//tmp/pr-*)',
    'Read(~/.ssh/**)',
    'mcp__shortcut__get_story',
  ])
    assert.equal(broadRule(rule), undefined, rule);
  for (const name of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'API_KEY', 'DB_PASSWORD', 'SESSION_COOKIE'])
    assert.ok(looksSecret(name), name);
  for (const name of ['REGION', 'COSUNO_PROD_REPLICA_ENDPOINT', 'KEYBOARD_LAYOUT']) assert.ok(!looksSecret(name), name);
});

test('add refuses unknown keys, a bad name, a tool pattern, an existing name without --replace, and a name config.json defines', async (context) => {
  const fx = fixture(context, { agents: { inline: { description: 'x', tools: ['Read'] } } });
  const write = (file: string, value: unknown) => writeFileSync(join(fx.root, file), JSON.stringify(value));
  write('typo.json', { ...SMALL, disallowedTool: ['Bash'] });
  await assert.rejects(
    fx.go(['agents', 'add', 'typo.json', '--yes']),
    /has no key "disallowedTool"; did you mean "disallowedTools"\?/,
  );
  write('pattern.json', { ...SMALL, tools: ['Bash(git status)'] });
  await assert.rejects(fx.go(['agents', 'add', 'pattern.json', '--yes']), /which is not a tool name/);
  write('badname.json', { ...SMALL, name: 'Bad Name' });
  await assert.rejects(fx.go(['agents', 'add', 'badname.json', '--yes']), /name must be lowercase/);
  assert.ok(!existsSync(fx.agentsDir));

  write('small.json', SMALL);
  await fx.go(['agents', 'add', 'small.json', '--yes']);
  await assert.rejects(
    fx.go(['agents', 'add', 'small.json', '--yes']),
    /agent small exists \(agents\/small\.yaml\); --replace overwrites it/,
  );
  write('small.json', { ...SMALL, description: 'Changed' });
  await fx.go(['agents', 'add', 'small.json', '--yes', '--replace']);
  assert.equal(loadConfig(fx.configFile).agents['small']?.description, 'Changed');

  await assert.rejects(
    fx.go(['agents', 'add', 'small.json', '--name', 'inline', '--yes', '--replace']),
    /agent inline is defined in config\.json/,
  );
});

test('add and rm are refused inside a run, under AGENT_BOARD_TASK or AGENT_BOARD_RESTRICTED; list and show are not', async (context) => {
  const fx = fixture(context);
  writeFileSync(join(fx.root, 'small.yaml'), SMALL_YAML);
  for (const env of [{ AGENT_BOARD_TASK: 'abc' }, { AGENT_BOARD_RESTRICTED: '1' }]) {
    const inRun = { env: { AGENT_BOARD_CONFIG_DIR: fx.configDir, ...env } };
    await assert.rejects(fx.go(['agents', 'add', 'small.yaml', '--yes'], inRun), /not available inside a board run/);
    await assert.rejects(fx.go(['agents', 'rm', 'small'], inRun), /not available inside a board run/);
    await fx.go(['agents'], inRun);
  }
  assert.ok(!existsSync(fx.agentsDir));
});

test('add refuses http and other schemes, a URL with credentials, and a malformed pin', async (context) => {
  const fx = fixture(context);
  await assert.rejects(
    fx.go(['agents', 'add', 'http://example.com/a.yaml', '--yes']),
    /only https:\/\/ URLs are fetched, not http/,
  );
  await assert.rejects(fx.go(['agents', 'add', 'ftp://example.com/a.yaml', '--yes']), /only https/);
  assert.throws(() => parseAgentUrl('https://u:p@example.com/a.yaml'), /user name or password/);
  assert.throws(() => parseAgentUrl('https://example.com/a.yaml#sha256=abc'), /64 hex digits/);
  assert.equal(parseAgentUrl(`https://example.com/a.yaml#sha256=${'A'.repeat(64)}`).sha256, 'a'.repeat(64));
});

// A local https server with a certificate made for the test; the fetch trusts it through `ca`.
function httpsStub(
  context: TestContext,
  root: string,
  handler: (path: string) => { status: number; body?: string; location?: string },
): Promise<{ base: string; ca: string }> | undefined {
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(root, 'key.pem'),
        '-out',
        join(root, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
  } catch {
    return undefined;
  }
  const cert = readFileSync(join(root, 'cert.pem'), 'utf8');
  const server: Server = createServer({ key: readFileSync(join(root, 'key.pem')), cert }, (req, res) => {
    const answer = handler(req.url ?? '/');
    res.writeHead(answer.status, answer.location === undefined ? {} : { location: answer.location });
    res.end(answer.body ?? '');
  });
  context.after(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, ca: cert }),
    ),
  );
}

test('add fetches an https URL: records it as the source, checks a pin, caps the size, and follows only same-host https redirects', async (context) => {
  const fx = fixture(context);
  const big = `description: x\ntools: [Read]\nprompt: "${'a'.repeat(300 * 1024)}"\n`;
  const stub = httpsStub(context, fx.root, (path) => {
    if (path === '/small.yaml') return { status: 200, body: SMALL_YAML };
    if (path === '/moved.yaml') return { status: 302, location: '/small.yaml' };
    if (path === '/away.yaml') return { status: 302, location: 'https://example.com/small.yaml' };
    if (path === '/plain.yaml') return { status: 302, location: 'http://127.0.0.1/small.yaml' };
    if (path === '/big.yaml') return { status: 200, body: big };
    return { status: 404 };
  });
  if (stub === undefined) return context.skip('openssl is not installed');
  const { base, ca } = await stub;
  const deps = fx.deps({ fetch: { ca } });

  const pin = sha256Hex(Buffer.from(SMALL_YAML));
  await agentsAdd(deps, `${base}/small.yaml#sha256=${pin}`, { yes: true });
  assert.equal(loadConfig(fx.configFile).agents['small']?.source, `${base}/small.yaml#sha256=${pin}`);

  await assert.rejects(
    agentsAdd(deps, `${base}/small.yaml#sha256=${'0'.repeat(64)}`, { yes: true, name: 'other' }),
    /has sha256 [0-9a-f]{64}, not the 0{64} the URL pins; nothing was written/,
  );
  await agentsAdd(deps, `${base}/moved.yaml`, { yes: true, name: 'moved' });
  assert.ok(loadConfig(fx.configFile).agents['moved']);
  await assert.rejects(
    agentsAdd(deps, `${base}/away.yaml`, { yes: true, name: 'away' }),
    /redirects to https:\/\/example\.com/,
  );
  await assert.rejects(
    agentsAdd(deps, `${base}/plain.yaml`, { yes: true, name: 'plain' }),
    /redirects to http:\/\/127\.0\.0\.1/,
  );
  await assert.rejects(agentsAdd(deps, `${base}/big.yaml`, { yes: true, name: 'big' }), /more than 262144 bytes/);
  await assert.rejects(agentsAdd(deps, `${base}/gone.yaml`, { yes: true, name: 'gone' }), /answers 404/);
  assert.deepEqual(readdirSync(fx.agentsDir).sort(), ['moved.yaml', 'small.yaml']);
});

test('example:reviewer adds the shipped reviewer, the same agent config.reviews.json defines', async (context) => {
  const fx = fixture(context);
  await fx.go(['agents', 'add', 'example:reviewer', '--yes']);
  const added = loadConfig(fx.configFile).agents['reviewer'];
  const inline = parseConfig(JSON.parse(exampleText('config.reviews.json') ?? '')).agents['reviewer'];
  assert.deepEqual(added, { ...inline, version: '1', source: 'example:reviewer' });
  assert.ok(added?.disallowedTools.includes('Bash(board agents *)'));
  await assert.rejects(
    fx.go(['agents', 'add', 'example:nope', '--yes']),
    /no example agent "nope"; there are example:reviewer/,
  );
});

test('rm removes an agents/ file, or the config.json entry with the rest of the file and its mode kept', async (context) => {
  const fx = fixture(context, {
    autoUpdate: 'never',
    agents: { inline: { description: 'x', tools: ['Read'] } },
    zzz: [1],
  });
  writeFileSync(join(fx.root, 'small.yaml'), SMALL_YAML);
  await fx.go(['agents', 'add', 'small.yaml', '--yes']);
  await fx.go(['agents', 'rm', 'small']);
  assert.deepEqual(readdirSync(fx.agentsDir), []);
  const before = JSON.parse(readFileSync(fx.configFile, 'utf8')) as Record<string, unknown>;
  await fx.go(['agents', 'rm', 'inline']);
  const after = JSON.parse(readFileSync(fx.configFile, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(after['agents'], {});
  assert.deepEqual(after['zzz'], [1]);
  assert.equal(statSync(fx.configFile).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(fx.configDir).sort(), ['agents', 'config.json']);
  await assert.rejects(fx.go(['agents', 'rm', 'inline']), /no agent "inline" here/);
});

test('the agents directory is read strictly: a bad file, a name clash with config.json, a writable file and two files for one name are unusable', (context) => {
  const fx = fixture(context, { agents: { both: { description: 'x', tools: ['Read'] } } });
  mkdirSync(fx.agentsDir);
  const put = (file: string, text: string, mode = 0o600) => {
    writeFileSync(join(fx.agentsDir, file), text);
    chmodSync(join(fx.agentsDir, file), mode);
  };
  put('good.yaml', 'description: fine\ntools: [Read]\n');
  put('typo.yaml', 'description: x\ntools: [Read]\ndisallowedTool: [Bash]\n');
  put('both.yaml', 'description: x\ntools: [Read]\n');
  put('open.yaml', 'description: x\ntools: [Read]\n', 0o666);
  put('twice.yaml', 'description: x\ntools: [Read]\n');
  put('twice.json', '{"description":"x","tools":["Read"]}');
  put('renamed.yaml', 'name: other\ndescription: x\ntools: [Read]\n');
  put('README.md', 'not an agent');
  put('.good.tmp-1', 'half written');
  const config = loadConfig(fx.configFile);
  assert.deepEqual(Object.keys(config.agents), ['good']);
  assert.match(config.agentErrors['typo'] ?? '', /^agents\/typo\.yaml has no key "disallowedTool"/);
  assert.match(config.agentErrors['both'] ?? '', /defined both in config\.json and in agents\/both\.yaml/);
  assert.match(config.agentErrors['open'] ?? '', /may be written by others \(mode 666\)/);
  assert.match(config.agentErrors['twice'] ?? '', /two files for twice/);
  assert.match(config.agentErrors['renamed'] ?? '', /names the agent "other", but the file is for "renamed"/);
  assert.deepEqual(Object.keys(config.agentErrors).sort(), ['both', 'open', 'renamed', 'twice', 'typo']);
});

test('board agents lists each agent with where it is defined, its counts, its source and whether it is usable', async (context) => {
  const fx = fixture(context, { agents: { inline: { description: 'x', tools: ['Read'], allowedTools: ['Read'] } } });
  mkdirSync(fx.agentsDir);
  writeFileSync(join(fx.agentsDir, 'broken.yaml'), 'description: x\n', { mode: 0o600 });
  writeFileSync(
    join(fx.agentsDir, 'plugged.yaml'),
    'description: x\ntools: [Bash]\nallowedTools: ["Bash({nope}/x.sh *)"]\nsource: https://example.com/p.yaml\n',
    { mode: 0o600 },
  );
  await fx.go(['agents']);
  const text = fx.out.join('');
  assert.match(text, /^broken {2}NOT USABLE: agents\/broken\.yaml: tools must be a non-empty list/m);
  assert.match(text, /^inline {2}usable {2}\(config\.json\)\n {2}tools 1: Read; allow 1, deny 0$/m);
  assert.match(text, /^plugged {2}NOT USABLE: \{nope\} does not resolve/m);
  assert.match(text, /source: https:\/\/example\.com\/p\.yaml/);
  fx.out.length = 0;
  await fx.go(['agents', 'list', '--json']);
  const json = JSON.parse(fx.out.join('')) as { agents: { name: string; usable: boolean; from: string }[] };
  assert.deepEqual(
    json.agents.map(({ name, usable, from }) => [name, usable, from]),
    [
      ['broken', false, 'agents/broken.yaml'],
      ['inline', true, 'config.json'],
      ['plugged', false, 'agents/plugged.yaml'],
    ],
  );
});

test('board agents refuses unknown actions and misplaced flags', async (context) => {
  const fx = fixture(context);
  await assert.rejects(fx.go(['agents', 'install', 'x']), /agents takes nothing, or list, show, export, add, rm/);
  await assert.rejects(fx.go(['agents', 'show']), /takes one name/);
  await assert.rejects(fx.go(['agents', 'list', '--yes']), /--name, --replace and --yes belong to add/);
  await assert.rejects(fx.go(['agents', 'show', 'x', '--json', '--yaml']), /choose one/);
});
