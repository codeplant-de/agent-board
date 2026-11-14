#!/usr/bin/env node
/**
 * Review requests to tasks: one task per PR URL, checked against every task, closed ones included.
 * A task in Needs me or Done goes back to Todo when the PR's head moved and has settled.
 * Add --dry-run to read everything and print every write instead.
 */
import { buildContext, print, rejectExtraArgs, runMain, takeFlag } from './cli.mts';
import type { Context } from './cli.mts';
import type { Task } from '@agent-board/shared';
import { promptSkill } from '@agent-board/shared';
import { formatIntakeInput, parseHead, parsePrUrl, prUrlIn } from './decide.mts';
import { createGitHub } from './github.mts';
import type { GitHub, LivePr } from './github.mts';

const SETTLE_MS = 10 * 60_000;

export type IntakeAction =
  | { kind: 'create'; pr: LivePr }
  | { kind: 'requeue'; pr: LivePr; task: Task }
  | { kind: 'skip'; pr: LivePr; reason: string };

export function planIntake(input: { prs: LivePr[]; tasks: Task[]; repos: string[]; now: Date }): IntakeAction[] {
  return input.prs.map((pr): IntakeAction => {
    if (pr.isDraft) return { kind: 'skip', pr, reason: 'draft' };
    const repo = parsePrUrl(pr.url)?.repo;
    if (repo === undefined || !input.repos.includes(repo))
      return { kind: 'skip', pr, reason: 'repository not in config' };
    const settled = input.now.getTime() - pr.headCommittedAt.getTime() >= SETTLE_MS;
    const matches = input.tasks.filter((candidate) => prUrlIn(candidate.input) === pr.url);
    const task = matches.find((candidate) => !candidate.closed) ?? matches[0];
    if (task?.closed) return { kind: 'skip', pr, reason: 'task closed' };
    if (!task) return settled ? { kind: 'create', pr } : { kind: 'skip', pr, reason: 'head not settled' };

    const head = parseHead(task.input);
    if (head === undefined || head === pr.headSha) return { kind: 'skip', pr, reason: 'task exists' };
    if (task.status !== 'needs-me' && task.status !== 'done')
      return { kind: 'skip', pr, reason: `head moved, task is ${task.status}` };
    return settled ? { kind: 'requeue', pr, task } : { kind: 'skip', pr, reason: 'head moved, not settled' };
  });
}

export interface IntakeDeps extends Context {
  github: GitHub;
  now: () => Date;
}

export async function runIntake(deps: IntakeDeps): Promise<void> {
  const { backend, config, print: log } = deps;
  // A failed listing throws before any write: it must not read as an empty queue.
  const prs = await deps.github.listReviewRequested(Object.keys(config.repos));
  // Closed tasks count too, or a closed task would get a second one.
  const tasks = await backend.listTasks({ all: true });
  const actions = planIntake({ prs, tasks, repos: Object.keys(config.repos), now: deps.now() });

  let created = 0;
  let requeued = 0;
  for (const action of actions) {
    const { pr } = action;
    if (action.kind === 'skip') {
      log(`SKIP #${pr.number} ${action.reason}`);
    } else if (action.kind === 'create') {
      // The PR URL is the key: when the other machine's intake got there first, the board hands back its task.
      const prompt = config.intake.prompt.replaceAll('{url}', pr.url);
      const result = await backend.addTask({
        title: `#${pr.number} ${pr.title} (${pr.author})`,
        input: formatIntakeInput(prompt, pr.headSha),
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
      // One atomic update: a head line changed without the move would leave the task in Needs me for good.
      // A new head is a new review: a fresh session, not a resume of the last one.
      const prompt = config.intake.prompt.replaceAll('{url}', pr.url);
      await backend.updateTask(action.task.id, {
        status: 'todo',
        input: formatIntakeInput(prompt, pr.headSha),
        next: 'fresh',
      });
      await backend.addNote(action.task.id, `New head ${pr.headSha.slice(0, 7)} on the PR. Queued again.`, {
        author: 'system',
      });
      log(`REQUEUED #${pr.number} ${pr.headSha.slice(0, 7)}`);
      requeued++;
    }
  }
  log(`INTAKE prs=${prs.length} created=${created} requeued=${requeued}`);
}

if (import.meta.main) {
  await runMain(async () => {
    const args = process.argv.slice(2);
    const dryRun = takeFlag(args, '--dry-run');
    rejectExtraArgs(args, 'usage: intake [--dry-run]');
    await runIntake({ ...buildContext(dryRun), print, github: createGitHub(print), now: () => new Date() });
  });
}
