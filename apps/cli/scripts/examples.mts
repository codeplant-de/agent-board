// Rewrites examples/examples.json, which `board example` embeds, from the example files.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readExamples } from '../src/examples.mts';

const dir = fileURLToPath(new URL('../examples', import.meta.url));
const path = `${dir}/examples.json`;
const updated = `${JSON.stringify(readExamples(dir), null, 2)}\n`;
let current = '';
try {
  current = readFileSync(path, 'utf8');
} catch {
  // A first run has no file yet.
}
if (updated === current) console.log('examples.json is up to date');
else {
  writeFileSync(path, updated);
  console.log('examples.json updated');
}
