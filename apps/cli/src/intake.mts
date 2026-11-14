#!/usr/bin/env node
/**
 * Review requests to tasks: one task per PR URL, checked against every task, closed ones included.
 * A task in Needs me or Done goes back to Todo when the PR's head moved and has settled. A task still waiting in Todo
 * for a PR that no longer asks for the review is done, without a head, and comes back when the PR is listed again.
 * A PR whose data cannot be read is skipped and its task left alone.
 * Add --dry-run to read everything and print every write instead.
 */
import { buildContext, print, rejectExtraArgs, runMain, takeFlag } from './cli.mts';
import type { Context } from './cli.mts';
import type { Backend, Task, TaskPatch } from '@agent-board/shared';
import { parsePrUrl, prUrlIn, promptSkill } from '@agent-board/shared';
import { BackendError } from './backend.mts';
import { createGitHub } from './github.mts';
import type { GitHub, LivePr } from './github.mts';

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
    if (task.head === null || task.head === pr.headSha) return { kind: 'skip', pr, reason: 'task exists' };
    if (task.status !== 'needs-me' && task.status !== 'done')
      return { kind: 'skip', pr, reason: `head moved, task is ${task.status}` };
    return settled ? { kind: 'requeue', pr, task } : { kind: 'skip', pr, reason: 'head moved, not settled' };
  });
  return [...actions, ...gone.map((task): IntakeAction => ({ kind: 'close', task }))];
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
  // A failed listing throws before any write: it must not read as an empty queue.
  const { prs, unreadable } = await deps.github.listReviewRequested(Object.keys(config.repos));
  for (const url of unreadable) log(`WARN skipped ${url}`);
  // Closed tasks count too, or a closed task would get a second one.
  const tasks = await backend.listTasks({ all: true });
  const actions = planIntake({ prs, unreadable, tasks, repos: Object.keys(config.repos), now: deps.now() });

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
      const result = await backend.addTask({
        title: `#${pr.number} ${pr.title} (${pr.author})`,
        input: prompt,
        head: pr.headSha,
        labels: [promptSkill(prompt) ?? 'review'],
        status: 'todo',
        priority: config.intake.priority,
        dedupeKey: pr.url,
        createdBy: 'intake',
      });
      if (result.created) {
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
          { status: 'todo', input: prompt, head: pr.headSha, next: 'fresh' },
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
}

if (import.meta.main) {
  await runMain(async () => {
    const args = process.argv.slice(2);
    const dryRun = takeFlag(args, '--dry-run');
    rejectExtraArgs(args, 'usage: intake [--dry-run]');
    await runIntake({ ...buildContext(dryRun), print, github: createGitHub(), now: () => new Date() });
  });
}
