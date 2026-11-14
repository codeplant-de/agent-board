import type { Command } from 'commander';
import { buildProgram } from './commands.mts';

export const COMMANDS_START = '<!-- commands:start -->';
export const COMMANDS_END = '<!-- commands:end -->';

function helpOf(command: Command): string {
  const chunks: string[] = [];
  command
    .configureOutput({ writeOut: (text) => void chunks.push(text) })
    .configureHelp({ ...command.configureHelp(), helpWidth: 80 });
  command.outputHelp();
  return chunks.join('').trimEnd();
}

// The README's command reference, from the program itself, so it cannot drift from what `board help` says.
export function renderCommandsDoc(): string {
  const program = buildProgram({ env: {}, version: 'docs' });
  const help = program.createHelp();
  const groups = new Map<string, Command[]>();
  // `help` is a command of commander's own; its overview line is in the block above.
  for (const command of help.visibleCommands(program).filter((candidate) => candidate.name() !== 'help')) {
    const heading = command.helpGroup() || 'Commands:';
    groups.set(heading, [...(groups.get(heading) ?? []), command]);
  }
  const sections = [...groups].map(([heading, commands]) => [
    `### ${heading.replace(/:$/, '')}`,
    ...commands.map((command) => `#### board ${command.name()}\n\n\`\`\`\n${helpOf(command)}\n\`\`\``),
  ]);
  return [COMMANDS_START, `\`\`\`\n${helpOf(program)}\n\`\`\``, ...sections.flat(), COMMANDS_END].join('\n\n');
}

// README with its generated block replaced.
export function withCommandsDoc(readme: string): string {
  const start = readme.indexOf(COMMANDS_START);
  const end = readme.indexOf(COMMANDS_END);
  if (start === -1 || end === -1) throw new Error('README.md has no commands block between its markers');
  return `${readme.slice(0, start)}${renderCommandsDoc()}${readme.slice(end + COMMANDS_END.length)}`;
}
