#!/bin/sh
# Installs the newest released board binary.
#   gh release download --repo codeplant-de/agent-board --pattern install.sh -O - | sh
# Needs gh, logged in (the repository is private). BOARD_INSTALL_DIR chooses where `board` goes (default ~/.local/bin).
set -eu

repo=codeplant-de/agent-board
install_dir=${BOARD_INSTALL_DIR:-$HOME/.local/bin}

die() {
  echo "install.sh: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "gh is not installed (https://cli.github.com); install it and run: gh auth login"
gh auth status >/dev/null 2>&1 || die "gh is not logged in; run: gh auth login"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported system $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported processor $(uname -m)" ;;
esac
asset=board-$os-$arch

tags=$(gh release list --repo "$repo" --limit 50 --json tagName,isDraft,isPrerelease \
  --jq '.[] | select(.isDraft | not) | select(.isPrerelease | not) | .tagName') || die "cannot list the releases of $repo"
tag=$(printf '%s\n' "$tags" | grep '^cli-v' | sort -V | tail -1 || true)
[ -n "$tag" ] || die "$repo has no cli-v* release"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh release download "$tag" --repo "$repo" --pattern "$asset" --pattern SHA256SUMS --dir "$tmp" \
  || die "cannot download $asset of $tag"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "SHA256SUMS of $tag does not list $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$actual" = "$expected" ] || die "the downloaded $asset does not match SHA256SUMS; nothing was installed"

mkdir -p "$install_dir"
# Moved into place, so a running board keeps its old file.
cp "$tmp/$asset" "$install_dir/.board-install.$$"
chmod 755 "$install_dir/.board-install.$$"
mv -f "$install_dir/.board-install.$$" "$install_dir/board"
echo "installed board ${tag#cli-v} to $install_dir/board"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "warning: $install_dir is not on your PATH; add it to your shell profile" >&2 ;;
esac

cat <<'NEXT'

Next:
  board init               write web.json, the token and config.json
  board setup --enable     on a worker machine: install and start the timers (Linux)
  board doctor             check everything
NEXT
