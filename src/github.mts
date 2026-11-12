import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export interface GitHub {
  listReviewRequested(): Promise<LivePr[]>;
}

export class GitHubError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePrView(url: string, value: unknown): LivePr {
  if (!isRecord(value)) throw new GitHubError(`unreadable gh output for ${url}`);
  const { headRefOid, title, number, isDraft, author, commits } = value;
  const lastCommit = Array.isArray(commits) ? commits.at(-1) : undefined;
  const committedDate = isRecord(lastCommit) ? lastCommit["committedDate"] : undefined;
  if (
    typeof headRefOid !== "string" ||
    typeof title !== "string" ||
    typeof number !== "number" ||
    typeof isDraft !== "boolean" ||
    !isRecord(author) ||
    typeof author["login"] !== "string" ||
    typeof committedDate !== "string"
  ) {
    throw new GitHubError(`unexpected gh output for ${url}`);
  }
  return { url, title, number, isDraft, author: author["login"], headSha: headRefOid, headCommittedAt: new Date(committedDate) };
}

async function gh(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await run("gh", args, { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const first = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    throw new GitHubError(`gh ${args.slice(0, 2).join(" ")} failed: ${first}`);
  }
}

export function createGitHub(): GitHub {
  return {
    async listReviewRequested() {
      const found = await gh(["search", "prs", "--review-requested=@me", "--state=open", "--json", "url", "--limit", "50"]);
      if (!Array.isArray(found)) throw new GitHubError("unreadable gh search output");
      const prs: LivePr[] = [];
      for (const item of found) {
        const url = isRecord(item) ? item["url"] : undefined;
        if (typeof url !== "string") throw new GitHubError("unreadable gh search output");
        prs.push(parsePrView(url, await gh(["pr", "view", url, "--json", "headRefOid,isDraft,title,number,author,commits"])));
      }
      return prs;
    },
  };
}
