import { isAgentName, promptSkill, shortSkill } from '@agent-board/shared';
import type { Task, UnreadableField } from '@agent-board/shared';
import type { AgentConfig, Lane } from './config/config.mts';

export const START_MARKER = 'agent-board: started';
// The start of the note that ends a wait; the rest of it is why, and the resumed agent is told.
export const WAKE_MARKER = 'agent-board: wait over:';
// The start of the thread note a watch's event leaves (see watch/finish.mts); the agent did not write it.
export const WATCH_MARKER = 'agent-board: watch';

// The lane of this machine whose own work the task is: the lane naming the skill its prompt starts with, else the lane
// with "*". Undefined when no lane owns it; any lane may still borrow it.
export function ownLane(task: Task, lanes: Lane[]): string | undefined {
  const skill = promptSkill(task.input);
  const short = skill === undefined ? undefined : shortSkill(skill);
  return (
    lanes.find((lane) => short !== undefined && lane.skills.includes(short)) ??
    lanes.find((lane) => lane.skills.includes('*'))
  )?.name;
}

// The fields this machine could not open that a run needs: its prompt and the directory it works in. A task listed here must
// not be started, since an empty prompt or a missing directory would run something else than the user wrote. The title and the
// watches are only shown.
export function unreadableForRun(task: Task): UnreadableField[] {
  return task.unreadable.filter((field) => field !== 'title' && field !== 'watches');
}

/**
 * Why this task is never run, whatever the board says, or undefined. An agent's proposal is the user's to start: starting it seals
 * its prompt again as the user's (creator "user"), so a task that still names the agent as its creator was not started by the
 * user, and its prompt must never get the user's permissions.
 */
export function neverRun(task: Task): string | undefined {
  return task.createdBy === 'agent'
    ? 'An agent proposed this task and you have not started it: a worker only runs what you started or your own machines created.'
    : undefined;
}

/**
 * Why a task of the removed built-in intake that names no agent is never run, or undefined. It used to run under intake's own
 * rules, which no longer exist, so it must not run as the user either.
 */
export function removedIntakeProblem(task: Task): string | undefined {
  return task.createdBy === 'intake' && (task.agent ?? null) === null
    ? 'The built-in intake that made this task was removed, and the task names no agent, so it has no rules to run under. Close it, or create it again with `board schedule --agent <name>`.'
    : undefined;
}

// The agent a task runs as. `none`: it names none and runs by its creator's rules. `missing`: it names one this machine does
// not define or could not read, so it must not run here at all: its restrictions would be missing.
export type AgentLookup =
  { kind: 'none' } | { kind: 'found'; name: string; agent: AgentConfig } | { kind: 'missing'; reason: string };

// A name from the board, safe to print.
const agentLabel = (name: string): string => (isAgentName(name) ? name : JSON.stringify(name.slice(0, 40)));

export function agentFor(
  task: Task,
  config: {
    agents: Record<string, AgentConfig>;
    agentErrors: Record<string, string>;
  },
): AgentLookup {
  const name = task.agent ?? null;
  if (name === null) return { kind: 'none' };
  const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (agent === undefined) {
    const unreadable = Object.hasOwn(config.agentErrors, name) ? config.agentErrors[name] : undefined;
    return {
      kind: 'missing',
      reason:
        unreadable === undefined
          ? `no agent ${agentLabel(name)} defined here`
          : `agent ${agentLabel(name)} here cannot be used (${unreadable})`,
    };
  }
  return { kind: 'found', name, agent };
}
