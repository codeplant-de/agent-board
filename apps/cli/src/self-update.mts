import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareVersions, isRecord } from '@agent-board/shared';
import { LISTEN_SERVICE } from './setup.mts';
import { SystemError } from './system.mts';
import { errorText } from './text.mts';

export const RELEASE_REPO = 'codeplant-de/agent-board';
const TAG_PREFIX = 'cli-v';
// Releases are x.y.z only: a pre-release tag would rank above its release by number alone.
const RELEASE_TAG = /^cli-v\d+\.\d+\.\d+$/;

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
  // Restarts the listener, which keeps the old code until then; the line to print, if there is one.
  restartListener: () => Promise<string | undefined>;
  print: (line: string) => void;
}

export interface SelfUpdateFlags {
  check?: boolean;
}

const RELEASED_ASSETS = ['board-linux-x64', 'board-linux-arm64', 'board-darwin-arm64'];

export function assetName(platform: string, arch: string): string {
  const name = `board-${platform}-${arch}`;
  if (!RELEASED_ASSETS.includes(name)) throw new SystemError(`there is no released binary for ${platform}-${arch}`);
  return name;
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
      RELEASE_TAG.test(item['tagName']) &&
      item['isDraft'] !== true &&
      item['isPrerelease'] !== true
        ? [{ tag: item['tagName'], version: item['tagName'].slice(TAG_PREFIX.length) }]
        : [],
    )
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

// `timeoutMs` bounds each call, so a stalled download ends before a dispatch tick's own time limit does.
export function realGh(env: Record<string, string | undefined>, timeoutMs?: number): SelfUpdateDeps['gh'] {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'gh',
        args,
        { env, maxBuffer: 16 * 1024 * 1024, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) },
        (error, stdout, stderr) => {
          if (error === null) return resolve(stdout);
          if ('killed' in error && error.killed === true)
            return reject(
              new SystemError(`gh ${args.slice(0, 2).join(' ')} took longer than ${(timeoutMs ?? 0) / 1000} s`),
            );
          if ('code' in error && error.code === 'ENOENT')
            return reject(
              new SystemError('gh is not installed; install it from https://cli.github.com and run "gh auth login"'),
            );
          reject(new SystemError(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.split('\n')[0] || error.message}`));
        },
      );
    });
}

// `try-restart` leaves a listener that is not running alone, and a machine without systemd has none to restart.
// `block: false` returns at once: the dispatcher runs inside the listener's unit, whose stop waits for that dispatcher.
export function realListenerRestart({ block }: { block: boolean }): SelfUpdateDeps['restartListener'] {
  return () =>
    new Promise((resolve) => {
      const args = ['--user', ...(block ? [] : ['--no-block']), 'try-restart', LISTEN_SERVICE];
      execFile('systemctl', args, (error, _stdout, stderr) => {
        if (error === null) return resolve(`restarted ${LISTEN_SERVICE} if it was running, to run the new code`);
        // 5: the unit is not installed, which is a machine that never ran `board setup`.
        if ('code' in error && (error.code === 'ENOENT' || error.code === 5)) return resolve(undefined);
        resolve(
          `could not restart ${LISTEN_SERVICE} (${stderr.split('\n')[0] || error.message}); run "systemctl --user restart agent-board-listen"`,
        );
      });
    });
}

const UPDATE_DIR_PREFIX = 'board-update-';
const STALE_DIR_MS = 60 * 60 * 1000;

// A killed update leaves its download directory behind: remove those of this user that are over an hour old.
export function sweepStaleUpdateDirs(now: Date = new Date(), root: string = tmpdir()): void {
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(UPDATE_DIR_PREFIX)) continue;
      const path = join(root, name);
      const info = lstatSync(path);
      const mine = process.getuid === undefined || info.uid === process.getuid();
      if (info.isDirectory() && mine && now.getTime() - info.mtimeMs > STALE_DIR_MS)
        rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Housekeeping only.
  }
}

export function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === name) return match[1];
  }
  return undefined;
}

// Whether a newer binary replaced this one.
export async function selfUpdate(deps: SelfUpdateDeps, flags: SelfUpdateFlags): Promise<'updated' | 'unchanged'> {
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
  if (compareVersions(newest.version, deps.version) <= 0) {
    deps.print(`board ${deps.version} is the newest release`);
    return 'unchanged';
  }
  if (flags.check) {
    deps.print(`board ${newest.version} is available (this is ${deps.version}); run "board self-update"`);
    return 'unchanged';
  }

  sweepStaleUpdateDirs();
  const dir = mkdtempSync(join(tmpdir(), UPDATE_DIR_PREFIX));
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
    // An unpredictable name, created exclusively, so nobody who can write that directory can plant it first.
    const staged = join(dirname(deps.execPath), `.board-update-${randomBytes(8).toString('hex')}`);
    try {
      writeFileSync(staged, readFileSync(join(dir, asset)), { mode: 0o755, flag: 'wx' });
      chmodSync(staged, 0o755);
      renameSync(staged, deps.execPath);
    } catch (error) {
      rmSync(staged, { force: true });
      throw new SystemError(`cannot replace ${deps.execPath}: ${errorText(error)}`);
    }
    deps.print(`updated board ${deps.version} -> ${newest.version}`);
    const restarted = await deps.restartListener();
    if (restarted !== undefined) deps.print(restarted);
    return 'updated';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
