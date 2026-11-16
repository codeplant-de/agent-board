// The scripts that ship with the CLI, for `board example`. The binary has no files next to it, so their text is embedded
// through examples/examples.json, which `pnpm --filter @agent-board/cli run examples` writes from the files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import embedded from '../examples/examples.json' with { type: 'json' };

export interface Example {
  name: string;
  // The path under apps/cli/examples.
  file: string;
  summary: string;
  content: string;
}

type ExampleSource = Omit<Example, 'content'>;

export const EXAMPLE_SOURCES: ExampleSource[] = [
  {
    name: 'github-reviews',
    file: 'intakes/github-reviews.sh',
    summary: 'a script (sh, gh) that makes a /review-pr task of every pull request asking for your review',
  },
];

/** The examples with their text read from the files in `dir` (apps/cli/examples). */
export function readExamples(dir: string): Example[] {
  return EXAMPLE_SOURCES.map((source) => ({ ...source, content: readFileSync(join(dir, source.file), 'utf8') }));
}

function parseExamples(value: unknown): Example[] {
  if (!Array.isArray(value)) throw new Error('examples.json is not a list');
  return value.map((entry): Example => {
    if (
      !isRecord(entry) ||
      typeof entry['name'] !== 'string' ||
      typeof entry['file'] !== 'string' ||
      typeof entry['summary'] !== 'string' ||
      typeof entry['content'] !== 'string'
    )
      throw new Error('examples.json has an entry that is not an example');
    return { name: entry['name'], file: entry['file'], summary: entry['summary'], content: entry['content'] };
  });
}

export const EXAMPLES: Example[] = parseExamples(embedded);
