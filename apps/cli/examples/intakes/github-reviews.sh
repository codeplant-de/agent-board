#!/bin/sh
# Turns the pull requests that ask for your review into board tasks that run /review-pr.
#
# Usage: github-reviews.sh <owner/name>...
#
# Needs `gh` (logged in) and `board`; the jq filter runs inside `gh --jq`. Run it from a timer or cron (see
# docs/usage.md, "Scripts"). Every run:
#   1. lists the open pull requests that request your review in the given repositories;
#   2. creates a task for each (or queues its task again when the head moved) once the head commit is 10 minutes old,
#      so a push in progress does not start a review;
#   3. moves the tasks still waiting in Todo whose pull request no longer asks for your review to Done.
# The pruning is skipped when the listing failed, so a GitHub outage never reads as "nothing is requested any more".
#
# Tasks run restricted, so config.json on the machine needs a `skills.review-pr` profile
# (apps/cli/examples/config.reviews.json has one).
#
# Migrating from the built-in intake: its tasks are stored under the bare pull request URL, so run with
# BOARD_RAW_KEY=1 to key the tasks the same way and keep them instead of creating a second set. A new setup does not
# need it.
set -eu

SOURCE=github-reviews
SKILL=review-pr
SETTLE_SECONDS=600

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <owner/name>..." >&2
  exit 2
fi

search='is:pr is:open draft:false review-requested:@me'
repos=
for repo in "$@"; do
  case "$repo" in
    *[!A-Za-z0-9._/-]* | */*/* | /* | */ | '' | -*)
      echo "$0: \"$repo\" is not a GitHub repository (owner/name)" >&2
      exit 2
      ;;
    */*) ;;
    *)
      echo "$0: \"$repo\" is not a GitHub repository (owner/name)" >&2
      exit 2
      ;;
  esac
  search="$search repo:$repo"
  repos="$repos $repo"
done

# shellcheck disable=SC2016
query='query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        url title number headRefOid
        author { login }
        commits(last: 1) { nodes { commit { committedDate } } }
      }
    }
  }
}'

# One tab-separated row per pull request: url, head sha, settled|young|unreadable, number, author, title.
# A pull request whose data is incomplete is "unreadable": it is neither created nor pruned.
# shellcheck disable=SC2016
filter='def clean: gsub("[\\x00-\\x1f\\x7f]"; " ");
  .data.search.nodes[]
  | select(.url != null)
  | ((.commits.nodes // []) | last | .commit.committedDate? // null) as $at
  | (try ($at | fromdateiso8601) catch null) as $t
  | if (.headRefOid | type) != "string" or (.title | type) != "string" or (.number | type) != "number" or $t == null
    then [.url, "-", "unreadable", "0", "-", "-"]
    else [.url, .headRefOid, (if $t <= now - '"$SETTLE_SECONDS"' then "settled" else "young" end),
          (.number | tostring), (.author.login // "ghost"), (.title | clean)]
    end
  | join("\t")'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# A signal must end the run: carrying on without $work would read every task as no longer listed.
trap 'exit 1' HUP INT TERM

if ! gh api graphql --paginate -f query="$query" -f q="$search" --jq "$filter" >"$work/listing"; then
  echo "$0: could not list the pull requests; nothing created, nothing pruned" >&2
  exit 1
fi

tab=$(printf '\t')
failures=0
raw=
if [ "${BOARD_RAW_KEY:-}" = 1 ]; then raw=--raw-key; fi

: >"$work/urls"
while IFS="$tab" read -r url sha state number author title || [ -n "$url" ]; do
  [ -n "$url" ] || continue
  printf '%s\n' "$url" >>"$work/urls"
  [ "$state" = settled ] || {
    echo "skip $url ($state)"
    continue
  }
  # $raw is empty or one flag, so it is left unquoted.
  # shellcheck disable=SC2086
  if ! board create --source "$SOURCE" $raw --skill "$SKILL" --key "$url" --version "$sha" \
    --title "#$number $title ($author)" -- "$url" --auto </dev/null; then
    failures=$((failures + 1))
  fi
done <"$work/listing"

# The tasks of this source still waiting in Todo, as tab-separated id, source, key and title. Only those of the
# repositories given here: another run of this script may own other repositories.
if ! board tasks --source "$SOURCE" --status todo >"$work/tasks"; then
  echo "$0: could not list the tasks; nothing pruned" >&2
  exit 1
fi
while IFS="$tab" read -r id _source key _title || [ -n "$id" ]; do
  [ -n "$id" ] || continue
  rest=${key#https://github.com/}
  [ "$rest" != "$key" ] || continue
  repo=${rest%%/pull/*}
  case " $repos " in *" $repo "*) ;; *) continue ;; esac
  # grep exits 1 for "not listed" and 2 for an error, which must never read as "not listed".
  if grep -Fxq -- "$key" "$work/urls"; then
    continue
  else
    found=$?
    [ "$found" -eq 1 ] || exit 1
  fi
  if board move "$id" "done" --expect todo --clear-version </dev/null; then
    echo "pruned $id ($key no longer asks for your review)"
  else
    code=$?
    # 3: the task left Todo since the listing, which is the right outcome of a race.
    if [ "$code" -ne 3 ]; then failures=$((failures + 1)); fi
  fi
done <"$work/tasks"

[ "$failures" -eq 0 ] || exit 1
