#!/bin/sh
# Compares the newest released CLI (the newest strict cli-v<x.y.z> tag) with MIN_CLIENT at HEAD
# (packages/shared/src/contract.mts), the oldest client break level the server serves. Only a breaking change raises it:
# an additive one adds a feature name (docs/machine-api.md#features) and leaves this script, and the CLI version, alone.
#
#   check-cli-release.sh                the pull request rule: if the newest release is below MIN_CLIENT, the CLI version
#                                       in apps/cli/package.json must be above the newest tag; otherwise it passes
#   check-cli-release.sh release-behind exits 0 if the newest release is below MIN_CLIENT (or there is no release): the
#                                       break is declared and the release cannot be tested against this server; 1 if not
#
# The break level of a release is its API_VERSION, or its CONTRACT_VERSION before CLI 0.8.0 (0.7.0 and older). Everything is read from
# git (the tag and HEAD), so the tags must be fetched.
set -eu

mode=check
[ "${1:-}" != release-behind ] || mode=behind
contract=packages/shared/src/contract.mts
package=apps/cli/package.json

head_min=$(git show "HEAD:$contract" 2>/dev/null | sed -n 's/^export const MIN_CLIENT = \([0-9][0-9]*\);.*/\1/p' | head -n 1)
if [ -z "$head_min" ]; then
  echo "check-cli-release: no 'export const MIN_CLIENT = <number>;' line in $contract at HEAD" >&2
  exit 2
fi

newest=$(git tag --list 'cli-v*' | grep -E '^cli-v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^cli-v//' | sort -V | tail -n 1)
if [ -z "$newest" ]; then
  echo "no cli-v* tag: there is no release to compare with."
  exit 0
fi

released_api=$(git show "cli-v$newest:$contract" 2>/dev/null | sed -nE 's/^export const (API_VERSION|CONTRACT_VERSION) = ([0-9]+);.*/\2/p' | head -n 1)
if [ -z "$released_api" ]; then
  echo "check-cli-release: no API_VERSION or CONTRACT_VERSION in $contract at cli-v$newest" >&2
  exit 2
fi

behind=
[ "$released_api" -ge "$head_min" ] || behind=1

if [ "$mode" = behind ]; then
  [ -n "$behind" ]
  exit $?
fi

if [ -z "$behind" ]; then
  echo "The newest release cli-v$newest speaks API $released_api, MIN_CLIENT is $head_min: it is still served."
  exit 0
fi

version=$(git show "HEAD:$package" | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -n 1)
if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "check-cli-release: $package version \"$version\" is not x.y.z" >&2
  exit 2
fi
highest=$(printf '%s\n%s\n' "$newest" "$version" | sort -V | tail -n 1)
if [ "$version" = "$newest" ] || [ "$highest" != "$version" ]; then
  cat >&2 <<MESSAGE
MIN_CLIENT is $head_min, but the newest release cli-v$newest speaks API $released_api, so it stops working against this
server. apps/cli/package.json is at $version, not above that release. Raise the CLI version there: CI releases it from
main after the merge, and the rollout order is the "Upgrading" list in docs/setup.md.
MESSAGE
  exit 1
fi
echo "MIN_CLIENT is $head_min and the newest release cli-v$newest speaks API $released_api; the CLI version $version is above it."
