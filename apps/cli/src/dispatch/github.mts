import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord, parsePrUrl } from '@agent-board/shared';
import type { PrState } from '@agent-board/shared';

// How the client runs `gh`: resolves with stdout, rejects like `execFile` does (the error carries `stdout` and `stderr`).
export type RunCommand = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const execRunner =
  (timeoutMs: number | undefined): RunCommand =>
  (file, args) =>
    execFileAsync(file, args, {
      maxBuffer: 32 * 1024 * 1024,
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    });

export interface GitHub {
  // The state of each PR by URL. Throws when a whole query fails.
  prStates(urls: string[]): Promise<PrStateLookup>;
}

export interface PrStateLookup {
  states: Map<string, PrState>;
  // PRs GitHub did not answer for: deleted, or not visible to this login. Their tasks keep the state they have.
  unreadable: string[];
}

export class GitHubError extends Error {}

const PR_STATES_PER_QUERY = 50;
// GraphQL's Int is 32-bit: a larger PR number would fail the whole query.
const MAX_GRAPHQL_INT = 2 ** 31 - 1;

const GH_STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** The state GitHub names (`OPEN`, `MERGED`, `CLOSED`, as GraphQL and `gh pr view --json state` print it), or undefined. */
export function prStateOf(state: unknown): PrState | undefined {
  return typeof state === 'string' && Object.hasOwn(GH_STATES, state) ? GH_STATES[state] : undefined;
}

const alias = (index: number): string => `p${index}`;

// One query for several PRs: an alias per PR, its owner, name and number passed as variables.
export function prStatesQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((i) => `$o${i}: String!, $n${i}: String!, $k${i}: Int!`).join(', ');
  const fields = indexes
    .map((i) => `${alias(i)}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $k${i}) { state } }`)
    .join('\n  ');
  return `query(${variables}) {\n  ${fields}\n}`;
}

// The variables of that query, or undefined for a URL that is not a PR of a repository GitHub could have.
export function prStatesVariables(urls: string[]): Record<string, string | number> | undefined {
  const variables: Record<string, string | number> = {};
  for (const [index, url] of urls.entries()) {
    const parsed = parsePrUrl(url);
    const [owner, name] = parsed?.repo.split('/') ?? [];
    if (
      !parsed ||
      parsed.number > MAX_GRAPHQL_INT ||
      !owner ||
      !name ||
      !/^[\w.-]+$/.test(owner) ||
      !/^[\w.-]+$/.test(name)
    )
      return undefined;
    Object.assign(variables, { [`o${index}`]: owner, [`n${index}`]: name, [`k${index}`]: parsed.number });
  }
  return variables;
}

// The answer to that query for `urls`: the state of each PR it found. A repository or PR it did not find is null in the
// answer, with an error beside it, and comes back as unreadable.
export function parsePrStates(value: unknown, urls: string[]): PrStateLookup {
  const data = isRecord(value) ? value['data'] : undefined;
  if (!isRecord(data)) throw new GitHubError('unreadable gh pull request state output');
  const lookup: PrStateLookup = { states: new Map(), unreadable: [] };
  for (const [index, url] of urls.entries()) {
    const repository = data[alias(index)];
    const pullRequest = isRecord(repository) ? repository['pullRequest'] : undefined;
    const known = prStateOf(isRecord(pullRequest) ? pullRequest['state'] : undefined);
    if (known === undefined) lookup.unreadable.push(url);
    else lookup.states.set(url, known);
  }
  return lookup;
}

async function gh(run: RunCommand, args: string[]): Promise<unknown> {
  try {
    const { stdout } = await run('gh', args);
    return JSON.parse(stdout);
  } catch (error) {
    // gh exits non-zero when the answer carries errors, such as a repository that is gone, and prints it all the same.
    const answer = isRecord(error) ? error['stdout'] : undefined;
    if (typeof answer === 'string') {
      try {
        const parsed: unknown = JSON.parse(answer);
        if (isRecord(parsed) && isRecord(parsed['data'])) return parsed;
      } catch {
        // Not an answer: reported below like any other failure.
      }
    }
    const stderr = isRecord(error) && typeof error['stderr'] === 'string' ? error['stderr'].trim() : '';
    const first = (stderr || (error instanceof Error ? error.message : 'unknown error')).split('\n')[0];
    throw new GitHubError(`gh ${args.slice(0, 2).join(' ')} failed: ${first}`);
  }
}

// `timeoutMs` ends a `gh` call that takes longer (with the default runner), which then fails like any other.
export function createGitHub(run?: RunCommand, { timeoutMs }: { timeoutMs?: number } = {}): GitHub {
  const exec = run ?? execRunner(timeoutMs);
  return {
    async prStates(urls) {
      const queryable = urls.filter((url) => prStatesVariables([url]) !== undefined);
      const lookup: PrStateLookup = { states: new Map(), unreadable: urls.filter((url) => !queryable.includes(url)) };
      let answered = 0;
      let failure: GitHubError | undefined;
      for (let start = 0; start < queryable.length; start += PR_STATES_PER_QUERY) {
        const chunk = queryable.slice(start, start + PR_STATES_PER_QUERY);
        const variables = prStatesVariables(chunk) ?? {};
        try {
          const found = parsePrStates(
            await gh(exec, [
              'api',
              'graphql',
              '-f',
              `query=${prStatesQuery(chunk.length)}`,
              ...Object.entries(variables).flatMap(([name, value]) => [
                typeof value === 'number' ? '-F' : '-f',
                `${name}=${value}`,
              ]),
            ]),
            chunk,
          );
          for (const [url, state] of found.states) lookup.states.set(url, state);
          lookup.unreadable.push(...found.unreadable);
          answered += 1;
        } catch (error) {
          if (!(error instanceof GitHubError)) throw error;
          failure ??= error;
          lookup.unreadable.push(...chunk);
        }
      }
      // Every query failing is an outage to report; a few failing leave their PRs without a state.
      if (failure !== undefined && answered === 0) throw failure;
      return lookup;
    },
  };
}
