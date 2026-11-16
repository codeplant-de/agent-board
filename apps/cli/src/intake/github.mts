import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord, parsePrUrl } from '@agent-board/shared';
import type { PrState } from '@agent-board/shared';

// How the client runs `gh`: resolves with stdout, rejects like `execFile` does (the error carries `stdout` and `stderr`).
export type RunCommand = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const runCommand: RunCommand = (file, args) => execFileAsync(file, args, { maxBuffer: 32 * 1024 * 1024 });

export interface LivePr {
  url: string;
  title: string;
  author: string;
  number: number;
  headSha: string;
  headCommittedAt: Date;
  isDraft: boolean;
}

export interface ReviewRequests {
  prs: LivePr[];
  // URLs of listed PRs whose data could not be read. Intake leaves their tasks alone.
  unreadable: string[];
}

export interface GitHub {
  // Open, non-draft PRs in the given repositories that request the user's review.
  listReviewRequested(repos: string[]): Promise<ReviewRequests>;
  // The state of each PR by URL. Throws when a whole query fails.
  prStates(urls: string[]): Promise<PrStateLookup>;
}

export interface PrStateLookup {
  states: Map<string, PrState>;
  // PRs GitHub did not answer for: deleted, or not visible to this login. Their tasks keep the state they have.
  unreadable: string[];
}

export class GitHubError extends Error {}

const PAGE_SIZE = 100;
const PR_STATES_PER_QUERY = 50;
// GraphQL's Int is 32-bit: a larger PR number would fail the whole query.
const MAX_GRAPHQL_INT = 2 ** 31 - 1;
// A listing cut short would read as "these PRs no longer ask for a review", so it fails instead.
const MAX_PAGES = 10;

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        url title number isDraft headRefOid
        author { login }
        commits(last: 1) { nodes { commit { committedDate } } }
      }
    }
  }
}`;

export function searchQuery(repos: string[]): string {
  for (const repo of repos)
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GitHubError(`"${repo}" is not a GitHub repository (owner/name)`);
  return ['is:pr', 'is:open', 'draft:false', 'review-requested:@me', ...repos.map((repo) => `repo:${repo}`)].join(' ');
}

// A node that is not a record, or has no URL, fails the run: nothing says which PR it was.
function parseNode(node: unknown): LivePr | { unreadable: string } {
  if (!isRecord(node) || typeof node['url'] !== 'string')
    throw new GitHubError('unexpected gh output: a search result has no URL');
  const { url, title, number, isDraft, headRefOid, author, commits } = node;
  const lastCommit = isRecord(commits) && Array.isArray(commits['nodes']) ? commits['nodes'].at(-1) : undefined;
  const commit = isRecord(lastCommit) ? lastCommit['commit'] : undefined;
  const committedDate = isRecord(commit) ? commit['committedDate'] : undefined;
  if (
    typeof title !== 'string' ||
    typeof number !== 'number' ||
    typeof isDraft !== 'boolean' ||
    typeof headRefOid !== 'string' ||
    typeof committedDate !== 'string' ||
    Number.isNaN(new Date(committedDate).getTime())
  ) {
    return { unreadable: url };
  }
  // A deleted account has no author.
  const login = isRecord(author) && typeof author['login'] === 'string' ? author['login'] : 'ghost';
  return { url, title, number, isDraft, author: login, headSha: headRefOid, headCommittedAt: new Date(committedDate) };
}

// One page of the search answer: its PRs, the URLs of those it could not read, and where the next page starts.
export function parseSearchPage(value: unknown): ReviewRequests & { next: string | undefined } {
  const search = isRecord(value) && isRecord(value['data']) ? value['data']['search'] : undefined;
  if (!isRecord(search) || !Array.isArray(search['nodes']) || !isRecord(search['pageInfo']))
    throw new GitHubError('unreadable gh search output');
  const { hasNextPage, endCursor } = search['pageInfo'];
  if (typeof hasNextPage !== 'boolean') throw new GitHubError('unreadable gh search output');
  if (hasNextPage && typeof endCursor !== 'string') throw new GitHubError('unreadable gh search output');
  const nodes = search['nodes'].map(parseNode);
  return {
    prs: nodes.filter((node): node is LivePr => 'title' in node),
    unreadable: nodes.flatMap((node) => ('unreadable' in node ? [node.unreadable] : [])),
    next: hasNextPage ? String(endCursor) : undefined,
  };
}

const GRAPHQL_STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

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
    const state = isRecord(pullRequest) ? pullRequest['state'] : undefined;
    const known = typeof state === 'string' && Object.hasOwn(GRAPHQL_STATES, state) ? GRAPHQL_STATES[state] : undefined;
    if (known === undefined) lookup.unreadable.push(url);
    else lookup.states.set(url, known);
  }
  return lookup;
}

async function gh(run: RunCommand, args: string[], { keepAnswerOnError = false } = {}): Promise<unknown> {
  try {
    const { stdout } = await run('gh', args);
    return JSON.parse(stdout);
  } catch (error) {
    // gh exits non-zero when the answer carries errors, such as a repository that is gone, and prints it all the same.
    const answer = keepAnswerOnError && isRecord(error) ? error['stdout'] : undefined;
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

// One search for all repositories. A failed search throws: the caller must not take a partial listing for the whole queue.
export function createGitHub(run: RunCommand = runCommand): GitHub {
  return {
    async listReviewRequested(repos) {
      if (repos.length === 0) return { prs: [], unreadable: [] };
      const query = searchQuery(repos);
      const prs: LivePr[] = [];
      const unreadable: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const found = parseSearchPage(
          await gh(run, [
            'api',
            'graphql',
            '-f',
            `query=${SEARCH}`,
            '-f',
            `q=${query}`,
            ...(after === undefined ? [] : ['-f', `after=${after}`]),
          ]),
        );
        prs.push(...found.prs);
        unreadable.push(...found.unreadable);
        if (found.next === undefined) return { prs, unreadable };
        after = found.next;
      }
      throw new GitHubError(`gh api graphql: more than ${MAX_PAGES * PAGE_SIZE} review requests`);
    },
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
            await gh(
              run,
              [
                'api',
                'graphql',
                '-f',
                `query=${prStatesQuery(chunk.length)}`,
                ...Object.entries(variables).flatMap(([name, value]) => [
                  typeof value === 'number' ? '-F' : '-f',
                  `${name}=${value}`,
                ]),
              ],
              { keepAnswerOnError: true },
            ),
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
