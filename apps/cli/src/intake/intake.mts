/**
 * Review requests to tasks: one task per PR URL, checked against every task, closed ones included.
 * A task in Needs me or Done goes back to Todo when the PR's head moved and has settled. A task still waiting in Todo
 * for a PR that no longer asks for the review is done, without a head, and comes back when the PR is listed again.
 * A PR whose data cannot be read is skipped and its task left alone.
 * After that, the state of every open task's PR (merged, closed, open) is looked up and written to the task, for the board.
 * Add --dry-run to read everything and print every write instead.
 */
import { buildContext, print, skipTickWhileServerOlder } from '../cli.mts';
import type { Context } from '../cli.mts';
import type { Backend, PrState, Task, TaskPatch } from '@agent-board/shared';
import { parsePrUrl, prUrlIn, statePrOf } from '@agent-board/shared';
import { ConfigError, intakeAgentProblem } from '../config/config.mts';
import { BackendError, isVocabularyRefusal } from '../backend/backend.mts';
import { updateCliHint } from '../backend/contract-check.mts';
import { createGitHub, GitHubError } from './github.mts';
import type { GitHub, LivePr, PrStateLookup } from './github.mts';

const SETTLE_MS = 10 * 60_000;

export type IntakeAction =
  | { kind: 'create'; pr: LivePr }
  | { kind: 'requeue'; pr: LivePr; task: Task }
  | { kind: 'skip'; pr: LivePr; reason: string }
  | { kind: 'close'; task: Task };

export const CLOSE_NOTE = 'The PR no longer asks for your review.';

export function planIntake(input: {
  prs: LivePr[];
  unreadable?: string[];
  tasks: Task[];
  repos: string[];
  now: Date;
  // A task's `head` is the blind index of its PR's head sha (`Backend.indexHead`); this gives the one to compare with.
  headIndex: (sha: string) => string;
}): IntakeAction[] {
  const listed = new Set([...input.prs.map((pr) => pr.url), ...(input.unreadable ?? [])]);
  // Only for a complete listing: the caller throws before planning when the search failed.
  const gone = input.tasks.filter((task) => {
    if (task.closed || task.createdBy !== 'intake' || task.status !== 'todo' || task.next !== 'fresh') return false;
    const url = prUrlIn(task.input);
    const repo = parsePrUrl(url ?? '')?.repo;
    return url !== undefined && repo !== undefined && input.repos.includes(repo) && !listed.has(url);
  });
  const actions = input.prs.map((pr): IntakeAction => {
    if (pr.isDraft) return { kind: 'skip', pr, reason: 'draft' };
    const repo = parsePrUrl(pr.url)?.repo;
    if (repo === undefined || !input.repos.includes(repo))
      return { kind: 'skip', pr, reason: 'repository not in config' };
    const settled = input.now.getTime() - pr.headCommittedAt.getTime() >= SETTLE_MS;
    const matches = input.tasks.filter((candidate) => prUrlIn(candidate.input) === pr.url);
    const task = matches.find((candidate) => !candidate.closed) ?? matches[0];
    if (task?.closed) return { kind: 'skip', pr, reason: 'task closed' };
    if (!task) return settled ? { kind: 'create', pr } : { kind: 'skip', pr, reason: 'head not settled' };

    if (task.status === 'done' && task.head === null && task.createdBy === 'intake') {
      return settled ? { kind: 'requeue', pr, task } : { kind: 'skip', pr, reason: 'listed again, not settled' };
    }
    if (task.head === null || task.head === input.headIndex(pr.headSha))
      return { kind: 'skip', pr, reason: 'task exists' };
    if (task.status !== 'needs-me' && task.status !== 'done')
      return { kind: 'skip', pr, reason: `head moved, task is ${task.status}` };
    return settled ? { kind: 'requeue', pr, task } : { kind: 'skip', pr, reason: 'head moved, not settled' };
  });
  return [...actions, ...gone.map((task): IntakeAction => ({ kind: 'close', task }))];
}

/** The PRs whose state to look up: those of the tasks still on the board, each once. */
export function prsToCheck(tasks: Task[]): string[] {
  const urls = tasks.filter((task) => !task.closed && task.status !== 'done').map((task) => statePrOf(task));
  return [...new Set(urls.filter((url): url is string => url !== undefined))];
}

/** The tasks whose stored state differs from what GitHub says; a PR GitHub did not answer for changes nothing. */
export function planPrStates(tasks: Task[], lookup: PrStateLookup): { task: Task; prState: PrState }[] {
  return tasks.flatMap((task) => {
    const url = task.closed || task.status === 'done' ? undefined : statePrOf(task);
    const prState = url === undefined ? undefined : lookup.states.get(url);
    return prState === undefined || prState === task.prState ? [] : [{ task, prState }];
  });
}

async function refreshPrStates(deps: IntakeDeps, tasks: Task[]): Promise<number> {
  const { backend, github, print: log } = deps;
  const urls = prsToCheck(tasks);
  if (urls.length === 0) return 0;
  let lookup: PrStateLookup;
  try {
    lookup = await github.prStates(urls);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    log(`WARN PR states not refreshed: ${error.message}`);
    return 0;
  }
  for (const url of lookup.unreadable) log(`WARN no state for ${url}`);
  let changed = 0;
  for (const { task, prState } of planPrStates(tasks, lookup)) {
    try {
      await backend.setPrState(task.id, prState);
    } catch (error) {
      if (!(error instanceof BackendError && error.missingFeature === 'task.pr-state')) throw error;
      log(`WARN PR states not written: ${error.message}`);
      return changed;
    }
    log(`PRSTATE ${task.id} ${prState}`);
    changed += 1;
  }
  return changed;
}

