import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_PATTERN } from './config.mts';
import { tryRealpath } from './dirs.mts';

/** Runs `git <args>` in `cwd` and returns its trimmed stdout, or undefined when git is missing, fails or times out. */
export type GitRunner = (cwd: string, args: string[]) => string | undefined;

const GIT_TIMEOUT_MS = 5_000;

export const runGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};

const GITHUB_URL =
  /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/** `owner/name` of a GitHub remote URL (scp-style SSH, https or ssh://), or undefined for any other host or shape. */
export function parseGitHubRepo(url: string): string | undefined {
  const match = GITHUB_URL.exec(url.trim());
  const repo = match === null ? undefined : `${match[1]}/${match[2]}`;
  return repo !== undefined && REPO_PATTERN.test(repo) ? repo : undefined;
}

const REMOTE_NAME = /^[A-Za-z0-9_][\w./-]*$/;

function remoteUrl(path: string, git: GitRunner): string | undefined {
  const head = git(path, ['symbolic-ref', '-q', 'HEAD']);
  const upstream = head ? git(path, ['for-each-ref', '--format=%(upstream:remotename)', head]) : undefined;
  const names = [upstream, 'origin'].filter((name): name is string => name !== undefined && REMOTE_NAME.test(name));
  for (const name of names) {
    const url = git(path, ['remote', 'get-url', name]);
    if (url) return url;
  }
  return undefined;
}

/**
 * The GitHub `owner/name` of the checkout at `path` (a real path), or undefined. Only the top level of a main checkout
 * counts: a subdirectory of a repository or a linked worktree is not "that repository's checkout". The remote is the
 * current branch's upstream's, else `origin`.
 */
export function checkoutRepo(path: string, git: GitRunner = runGit): string | undefined {
  const top = git(path, ['rev-parse', '--show-toplevel']);
  if (!top || tryRealpath(top) !== path) return undefined;
  const dirs = git(path, ['rev-parse', '--git-dir', '--git-common-dir'])?.split('\n');
  if (dirs?.length !== 2) return undefined;
  const [gitDir = '', commonDir = ''] = dirs;
  const real = (dir: string): string => tryRealpath(resolve(path, dir)) ?? resolve(path, dir);
  if (real(gitDir) !== real(commonDir)) return undefined;
  const url = remoteUrl(path, git);
  return url === undefined ? undefined : parseGitHubRepo(url);
}
