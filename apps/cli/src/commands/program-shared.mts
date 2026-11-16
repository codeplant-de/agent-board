import type { Command } from 'commander';
import type { ContextOptions, LinkingContext } from '../cli.mts';
import type { ProgramOptions } from './program.mts';

// What buildProgram builds once and hands to every command group.
export interface ProgramShared {
  program: Command;
  options: ProgramOptions;
  env: Record<string, string | undefined>;
  argv: string[];
  inRun: boolean;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  out: (line: string) => void;
  makeContext: (dryRun: boolean, options: ContextOptions) => LinkingContext;
  contextOf: (
    command: Command,
    flags?: { strictConfig?: boolean; json?: boolean; timeoutMs?: number },
  ) => LinkingContext;
  writeJson: (value: unknown) => void;
  taskIdOf: (context: LinkingContext, arg: string) => Promise<string>;
  jsonOption: (command: Command, flags?: { readable?: boolean }) => Command;
  jsonOptionReadable: (command: Command) => Command;
  dryRunOption: (command: Command) => Command;
  refuseDryRunInText: (words: string[], usage: string) => void;
  notInRun: (message: string) => void;
  textOf: (words: string[]) => Promise<string>;
}
