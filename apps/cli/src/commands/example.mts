// The example files that ship with the CLI (apps/cli/examples), embedded so the compiled binary has them:
// `pnpm --filter @agent-board/cli run examples` rewrites examples/examples.json from the files.
import shipped from '../../examples/examples.json' with { type: 'json' };

const EXAMPLES: Record<string, string> = shipped;

export function exampleNames(): string[] {
  return Object.keys(EXAMPLES).sort();
}

export function exampleText(name: string): string | undefined {
  return Object.hasOwn(EXAMPLES, name) ? EXAMPLES[name] : undefined;
}
