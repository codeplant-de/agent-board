import { runMain } from './cli.mts';
import { runBoard } from './commands.mts';

// `board tasks | head` closes the pipe; that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const args = process.argv.slice(2);

// Completion must never keep a prompt waiting, whatever is in flight: one deadline for the whole process.
if (args[0] === '__complete') setTimeout(() => process.exit(0), 2000).unref();
const isInternal = args[0] === 'internal';

await runMain(() => runBoard(args), isInternal ? 'agent-board' : 'board');
// A broken hook must not break the tool call it guards.
if (isInternal && args[1] === 'hook') process.exitCode = 0;
