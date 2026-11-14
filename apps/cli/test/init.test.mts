import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KEYS, OWNER } from './helpers.mts';
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
      /token file missing/,
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
      verifyServer: async (config) => {
        verified.push(config.url);
        return { owner: OWNER, keyId: KEYS.keyId };
      },
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

// A prompt that behaves like clack: validate sees the raw input before any default is applied, and the raw value comes back.
function clackLike(answers: { text: string[]; secret: string[] }): Prompts & { asked: string[] } {
  const asked: string[] = [];
  const take = (
    queue: string[],
    message: string,
    validate: (value: string) => string | undefined,
    defaultValue?: string,
  ): string => {
    asked.push(message);
    const raw = queue.shift() ?? '';
    const problem = validate(raw);
    if (problem !== undefined) throw new Error(`prompt validation: ${problem}`);
    return raw === '' ? (defaultValue ?? '') : raw;
  };
  return {
    asked,
    text: async (message, { defaultValue, validate }) => take(answers.text, message, validate, defaultValue),
    secret: async (message, { validate }) => take(answers.secret, message, validate),
  };
}

test('prompt answers are trimmed, and Enter accepts the machine name default', async () => {
  const dir = tempDir();
  try {
    const prompts = clackLike({ text: ['  https://board.example.com  ', ''], secret: [`  ${TOKEN}\n`] });
    await init(deps(join(dir, 'cfg'), { interactive: true, prompts, hostName: 'laptop' }), {});
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cfg', 'web.json'), 'utf8')), {
      url: 'https://board.example.com',
    });
    assert.equal(readFileSync(join(dir, 'cfg', 'env'), 'utf8'), `AGENT_BOARD_TOKEN=${TOKEN}\n`);
    assert.equal(
      (JSON.parse(readFileSync(join(dir, 'cfg', 'config.json'), 'utf8')) as { machine: string }).machine,
      'laptop',
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a URL with embedded whitespace is refused by the prompt, and by the URL rule itself', async () => {
  assert.match(urlProblem('https://board.example.com/ x') ?? '', /http\(s\) URL/);
  assert.match(urlProblem('https://board example.com') ?? '', /http\(s\) URL/);
  assert.equal(urlProblem(' https://board.example.com '), undefined, 'surrounding spaces are trimmed, not refused');
  const dir = tempDir();
  try {
    const prompts = clackLike({ text: ['https://board.example.com/ x'], secret: [TOKEN] });
    await assert.rejects(init(deps(join(dir, 'cfg'), { interactive: true, prompts }), {}), /prompt validation/);
    assert.throws(() => readdirSync(join(dir, 'cfg')), 'nothing was created');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init --force with a bad answer changes nothing: no backup, no temp file, web.json stays', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { url: 'https://old.example.com', tokenFile: tokenFile(dir, 'abm_old'), machine: 'm' });
    const before = readdirSync(configDir).sort();
    const prompts = clackLike({ text: [' not a url'], secret: [TOKEN] });
    await assert.rejects(init(deps(configDir, { interactive: true, prompts }), { force: true }), /prompt validation/);
    assert.deepEqual(readdirSync(configDir).sort(), before);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), { url: 'https://old.example.com' });
    await assert.rejects(init(deps(configDir), { force: true, url: ' not a url', tokenFile: tokenFile(dir) }), /--url/);
    assert.deepEqual(readdirSync(configDir).sort(), before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a failure while writing leaves every file in place and no temp file behind', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { url: 'https://old.example.com', tokenFile: tokenFile(dir, 'abm_old'), machine: 'm' });
    rmSync(join(configDir, 'env'));
    mkdirSync(join(configDir, 'env'));
    writeFileSync(join(configDir, 'env', 'inside'), 'x');
    await assert.rejects(
      init(deps(configDir), { force: true, url: 'https://new.example.com', tokenFile: tokenFile(dir) }),
    );
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), { url: 'https://old.example.com' });
    assert.deepEqual(readdirSync(configDir).sort(), ['config.json', 'env', 'web.json']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a dangling symlink in place of env is replaced by a real file', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    mkdirSync(configDir);
    symlinkSync(join(dir, 'nowhere'), join(configDir, 'env'));
    await init(deps(configDir), { url: 'https://board.example.com', tokenFile: tokenFile(dir), machine: 'm' });
    assert.equal(statSync(join(configDir, 'env')).isFile(), true);
    assert.equal(readFileSync(join(configDir, 'env'), 'utf8'), `AGENT_BOARD_TOKEN=${TOKEN}\n`);
    assert.equal(mode(join(configDir, 'env')), 0o600);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('only the values whose file will be written are asked for', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { url: 'https://board.example.com', tokenFile: tokenFile(dir), machine: 'm' });
    rmSync(join(configDir, 'env'));
    const result = await init(deps(configDir), { tokenFile: tokenFile(dir, 'abm_new') });
    assert.deepEqual(result.written, [join(configDir, 'env')]);
    rmSync(join(configDir, 'env'));
    const prompts = clackLike({ text: [], secret: [TOKEN] });
    await init(deps(configDir, { interactive: true, prompts }), {});
    assert.deepEqual(prompts.asked, ['Machine token (not shown)']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a token file is held to the same mode as env', async () => {
  const dir = tempDir();
  try {
    const wide = tokenFile(dir);
    chmodSync(wide, 0o644);
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { url: 'https://board.example.com', tokenFile: wide }),
      /token file must be mode 600 or 400, is 644/,
    );
    assert.throws(() => readdirSync(join(dir, 'cfg')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('config.json is always kept, and the line says so', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    const first = deps(configDir);
    await init(first, { url: 'https://board.example.com', tokenFile: tokenFile(dir), machine: 'm' });
    const second = deps(configDir);
    await init(second, { force: true, url: 'https://board.example.com', tokenFile: tokenFile(dir) });
    assert.ok(second.printed.some((line) => /kept .*config\.json \(config\.json is always kept/.test(line)));
    assert.ok(!second.printed.some((line) => /config\.json.*--force/.test(line)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
