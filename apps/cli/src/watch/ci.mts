// The ci source: a PR's checks, read with `gh pr view` and `gh pr checks`. What to make of what gh said is a pure function.
import { isRecord } from '@agent-board/shared';
import { shellQuote } from '../output/text.mts';
import type { WatchSource } from './store.mts';

export type CiSource = Extract<WatchSource, { kind: 'ci' }>;

// A PR may have its checks registered a little after its commit lands; without any for this long the watch gives up.
export const NO_CHECKS_GRACE_MS = 3 * 60_000;

// What one gh call came to.
export interface GhOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CiInput {
  source: CiSource;
  now: Date;
  // `gh pr view <pr> --json url,headRefOid,state`.
  view: GhOutput;
  // `gh pr checks <pr> [--required] --json name,bucket,link`; absent when the PR is not open, so nothing was asked.
  checks?: GhOutput;
}

export type CiDecision =
  // The watch ends with this text.
  | { kind: 'event'; text: string; source: CiSource }
  | { kind: 'pending'; summary: string; source: CiSource }
  // gh could not tell (auth, an unknown PR, the network).
  | { kind: 'error'; reason: string };

export const ciViewCommand = (pr: string): string => `gh pr view ${shellQuote(pr)} --json url,headRefOid,state`;

export const ciChecksCommand = (pr: string, required: boolean): string =>
  `gh pr checks ${shellQuote(pr)}${required ? ' --required' : ''} --json name,bucket,link`;

/** Whether `gh pr view` found an open PR: only then are its checks worth asking for. */
export function isViewOpen(view: GhOutput): boolean {
  try {
    const info: unknown = JSON.parse(view.stdout);
    return view.exitCode === 0 && isRecord(info) && info['state'] === 'OPEN';
  } catch {
    return false;
  }
}

const NO_CHECKS = /no (required )?checks reported/;
const COMMIT = /^[0-9a-f]{40}$/;

interface Check {
  name: string;
  bucket: string;
  link: string;
}

export function firstLine(text: string, fallback: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? fallback
  );
}

function parseChecks(stdout: string): Check[] | undefined {
  if (stdout.trim() === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(isRecord).map((entry) => ({
    name: typeof entry['name'] === 'string' ? entry['name'] : '?',
    bucket: typeof entry['bucket'] === 'string' ? entry['bucket'] : '',
    link: typeof entry['link'] === 'string' ? entry['link'] : '',
  }));
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

function describeCheck(label: string, { name, link }: Check): string {
  return `${label}: ${name}${link === '' ? '' : ` ${link}`}`;
}

/**
 * What a PR's checks say. A merged or closed PR ends the watch; a new head commit starts it over on that commit; any failed or
 * cancelled check ends it at once; every check passing ends it; anything else keeps it pending. A PR without checks is given
 * three minutes after its head was first seen, then the watch ends. Names and links in the text are the repository's own and
 * not to be trusted: the caller sanitizes the text.
 */
export function decideCi({ source, now, view, checks }: CiInput): CiDecision {
  if (view.exitCode !== 0) return { kind: 'error', reason: firstLine(view.stderr, 'gh pr view failed') };
  let info: unknown;
  try {
    info = JSON.parse(view.stdout);
  } catch {
    return { kind: 'error', reason: 'gh pr view printed something that is not JSON' };
  }
  if (!isRecord(info)) return { kind: 'error', reason: 'gh pr view printed something unexpected' };
  const { url, headRefOid, state } = info;
  if (
    typeof url !== 'string' ||
    typeof state !== 'string' ||
    typeof headRefOid !== 'string' ||
    !COMMIT.test(headRefOid)
  )
    return { kind: 'error', reason: 'gh pr view did not name the PR, its state and its head commit' };
  if (state === 'MERGED' || state === 'CLOSED')
    return { kind: 'event', text: `PR ${url} was ${state === 'MERGED' ? 'merged' : 'closed'}.`, source };

  const nowIso = now.toISOString();
  const headChanged = source.head !== headRefOid;
  const watched: CiSource = {
    ...source,
    head: headRefOid,
    headSince: headChanged && source.head !== undefined ? nowIso : (source.headSince ?? nowIso),
  };
  const sha = headRefOid.slice(0, 7);
  if (checks === undefined) return { kind: 'error', reason: 'the checks were not asked for' };

  const noChecks =
    (checks.exitCode === 1 && NO_CHECKS.test(checks.stderr)) ||
    (checks.exitCode === 0 && parseChecks(checks.stdout)?.length === 0);
  if (noChecks) {
    const since = Date.parse(watched.headSince ?? nowIso);
    if (now.getTime() - since < NO_CHECKS_GRACE_MS)
      return { kind: 'pending', summary: `no checks reported on ${sha} yet`, source: watched };
    return { kind: 'event', text: `No checks appeared on ${url} at ${sha} within 3 minutes.`, source: watched };
  }
  if (checks.exitCode !== 0) return { kind: 'error', reason: firstLine(checks.stderr, 'gh pr checks failed') };
  const list = parseChecks(checks.stdout);
  if (list === undefined) return { kind: 'error', reason: 'gh pr checks printed something that is not JSON' };

  const failed = list.filter(({ bucket }) => bucket === 'fail');
  const cancelled = list.filter(({ bucket }) => bucket === 'cancel');
  const passed = list.filter(({ bucket }) => bucket === 'pass').length;
  const skipped = list.filter(({ bucket }) => bucket === 'skipping').length;
  const running = list.length - failed.length - cancelled.length - passed - skipped;
  const base = `CI on ${url} at ${sha}`;
  if (failed.length + cancelled.length > 0) {
    const lines = [
      `${base} failed.`,
      ...failed.map((check) => describeCheck('failed', check)),
      ...cancelled.map((check) => describeCheck('cancelled', check)),
      `still running: ${running}, passed: ${passed}${skipped > 0 ? `, skipped: ${skipped}` : ''}`,
    ];
    return { kind: 'event', text: lines.join('\n'), source: watched };
  }
  if (running > 0)
    return { kind: 'pending', summary: `${passed} of ${list.length} passed, ${running} running`, source: watched };
  if (passed === 0) return { kind: 'event', text: `${base}: every check was skipped.`, source: watched };
  const skippedNote = skipped > 0 ? `, ${skipped} skipped` : '';
  return { kind: 'event', text: `${base} passed: ${plural(passed, 'check')} passed${skippedNote}.`, source: watched };
}
