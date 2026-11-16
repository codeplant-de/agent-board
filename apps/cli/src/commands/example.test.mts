import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { exampleNames, exampleText } from './example.mts';
import { runBoard } from './program.mts';

const dir = new URL('../../examples/', import.meta.url);
const shipped = readdirSync(dir)
  .filter((name) => name !== 'examples.json')
  .sort();

test('examples.json holds every file of examples/ as it is; run `pnpm --filter @agent-board/cli run examples` when this fails', () => {
  assert.deepEqual(exampleNames(), shipped);
  for (const name of shipped) assert.equal(exampleText(name), readFileSync(new URL(name, dir), 'utf8'), name);
});

test('board example lists the names, prints one file whole, and refuses an unknown name', async () => {
  const out: string[] = [];
  const go = (argv: string[]) =>
    runBoard(argv, { env: {}, writeOut: (text) => out.push(text), writeErr: () => undefined });
  await go(['example']);
  assert.deepEqual(out.join('').trimEnd().split('\n'), shipped);
  out.length = 0;
  await go(['example', 'github-reviews.sh']);
  assert.equal(out.join(''), readFileSync(new URL('github-reviews.sh', dir), 'utf8'));
  await assert.rejects(
    go(['example', 'nope']),
    /no example "nope"; the examples are config\.reviews\.json, github-reviews\.sh/,
  );
  assert.equal(exampleText('constructor'), undefined);
  assert.equal(exampleText('__proto__'), undefined);
});
