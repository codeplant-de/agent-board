import { runMain } from './cli.mts';
import { runBoard } from './commands.mts';

const args = process.argv.slice(2);
const isInternal = args[0] === 'internal';

await runMain(() => runBoard(args), isInternal ? 'agent-board' : 'board');
// A broken hook must not break the tool call it guards.
if (isInternal && args[1] === 'hook') process.exitCode = 0;
