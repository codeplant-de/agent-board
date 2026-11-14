import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageError } from '../src/cli.mts';
import { runBoard } from '../src/commands.mts';
import { init, machineProblem, tokenProblem, urlProblem } from '../src/init.mts';
import type { InitDeps, Prompts } from '../src/init.mts';

const TOKEN = 'abm_secretsecretsecret';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'board-init-test-'));
}

const NO_PROMPTS: Prompts = {
  text: async () => assert.fail('no question expected'),
  secret: async () => assert.fail('no question expected'),
};

function deps(configDir: string, overrides: Partial<InitDeps> = {}): InitDeps & { printed: string[] } {
  const printed: string[] = [];
  return {
    configDir,
    interactive: false,
    prompts: NO_PROMPTS,
    hostName: 'laptop',
    now: () => new Date('2026-11-14T10:20:30.123Z'),
    print: (line) => printed.push(line),
    printed,
    ...overrides,
  };
}

function tokenFile(dir: string, token = TOKEN, name = 'token'): string {
  const path = join(dir, name);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

const mode = (path: string): number => statSync(path).mode & 0o777;

test('init writes web.json, env with mode 600 and a config.json with the machine name', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    const result = await init(deps(configDir), {
      url: 'https://board.example.com/',
      tokenFile: tokenFile(dir),
      machine: 'box-1',
    });
    assert.equal(result.written.length, 3);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), {
      url: 'https://board.example.com',
    });
    assert.equal(readFileSync(join(configDir, 'env'), 'utf8'), `AGENT_BOARD_TOKEN=${TOKEN}\n`);
    assert.equal(mode(join(configDir, 'env')), 0o600);
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as {
      machine: string;
      lanes: object;
    };
    assert.equal(config.machine, 'box-1');
    const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')) as {
      lanes: object;
    };
    assert.deepEqual(config.lanes, example.lanes);
    assert.ok(!readFileSync(join(configDir, 'web.json'), 'utf8').includes(TOKEN));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init keeps existing files without --force and says so, without asking anything', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    const flags = { url: 'https://board.example.com', tokenFile: tokenFile(dir), machine: 'box-1' };
    await init(deps(configDir), flags);
    writeFileSync(join(configDir, 'config.json'), '{"machine": "mine"}');
    const again = deps(configDir, { interactive: true });
    const result = await init(again, {});
    assert.deepEqual(result.written, []);
    assert.equal(result.skipped.length, 3);
    assert.ok(again.printed.some((line) => line.startsWith(`kept ${join(configDir, 'env')}`)));
    assert.equal(readFileSync(join(configDir, 'config.json'), 'utf8'), '{"machine": "mine"}');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init --force backs up web.json and env first, keeps the env mode, and never replaces config.json', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { url: 'https://old.example.com', tokenFile: tokenFile(dir, 'abm_old'), machine: 'm' });
    writeFileSync(join(configDir, 'config.json'), '{"machine": "mine"}');
    const result = await init(deps(configDir), {
      url: 'https://new.example.com',
      tokenFile: tokenFile(dir, 'abm_new'),
      force: true,
    });
    assert.equal(result.backedUp.length, 2);
    const stamp = '2026-11-14T10-20-30-123Z';
    assert.deepEqual(readdirSync(configDir).sort(), [
      'config.json',
      'env',
      `env.bak-${stamp}`,
      'web.json',
      `web.json.bak-${stamp}`,
    ]);
    assert.equal(readFileSync(join(configDir, `env.bak-${stamp}`), 'utf8'), 'AGENT_BOARD_TOKEN=abm_old\n');
    assert.equal(mode(join(configDir, `env.bak-${stamp}`)), 0o600);
    assert.equal(readFileSync(join(configDir, 'env'), 'utf8'), 'AGENT_BOARD_TOKEN=abm_new\n');
    assert.equal(mode(join(configDir, 'env')), 0o600);
    assert.equal(readFileSync(join(configDir, 'config.json'), 'utf8'), '{"machine": "mine"}');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init without a terminal names the flag it misses instead of waiting', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(init(deps(join(dir, 'a')), { tokenFile: tokenFile(dir) }), /give --url/);
    await assert.rejects(init(deps(join(dir, 'b')), { url: 'https://board.example.com' }), /give --token-file/);
    assert.deepEqual(readdirSync(dir).sort(), ['token'], 'nothing is written before every value is known');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init refuses a bad URL, a token that is not a machine token and an unsafe machine name', async () => {
  const dir = tempDir();
  try {
    const good = { url: 'https://board.example.com', tokenFile: tokenFile(dir) };
    await assert.rejects(
      init(deps(join(dir, 'a')), { ...good, url: 'http://board.example.com' }),
      /https unless it is localhost/,
    );
    await assert.rejects(init(deps(join(dir, 'b')), { ...good, url: 'nope' }), UsageError);
    await assert.rejects(
      init(deps(join(dir, 'c')), { ...good, tokenFile: tokenFile(dir, 'hunter2', 'bad-token') }),
      /starts with abm_/,
    );
    await assert.rejects(
      init(deps(join(dir, 'd')), { ...good, tokenFile: join(dir, 'missing') }),
      /cannot read the token file/,
    );
    await assert.rejects(init(deps(join(dir, 'e')), { ...good, machine: 'bad name' }), /machine name/);
    await init(deps(join(dir, 'f')), { ...good, url: 'http://localhost:3000' });
    assert.equal(urlProblem('https://board.example.com'), undefined);
    assert.equal(tokenProblem(TOKEN), undefined);
    assert.equal(machineProblem('box-1'), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init asks for what is missing at a terminal, with the host name as the machine default', async () => {
  const dir = tempDir();
  const asked: string[] = [];
  const prompts: Prompts = {
    text: async (message, { defaultValue, validate }) => {
      asked.push(message);
      if (!message.startsWith('Machine')) assert.equal(validate('nope') === undefined, false);
      return message.startsWith('Machine') ? (defaultValue ?? '') : 'https://board.example.com';
    },
    secret: async (message, { validate }) => {
      asked.push(message);
      assert.equal(validate('hunter2') === undefined, false);
      return TOKEN;
    },
  };
  try {
    await init(deps(join(dir, 'cfg'), { interactive: true, prompts }), {});
    assert.equal(asked.length, 3);
    const config = JSON.parse(readFileSync(join(dir, 'cfg', 'config.json'), 'utf8')) as { machine: string };
    assert.equal(config.machine, 'laptop');
    assert.equal(mode(join(dir, 'cfg', 'env')), 0o600);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('board init runs the doctor checks after writing, and is refused inside a run', async () => {
  const dir = tempDir();
  const out: string[] = [];
  const configDir = join(dir, 'cfg');
  const env = { AGENT_BOARD_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: '' };
  const verified: string[] = [];
  try {
    await runBoard(['init', '--url', 'https://board.example.com', '--token-file', tokenFile(dir), '--machine', 'box'], {
      env,
      writeOut: (text) => out.push(text),
      interactive: false,
      verifyServer: async (config) => void verified.push(config.url),
      systemctlCode: async () => 1,
    });
    assert.deepEqual(verified, ['https://board.example.com']);
    const text = out.join('');
    assert.match(text, /wrote .*web\.json/);
    assert.match(text, /✓ server: https:\/\/board\.example\.com answers/);
    assert.match(text, /Next, on a worker machine: board setup/);
    assert.ok(!text.includes(TOKEN));
    await assert.rejects(
      runBoard(['init'], { env: { ...env, AGENT_BOARD_TASK: 'Zt0Test1' } }),
      /not available inside a board run/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a failing check after init fails the command', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      runBoard(['init', '--url', 'https://board.example.com', '--token-file', tokenFile(dir)], {
        env: { AGENT_BOARD_CONFIG_DIR: join(dir, 'cfg'), XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: '' },
        writeOut: () => undefined,
        interactive: false,
        verifyServer: async () => {
          throw new Error('cannot reach https://board.example.com');
        },
        systemctlCode: async () => 1,
      }),
      /a check failed/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
