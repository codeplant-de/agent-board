import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeRelease {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  // Asset name to content; SHA256SUMS is written from them unless given.
  assets?: Record<string, string>;
  sums?: string;
}

export interface FakeGh {
  dir: string;
  // The environment that puts the fake `gh` first on PATH.
  env: Record<string, string>;
  loggedOut: () => void;
}

export const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

// A `gh` that answers auth status, release list and release download from a directory, for tests of self-update and install.sh.
export function fakeGh(releases: FakeRelease[]): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), 'board-fake-gh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(dir, 'releases.json'),
    JSON.stringify(
      releases.map((release) => ({
        tagName: release.tag,
        isDraft: release.draft === true,
        isPrerelease: release.prerelease === true,
      })),
    ),
  );
  for (const release of releases) {
    mkdirSync(join(dir, 'assets', release.tag), { recursive: true });
    const assets = release.assets ?? {};
    for (const [name, content] of Object.entries(assets))
      writeFileSync(join(dir, 'assets', release.tag, name), content);
    const sums =
      release.sums ??
      Object.entries(assets)
        .map(([name, content]) => `${sha256(content)}  ${name}`)
        .join('\n');
    writeFileSync(join(dir, 'assets', release.tag, 'SHA256SUMS'), `${sums}\n`);
  }
  const script = `#!/bin/sh
case "$1 $2" in
  "auth status")
    if [ -e "$FAKE_GH/loggedout" ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi
    exit 0 ;;
  "release list")
    if [ "$FAKE_GH_JQ" = tags ]; then
      sed -e 's/},{/}\\n{/g' "$FAKE_GH/releases.json" | grep '"isDraft":false,"isPrerelease":false' | sed -e 's/.*"tagName":"\\([^"]*\\)".*/\\1/'
    else
      cat "$FAKE_GH/releases.json"
    fi ;;
  "release download")
    tag=$3; target=; patterns=; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --dir) target=$2; shift 2 ;;
        --pattern) patterns="$patterns $2"; shift 2 ;;
        *) shift ;;
      esac
    done
    for pattern in $patterns; do cp "$FAKE_GH/assets/$tag/$pattern" "$target/$pattern" || exit 1; done ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`;
  writeFileSync(join(bin, 'gh'), script);
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_GH: dir },
    loggedOut: () => writeFileSync(join(dir, 'loggedout'), ''),
  };
}
