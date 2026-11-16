// Rewrites examples/examples.json, which `board example` embeds, from the other files of examples/.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../examples/', import.meta.url));
const OUTPUT = 'examples.json';
const files = readdirSync(dir)
  .filter((name) => name !== OUTPUT)
  .sort();
const embedded = Object.fromEntries(files.map((name) => [name, readFileSync(`${dir}${name}`, 'utf8')]));
const text = `${JSON.stringify(embedded, null, 2)}\n`;
const path = `${dir}${OUTPUT}`;
if (readFileSync(path, 'utf8').toString() === text) console.log('examples.json is up to date');
else {
  writeFileSync(path, text);
  console.log('examples.json updated');
}
