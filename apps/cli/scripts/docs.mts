// Rewrites the command reference in docs/cli.md from the commander program.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withCommandsDoc } from '../src/docs.mts';

const path = fileURLToPath(new URL('../../../docs/cli.md', import.meta.url));
const doc = readFileSync(path, 'utf8');
const updated = withCommandsDoc(doc);
if (updated === doc) console.log('docs/cli.md is up to date');
else {
  writeFileSync(path, updated);
  console.log('docs/cli.md updated');
}
