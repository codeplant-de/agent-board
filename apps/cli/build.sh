#!/bin/sh
# Compiles the CLI into one self-contained binary per platform, with the version of package.json built in,
# and writes SHA256SUMS next to them, into dist (or $DIST_DIR). Usage: build.sh [linux-x64 linux-arm64 darwin-arm64]
set -eu
cd "$(dirname "$0")"
version=$(node -p "require('./package.json').version")
targets=${*:-linux-x64 linux-arm64 darwin-arm64}
out=${DIST_DIR:-$PWD/dist}
rm -rf "$out"
mkdir -p "$out"
for target in $targets; do
  # A binary must not pick up a .env or bunfig.toml from whatever directory it is run in.
  bun build src/main.mts --compile --target="bun-$target" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --define "BOARD_VERSION=\"$version\"" --outfile "$out/board-$target"
done
cd "$out"
if command -v sha256sum >/dev/null 2>&1; then sha256sum board-* > SHA256SUMS; else shasum -a 256 board-* > SHA256SUMS; fi
ls -l
