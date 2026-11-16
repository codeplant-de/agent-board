import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError } from './config.mts';
import { loadEnvFile, parseEnv } from './env-file.mts';

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-env-file-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseEnv reads KEY=value lines, with an export prefix and whitespace around the parts', () => {
  assert.deepEqual(parseEnv('A=1\nexport B=2\n  C  =  three words  \n\texport   D=4'), {
    A: '1',
    B: '2',
    C: 'three words',
    D: '4',
  });
});

test('parseEnv skips comments, blank lines and invalid names', () => {
  assert.deepEqual(parseEnv('# A=1\n\n   \n1BAD=x\nBAD-NAME=y\nno equals sign\n=novalue\nGOOD_1=ok'), { GOOD_1: 'ok' });
});

test('parseEnv strips one matching pair of quotes and keeps everything else in the value', () => {
  assert.deepEqual(parseEnv('A="x y"\nB=\'x y\'\nC="x\'\nD=""y""\nE=\nF=a=b'), {
    A: 'x y',
    B: 'x y',
    C: '"x\'',
    D: '"y"',
    E: '',
    F: 'a=b',
  });
});

test('parseEnv lets a later line win and handles CRLF line ends', () => {
  assert.deepEqual(parseEnv('A=1\r\nA=2\r\n'), { A: '2' });
});

test('loadEnvFile parses a file of mode 600 or 400', () => {
  withDir((dir) => {
    const path = join(dir, 'env');
    writeFileSync(path, 'TOKEN="abc"\n', { mode: 0o600 });
    assert.deepEqual(loadEnvFile(path), { TOKEN: 'abc' });
    chmodSync(path, 0o400);
    assert.deepEqual(loadEnvFile(path), { TOKEN: 'abc' });
  });
});

test('loadEnvFile for a missing file says to run "board init"', () => {
  withDir((dir) => {
    const path = join(dir, 'missing');
    assert.throws(
      () => loadEnvFile(path),
      (error) =>
        error instanceof ConfigError && error.message === `credentials file missing: ${path} (run "board init")`,
    );
  });
});

test('loadEnvFile refuses a file that others can read, naming the mode', () => {
  withDir((dir) => {
    const path = join(dir, 'env');
    writeFileSync(path, 'TOKEN=abc\n');
    chmodSync(path, 0o644);
    assert.throws(
      () => loadEnvFile(path),
      (error) =>
        error instanceof ConfigError && error.message === `credentials file must be mode 600 or 400, is 644: ${path}`,
    );
  });
});
