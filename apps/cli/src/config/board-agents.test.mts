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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { agentHash } from '@agent-board/shared';
import type { SharedAgentsDocument } from '@agent-board/shared';
import { fakeBackend } from '../__tests__/helpers/fakes.mts';
import { agentHashOf, applySharedAgents, catalogAgents, replacedFiles, syncSharedAgents } from './board-agents.mts';
import { loadConfig, readBoardAgentsState } from './config.mts';

const READER = { description: 'Reads', tools: ['Read'], allowedTools: ['Read'], disallowedTools: ['Read(~/.ssh/**)'] };
const WRITER = { description: 'Writes', tools: ['Write'], allowedTools: ['Write(/tmp/**)'] };
const AT = new Date('2026-11-18T10:15:00Z');

function fixture(context: TestContext, config: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-agents-apply-')));
  context.after(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, 'config');
  mkdirSync(dir);
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({ machine: 'here', ...config }, null, 2)}\n`, { mode: 0o640 });
  const logged: string[] = [];
  return {
    root,
    dir,
    configFile,
    logged,
    board: join(dir, 'agents.board'),
    deps: { configFile, now: () => AT, log: (line: string) => logged.push(line) },
  };
}

const doc = (version: number, agents: SharedAgentsDocument['agents']): SharedAgentsDocument => ({ version, agents });

test('an apply writes each agent to agents.board/ (600 in 700), records the version and hashes, and loadConfig runs them as the board’s', async (context) => {
  const fx = fixture(context);
  const applied = await applySharedAgents(fx.deps, doc(3, { reader: READER, writer: WRITER }));
  assert.deepEqual(applied.written, ['reader', 'writer']);
  assert.equal(statSync(fx.board).mode & 0o777, 0o700);
  assert.equal(statSync(join(fx.board, 'reader.yaml')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(fx.board).sort(), ['reader.yaml', 'state.json', 'writer.yaml']);
  const state = readBoardAgentsState(fx.board);
  assert.equal(state.version, 3);
  const config = loadConfig(fx.configFile);
  assert.deepEqual(Object.keys(config.agents).sort(), ['reader', 'writer']);
  assert.equal(config.agents['reader']?.source, 'board');
  assert.deepEqual(config.board?.names, ['reader', 'writer']);
  assert.equal(config.board?.version, 3);
  assert.equal(state.hashes['reader'], agentHashOf(config.agents['reader']!));
  // The browser hashes with WebCrypto; the same definition has the same hash.
  assert.equal(state.hashes['reader'], await agentHash(READER));
  assert.deepEqual(Object.keys(config.agentErrors), []);

  // The next version without writer takes its file away.
  const next = await applySharedAgents(fx.deps, doc(4, { reader: READER }));
  assert.deepEqual(next.removed, ['writer']);
  assert.deepEqual(Object.keys(loadConfig(fx.configFile).agents), ['reader']);
});

test('the board wins a name: an agents/ file and a config.json entry are moved to agents.replaced/, equal or not', async (context) => {
  const fx = fixture(context, { repos: {}, agents: { writer: WRITER, keep: READER } });
  mkdirSync(join(fx.dir, 'agents'), { mode: 0o700 });
  writeFileSync(
    join(fx.dir, 'agents', 'reader.yaml'),
    'description: Reads\ntools: [Read]\nallowedTools: [Read]\ndisallowedTools: ["Read(~/.ssh/**)"]\n',
    { mode: 0o600 },
  );
  const applied = await applySharedAgents(fx.deps, doc(1, { reader: READER, writer: WRITER }));
  assert.deepEqual(applied.replaced.map(({ name }) => name).sort(), ['reader', 'writer']);
  const replaced = join(fx.dir, 'agents.replaced');
  assert.deepEqual(readdirSync(replaced).sort(), ['reader.20261118T101500Z.yaml', 'writer.20261118T101500Z.yaml']);
  assert.equal(statSync(replaced).mode & 0o777, 0o700);
  assert.equal(statSync(join(replaced, 'writer.20261118T101500Z.yaml')).mode & 0o777, 0o600);
  assert.match(
    readFileSync(join(replaced, 'writer.20261118T101500Z.yaml'), 'utf8'),
    /^name: writer\ndescription: Writes/,
  );
  assert.deepEqual(readdirSync(join(fx.dir, 'agents')), []);
  // Every other key of config.json and its mode stay.
  const raw = JSON.parse(readFileSync(fx.configFile, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw, { machine: 'here', repos: {}, agents: { keep: READER } });
  assert.equal(statSync(fx.configFile).mode & 0o777, 0o640);
  const config = loadConfig(fx.configFile);
  assert.deepEqual(Object.keys(config.agents).sort(), ['keep', 'reader', 'writer']);
  assert.deepEqual(Object.keys(config.agentErrors), []);
  assert.deepEqual(Object.keys(replacedFiles(fx.configFile)).sort(), ['reader', 'writer']);
  assert.deepEqual(catalogAgents(fx.configFile, config.agents).replaced, ['reader', 'writer']);
});

test('an entry that does not parse makes only that agent unusable, and moves its local definition aside all the same', async (context) => {
  const fx = fixture(context, { agents: { odd: READER } });
  await applySharedAgents(fx.deps, doc(2, { reader: READER, odd: { ...READER, futureKey: true } }));
  const config = loadConfig(fx.configFile);
  assert.deepEqual(Object.keys(config.agents), ['reader']);
  assert.match(config.agentErrors['odd'] ?? '', /the board's agents v2: odd has no key "futureKey"/);
  assert.deepEqual(config.board?.names, ['odd', 'reader']);
});

test('a local definition the apply cannot move aside leaves that agent unusable, whatever the load order', async (context) => {
  const fx = fixture(context, { agents: { reader: WRITER } });
  // A read-only config directory: neither agents.replaced/ nor a new config.json can be written.
  mkdirSync(fx.board, { mode: 0o700 });
  chmodSync(fx.dir, 0o500);
  try {
    await applySharedAgents(fx.deps, doc(1, { reader: READER }));
  } finally {
    chmodSync(fx.dir, 0o700);
  }
  const config = loadConfig(fx.configFile);
  assert.equal(config.agents['reader'], undefined);
  assert.match(
    config.agentErrors['reader'] ?? '',
    /on the board and also defined in config\.json, which the last apply could not move aside/,
  );
});

test('the tick fetches only a newer version, keeps what it has when the board serves one that does not open or is older, and settles a hand-dropped file', async (context) => {
  const fx = fixture(context);
  const backend = fakeBackend([]);
  const sync = () => syncSharedAgents({ ...fx.deps, backend });
  assert.equal(await sync(), 'none');
  backend.boardAgents.held = { version: 2, document: doc(2, { reader: READER }) };
  assert.equal(await sync(), 'applied');
  assert.ok(fx.logged.includes('APPLIED agents v2: 1 agent(s)'));
  assert.equal(await sync(), 'current');

  backend.boardAgents.held = { version: 3, unreadable: true };
  assert.equal(await sync(), 'kept');
  assert.match(fx.logged.at(-1) ?? '', /WARN the board's agents v3 do not open under that version; keeping agents v2/);
  assert.match(readBoardAgentsState(fx.board).problem ?? '', /v3 do not open/);

  // A server that names a newer version and serves an old document.
  backend.boardAgents.held = { version: 1, document: doc(1, { writer: WRITER }) };
  backend.boardAgents.reported = 5;
  assert.equal(await sync(), 'kept');
  assert.deepEqual(Object.keys(loadConfig(fx.configFile).agents), ['reader']);

  backend.boardAgents.held = { version: 6, document: doc(6, { reader: READER }) };
  delete backend.boardAgents.reported;
  assert.equal(await sync(), 'applied');
  assert.equal(readBoardAgentsState(fx.board).problem, undefined);

  mkdirSync(join(fx.dir, 'agents'), { mode: 0o700 });
  writeFileSync(join(fx.dir, 'agents', 'reader.yml'), 'description: mine\ntools: [Bash]\n', { mode: 0o600 });
  assert.equal(await sync(), 'applied', 'nothing new on the board, but a file was moved aside');
  assert.match(
    fx.logged.at(-1) ?? '',
    /^REPLACED reader: local definition moved to .*agents\.replaced\/reader\.20261118T101500Z\.yml$/,
  );
  assert.equal(loadConfig(fx.configFile).agents['reader']?.description, 'Reads');

  backend.boardAgents.supported = false;
  assert.equal(await sync(), 'unsupported');
});
