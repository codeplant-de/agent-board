import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord } from '@agent-board/shared';

const run = promisify(execFile);

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
}

export class GitHubError extends Error {}

const PAGE_SIZE = 100;
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

async function gh(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const first = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    throw new GitHubError(`gh ${args.slice(0, 2).join(' ')} failed: ${first}`);
  }
}

// One search for all repositories. A failed search throws: the caller must not take a partial listing for the whole queue.
export function createGitHub(): GitHub {
  return {
    async listReviewRequested(repos) {
      if (repos.length === 0) return { prs: [], unreadable: [] };
      const query = searchQuery(repos);
      const prs: LivePr[] = [];
      const unreadable: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const found = parseSearchPage(
          await gh([
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
  };
}
