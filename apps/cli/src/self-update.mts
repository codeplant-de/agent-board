import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import { SystemError } from './system.mts';

export const RELEASE_REPO = 'codeplant-de/agent-board';
const TAG_PREFIX = 'cli-v';

export interface SelfUpdateDeps {
  // Whether this is a released binary; a checkout is updated with git.
  compiled: boolean;
  // The release this binary was built as.
  version: string | undefined;
  execPath: string;
  platform: string;
  arch: string;
  // Runs `gh` and returns its stdout.
  gh: (args: string[]) => Promise<string>;
  print: (line: string) => void;
}

export interface SelfUpdateFlags {
  check?: boolean;
}

export function assetName(platform: string, arch: string): string {
  const os = platform === 'linux' || platform === 'darwin' ? platform : undefined;
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : undefined;
  if (os === undefined || cpu === undefined)
    throw new SystemError(`there is no released binary for ${platform}-${arch}`);
  return `board-${os}-${cpu}`;
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// The newest published cli-v* release of `gh release list --json tagName,isDraft,isPrerelease`.
export function newestRelease(listing: string): { tag: string; version: string } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(listing);
  } catch {
    throw new SystemError('gh release list did not return JSON');
  }
  if (!Array.isArray(raw)) throw new SystemError('gh release list did not return a list');
  return raw
    .flatMap((item: unknown) =>
      isRecord(item) &&
      typeof item['tagName'] === 'string' &&
      item['tagName'].startsWith(TAG_PREFIX) &&
      item['isDraft'] !== true &&
      item['isPrerelease'] !== true
        ? [{ tag: item['tagName'], version: item['tagName'].slice(TAG_PREFIX.length) }]
        : [],
    )
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

export function realGh(env: Record<string, string | undefined>): SelfUpdateDeps['gh'] {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('gh', args, { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        if ('code' in error && error.code === 'ENOENT')
          return reject(
            new SystemError('gh is not installed; install it from https://cli.github.com and run "gh auth login"'),
          );
        reject(new SystemError(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.split('\n')[0] || error.message}`));
      });
    });
}

export function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === name) return match[1];
  }
  return undefined;
}

export async function selfUpdate(deps: SelfUpdateDeps, flags: SelfUpdateFlags): Promise<void> {
  if (!deps.compiled || deps.version === undefined)
    throw new SystemError(
      'this board runs from a checkout: update it with "git pull" and "pnpm install", then run apps/cli/install.sh',
    );
  const asset = assetName(deps.platform, deps.arch);
  try {
    await deps.gh(['auth', 'status']);
  } catch (error) {
    if (error instanceof SystemError && error.message.startsWith('gh is not installed')) throw error;
    throw new SystemError('gh is not logged in: run "gh auth login"');
  }
  const newest = newestRelease(
    await deps.gh([
      'release',
      'list',
      '--repo',
      RELEASE_REPO,
      '--limit',
      '50',
      '--json',
      'tagName,isDraft,isPrerelease',
    ]),
  );
  if (newest === undefined) throw new SystemError(`${RELEASE_REPO} has no ${TAG_PREFIX}* release`);
  if (compareVersions(newest.version, deps.version) <= 0)
    return deps.print(`board ${deps.version} is the newest release`);
  if (flags.check)
    return deps.print(`board ${newest.version} is available (this is ${deps.version}); run "board self-update"`);

  const dir = mkdtempSync(join(tmpdir(), 'board-update-'));
  try {
    await deps.gh([
      'release',
      'download',
      newest.tag,
      '--repo',
      RELEASE_REPO,
      '--pattern',
      asset,
      '--pattern',
      'SHA256SUMS',
      '--dir',
      dir,
    ]);
    const expected = checksumOf(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), asset);
    if (expected === undefined) throw new SystemError(`SHA256SUMS of ${newest.tag} does not list ${asset}`);
    const actual = createHash('sha256')
      .update(readFileSync(join(dir, asset)))
      .digest('hex');
    if (actual !== expected)
      throw new SystemError(`the downloaded ${asset} does not match SHA256SUMS; nothing was replaced`);
    // Written beside the running binary, so the rename stays on one file system; a running process keeps its old file.
    const staged = join(dirname(deps.execPath), `.board-update-${process.pid}`);
    try {
      copyFileSync(join(dir, asset), staged);
      chmodSync(staged, 0o755);
      renameSync(staged, deps.execPath);
    } catch (error) {
      rmSync(staged, { force: true });
      throw new SystemError(
        `cannot replace ${deps.execPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    deps.print(`updated board ${deps.version} -> ${newest.version}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
