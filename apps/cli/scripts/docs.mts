// Rewrites the command reference of the README from the commander program.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withCommandsDoc } from '../src/docs.mts';

const path = fileURLToPath(new URL('../../../README.md', import.meta.url));
const readme = readFileSync(path, 'utf8');
const updated = withCommandsDoc(readme);
if (updated === readme) console.log('README.md is up to date');
else {
  writeFileSync(path, updated);
  console.log('README.md updated');
}
