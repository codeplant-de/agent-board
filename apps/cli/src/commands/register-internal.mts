import { Command } from 'commander';
import { UsageError } from '../cli.mts';
import { getPaths, loadConfig } from '../config/config.mts';
import { runDir } from '../worker/runtime.mts';
import { dispatchMain } from '../dispatch/dispatch.mts';
import { SystemError } from '../setup/system.mts';
import { runHook } from '../worker/hook.mts';
import { intakeMain } from '../intake/intake.mts';
import { listenMain } from '../dispatch/listen.mts';
import { workerMain } from '../worker/worker.mts';
import type { ProgramShared } from './program-shared.mts';

export function registerInternalCommands(shared: ProgramShared): void {
  const { program, options, env, contextOf, dryRunOption, notInRun } = shared;
  const internal = program
    .command('internal', { hidden: true })
    .description('What the dispatcher, the timers and a run call; not for typing')
    .action(() => {
      throw new UsageError('internal needs dispatch, intake, listen, worker or hook');
    });
  const refuseInternalInRun = (): void => {
    notInRun('board internal is not available inside a board run');
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux')
      throw new SystemError(`board internal runs worker machines and needs Linux with systemd; this is ${platform}`);
  };
  dryRunOption(internal.command('dispatch').description('One dispatcher tick')).action((_options, command: Command) => {
    refuseInternalInRun();
    return dispatchMain({ dryRun: contextOf(command).dryRun });
  });
  dryRunOption(internal.command('intake').description('Review requests to tasks')).action(
    (_options, command: Command) => {
      refuseInternalInRun();
      if (!loadConfig(getPaths(env).configFile, { optionalConfig: true }).intakeEnabled)
        throw new UsageError(
          'intake is not enabled: config.json has no intake key (see apps/cli/examples/config.reviews.json)',
        );
      return intakeMain({ dryRun: contextOf(command).dryRun });
    },
  );
  internal
    .command('listen')
    .description('Run a dispatch tick when the board says tasks changed')
    .action(() => {
      refuseInternalInRun();
      return listenMain();
    });
  internal
    .command('worker')
    .description('Run one task')
    .argument('<task>')
    .action((task: string) => {
      refuseInternalInRun();
      return workerMain(task);
    });
  // The hook of a run must never fail its tool call, so nothing it is given is a usage error.
  internal
    .command('hook')
    .description('The PreToolUse hook of a run')
    .argument('[args...]')
    .allowUnknownOption()
    .passThroughOptions()
    .action((args: string[]) => {
      // `Bash(board *)` reaches this: a run may only touch its own task's files.
      const run = env['AGENT_BOARD_TASK'];
      if (run && (args[1] !== run || args[0] !== runDir(env))) return;
      return runHook(args);
    });
}
