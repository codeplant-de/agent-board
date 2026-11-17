// The state of the PR of every open task (merged, closed, open), looked up on GitHub and written to the task for the board:
// it drives the merged icon and "Move merged to Done". The dispatcher runs it at most every PR_REFRESH_INTERVAL_MS.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, prsOf } from '@agent-board/shared';
import type { Backend, PrStates, Task } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { GitHubError } from './github.mts';
import type { GitHub, PrStateLookup } from './github.mts';
import { errorText } from '../output/text.mts';

export const PR_REFRESH_INTERVAL_MS = 10 * 60_000;

/** The PRs of the tasks still on the board whose state to look up, each URL once. */
export function prsToCheck(tasks: Task[]): string[] {
  const urls = tasks.filter(isOnBoard).flatMap((task) => prsOf(task).map(({ url }) => url));
  return [...new Set(urls)];
}

const isOnBoard = (task: Task): boolean => !task.closed && task.status !== 'done';

/** What to write to each task whose stored states differ from what GitHub says; a PR GitHub did not answer for changes nothing. */
export function planPrStates(tasks: Task[], lookup: PrStateLookup): { task: Task; states: PrStates }[] {
  return tasks.filter(isOnBoard).flatMap((task) => {
    const changed = prsOf(task).flatMap((pr) => {
      const state = lookup.states.get(pr.url);
      return state === undefined || state === pr.state ? [] : [{ id: pr.id, state }];
    });
    if (changed.length === 0) return [];
    const prompt = changed.find(({ id }) => id === undefined);
    const prs = changed.flatMap(({ id, state }) => (id === undefined ? [] : [{ id, state }]));
    return [
      {
        task,
        states: { ...(prompt === undefined ? {} : { prompt: prompt.state }), ...(prs.length === 0 ? {} : { prs }) },
      },
    ];
  });
}

export async function refreshPrStates(
  { backend, github, print: log }: { backend: Backend; github: GitHub; print: (line: string) => void },
  tasks: Task[],
): Promise<number> {
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
  for (const { task, states } of planPrStates(tasks, lookup)) {
    try {
      await backend.setPrStates(task.id, states);
    } catch (error) {
      if (!(error instanceof BackendError && error.missingFeature === 'task.pr-state')) throw error;
      log(`WARN PR states not written: ${error.message}`);
      return changed;
    }
    log(
      `PRSTATE ${task.id} ${[states.prompt, ...(states.prs ?? []).map(({ state }) => state)].filter(Boolean).join(' ')}`,
    );
    changed += 1;
  }
  return changed;
}

export interface PrRefreshState {
  // When the states were last looked up.
  refreshedAt(): Date | undefined;
  markRefreshed(at: Date): void;
}

export function prRefreshFile(stateDir: string): string {
  return join(stateDir, 'pr-refresh.json');
}

// One small JSON file; it is a rate limit, so no failure to read or write it is ever an error.
export function createPrRefreshState(path: string): PrRefreshState {
  return {
    refreshedAt() {
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const at = isRecord(raw) && typeof raw['at'] === 'string' ? new Date(raw['at']) : undefined;
        return at === undefined || Number.isNaN(at.getTime()) ? undefined : at;
      } catch {
        return undefined;
      }
    },
    markRefreshed(at) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify({ at: at.toISOString() })}\n`);
      } catch {
        // The next tick looks again.
      }
    },
  };
}

export interface PrRefreshDeps {
  backend: Backend;
  // Undefined when `gh` is not installed here: nothing is looked up, and nothing logged.
  github: GitHub | undefined;
  state: PrRefreshState;
  now: () => Date;
  dryRun: boolean;
  print: (line: string) => void;
}

// Looks the states up when the last lookup is older than PR_REFRESH_INTERVAL_MS. The time is taken before the lookup, so a
// failing `gh` is not retried every tick. Never throws: a failure costs one log line.
export async function refreshPrStatesIfDue(deps: PrRefreshDeps, tasks: Task[]): Promise<void> {
  const { github, state, print: log } = deps;
  if (github === undefined || prsToCheck(tasks).length === 0) return;
  const now = deps.now();
  const last = state.refreshedAt();
  if (last !== undefined && now.getTime() - last.getTime() < PR_REFRESH_INTERVAL_MS) return;
  if (!deps.dryRun) state.markRefreshed(now);
  try {
    const changed = await refreshPrStates({ backend: deps.backend, github, print: log }, tasks);
    if (changed > 0) log(`PRSTATES changed=${changed}`);
  } catch (error) {
    log(`WARN PR states not refreshed: ${errorText(error)}`);
  }
}