export interface IntakeDeps extends Context {
  github: GitHub;
  now: () => Date;
}

// The plan came from an earlier listing: a task that changed status since (a dispatcher claimed it, say) is left alone.
async function updateIfUnchanged(
  backend: Backend,
  task: Task,
  patch: TaskPatch,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    await backend.updateTask(task.id, { ...patch, expect: task.status });
    return true;
  } catch (error) {
    if (!(error instanceof BackendError && error.status === 409)) throw error;
    log(`SKIP ${task.id} changed since the listing`);
    return false;
  }
}

export async function runIntake(deps: IntakeDeps): Promise<void> {
  const { backend, config, print: log } = deps;
  const agentProblem = intakeAgentProblem(config);
  if (agentProblem !== undefined) throw new ConfigError(`intake creates no tasks: ${agentProblem}`);
  // A failed listing throws before any write: it must not read as an empty queue.
  const { prs, unreadable } = await deps.github.listReviewRequested(Object.keys(config.repos));
  for (const url of unreadable) log(`WARN skipped ${url}`);
  // Closed tasks count too, or a closed task would get a second one.
  const tasks = await backend.listTasks({ all: true });
  const heads = new Map(
    await Promise.all(prs.map(async (pr) => [pr.headSha, await backend.indexHead(pr.headSha)] as const)),
  );
  const actions = planIntake({
    prs,
    unreadable,
    tasks,
    repos: Object.keys(config.repos),
    now: deps.now(),
    headIndex: (sha) => heads.get(sha) ?? sha,
  });

  let created = 0;
  let requeued = 0;
  let done = 0;
  for (const action of actions) {
    if (action.kind === 'close') {
      if (!(await updateIfUnchanged(backend, action.task, { status: 'done', head: null }, log))) continue;
      await backend.addNote(action.task.id, CLOSE_NOTE, { author: 'system' });
      log(`DONE ${action.task.id} its PR no longer asks for the review`);
      done++;
      continue;
    }
    const { pr } = action;
    if (action.kind === 'skip') {
      log(`SKIP #${pr.number} ${action.reason}`);
    } else if (action.kind === 'create') {
      // The PR URL is the key: when the other machine's intake got there first, the board hands back its task.
      const prompt = config.intake.prompt.replaceAll('{url}', pr.url);
      const result = await backend
        .addTask({
          title: `#${pr.number} ${pr.title} (${pr.author})`,
          input: prompt,
          head: pr.headSha,
          status: 'todo',
          priority: config.intake.priority,
          dedupeKey: pr.url,
          createdBy: 'intake',
          ...(config.intake.agent === undefined ? {} : { agent: config.intake.agent }),
        })
        .catch((error: unknown) => {
          // Without the feature the task would run under no agent: it is not created at all.
          if (error instanceof BackendError && error.missingFeature === 'task.agent') {
            return error;
          }
          // The board's task for this PR uses a value this CLI does not know, so list-tasks hid it and add-task dedupes to it.
          if (isVocabularyRefusal(error)) return undefined;
          throw error;
        });
      if (result instanceof BackendError) {
        log(`SKIP #${pr.number} no task created: ${result.message}`);
      } else if (result === undefined) {
        log(`SKIP #${pr.number} its task on the board uses a value this CLI does not know; ${updateCliHint()}`);
      } else if (result.created) {
        log(`CREATED #${pr.number}`);
        created++;
      } else {
        log(`EXISTS #${pr.number} ${result.task.id}`);
      }
    } else {
      // One atomic update: a head changed without the move would leave the task in Needs me for good.
      // A new head is a new review: a fresh session, not a resume of the last one.
      const prompt = config.intake.prompt.replaceAll('{url}', pr.url);
      if (
        !(await updateIfUnchanged(
          backend,
          action.task,
          {
            status: 'todo',
            input: prompt,
            head: pr.headSha,
            next: 'fresh',
            // Intake states itself who made the task, so the new prompt is sealed as intake's.
            seal: { createdBy: 'intake', scheduleId: null, agent: action.task.agent ?? null },
          },
          log,
        ))
      )
        continue;
      const sha = pr.headSha.slice(0, 7);
      const note =
        action.task.head === null
          ? `The PR asks for your review again (head ${sha}). Queued again.`
          : `New head ${sha} on the PR. Queued again.`;
      await backend.addNote(action.task.id, note, { author: 'system' });
      log(`REQUEUED #${pr.number} ${pr.headSha.slice(0, 7)}`);
      requeued++;
    }
  }
  log(`INTAKE prs=${prs.length} created=${created} requeued=${requeued} done=${done}`);
  // Last, so a GitHub problem here never holds back the review work above.
  const prStates = await refreshPrStates(deps, tasks);
  if (prStates > 0) log(`PRSTATES changed=${prStates}`);
}

export async function intakeMain({ dryRun }: { dryRun: boolean }): Promise<void> {
  await skipTickWhileServerOlder(() =>
    runIntake({ ...buildContext(dryRun), print, github: createGitHub(), now: () => new Date() }),
  );
}
