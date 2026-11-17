#!/bin/sh
# Review requests to board tasks: a script you run yourself, on a timer (it replaces the removed built-in intake).
#
#   github-reviews.sh owner/name=dir [owner/name=dir ...]
#
# For every open, non-draft PR in those repositories that asks for your review (review-requested:@me) and whose head commit
# is at least 10 minutes old, it runs `board schedule --agent reviewer --key <PR URL> --version <head sha>` in the repository's
# directory `dir` (its checkout on this machine; `~` is expanded, and the directory must be one that `board dirs` lists): the
# board makes one task per PR, bound to this machine and that directory, and a new head sends a task that waits in Needs me or
# is Done back to Todo. A task still waiting in Todo for a PR that no longer asks for the review is moved to Done.
# Needs: gh (logged in), board, a POSIX sh.
#
# Environment:
#   BOARD_AGENT   the agent of this machine's config.json the reviews run as (default: reviewer)
#   KEY_PREFIX    put in front of the PR URL to make the task's key (default: none, the bare URL)
#
# The task of every PR it scheduled is remembered in ${XDG_STATE_HOME:-~/.local/state}/agent-board/github-reviews.tsv (PR URL,
# task id), because the board's keys cannot be read back: that file is how it finds the Todo tasks to close.
#
# Moving from the built-in intake, which was removed: delete the `intake` key from config.json (doctor fails on it). Tasks it made
# without an agent no longer run (they fail with a note): close them. They have the same key (the bare URL) as this script
# uses, so it answers `exists (other-agent)` for their PRs and never reviews them again, and closing them does not help (a
# closed key stays closed): set KEY_PREFIX=github-review: to start with new keys, which reviews every PR that is open now once
# more. Tasks it made with `intake.agent` requeue like this script's own.
set -u

agent=${BOARD_AGENT:-reviewer}
key_prefix=${KEY_PREFIX-}
settle_seconds=600

if [ "$#" -eq 0 ]; then
  echo "usage: $0 owner/name=dir [owner/name=dir ...]" >&2
  exit 2
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/github-reviews.XXXXXX") || exit 1
tab=$(printf '\t')
newline='
'
refuse() {
  echo "github-reviews: $*" >&2
  rm -rf "$work"
  exit 2
}
# One line per repository: the repository, a tab, its directory.
: >"$work/repos"
for arg in "$@"; do
  case $arg in
    *=*) repo=${arg%%=*} dir=${arg#*=} ;;
    *) refuse "'$arg' is not owner/name=dir" ;;
  esac
  case $repo in
    */*/* | */ | /* | *[!A-Za-z0-9_./-]*) refuse "'$repo' is not a GitHub repository (owner/name)" ;;
    */*) ;;
    *) refuse "'$repo' is not a GitHub repository (owner/name)" ;;
  esac
  # shellcheck disable=SC2088 # the pattern is the literal text "~/"
  case $dir in
    '~') dir=$HOME ;;
    '~/'*) dir=$HOME/${dir#'~/'} ;;
  esac
  case $dir in
    '' | *"$tab"* | *"$newline"*) refuse "the directory of $repo is empty or has a tab or newline in it" ;;
  esac
  [ -d "$dir" ] || refuse "'$dir' (for $repo) is not a directory"
  printf '%s%s%s\n' "$repo" "$tab" "$dir" >>"$work/repos"
done
for tool in gh board; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "github-reviews: $tool is not installed or not on PATH" >&2
    rm -rf "$work"
    exit 2
  }
done

state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/agent-board
state=$state_dir/github-reviews.tsv

# A signal ends the script before the state is changed or a task is closed, whatever it was doing.
trap 'rm -rf "$work"; rm -f "$state.new.$$"' EXIT
trap 'exit 1' HUP INT TERM

status=0
log() { printf 'github-reviews: %s\n' "$*"; }
is_number() { case $1 in '' | *[!0-9]*) return 1 ;; esac; }
is_hex() { case $1 in '' | *[!0-9a-f]*) return 1 ;; esac; }

search="is:pr is:open draft:false review-requested:@me"
while IFS=$tab read -r repo _; do search="$search repo:$repo"; done <"$work/repos"

# One line per PR: URL, number, head sha, commit time in epoch seconds, author and title, with control characters and backslashes
# turned into spaces and runs of spaces cut to one. A field gh could not give is "-". `--paginate` runs the query again for every page.
# shellcheck disable=SC2016 # the query's $variables are GraphQL's
if ! gh api graphql --paginate \
  -f query='query($q: String!, $endCursor: String) {
    search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest {
        url number headRefOid title author { login }
        commits(last: 1) { nodes { commit { committedDate } } }
      } }
    }
  }' \
  -f q="$search" \
  --jq '.data.search.nodes[] | select(.url != null) | [
      .url,
      (.number // "-"),
      (.headRefOid // "-"),
      ((try (.commits.nodes[-1].commit.committedDate | fromdateiso8601) catch null) // "-"),
      ((.author.login // "ghost") | gsub("[\\p{Cc}\\\\]"; " ")),
      ((.title // "") | gsub("[\\p{Cc}\\\\]"; " ") | gsub(" +"; " "))
    ] | @tsv' >"$work/prs.tsv" 2>"$work/gh.err"; then
  log "the search failed, nothing scheduled or closed: $(head -n 1 "$work/gh.err")"
  exit 1
fi

now=$(date +%s)
: >"$work/listed"
: >"$work/ids"
while IFS=$tab read -r url number sha committed author title; do
  case $url in
    https://github.com/*/*/pull/*[0-9]) ;;
    *) continue ;;
  esac
  # Every PR the search listed counts as still asking, even one that is skipped below: its task is not closed.
  printf '%s\n' "$url" >>"$work/listed"
  if ! is_number "$number" || ! is_hex "$sha" || ! is_number "$committed"; then
    log "skip $url: unreadable"
    continue
  fi
  if [ $((now - committed)) -lt "$settle_seconds" ]; then
    log "skip #$number: head not settled"
    continue
  fi
  repo=${url#https://github.com/}
  repo=${repo%/pull/*}
  dir=$(awk -F'\t' -v repo="$repo" '$1 == repo { print $2; exit }' "$work/repos")
  if [ -z "$dir" ]; then
    log "skip #$number: $repo is not one of the repositories given"
    continue
  fi
  # In the repository's own directory: the task is bound to the directory `board schedule` runs in.
  if out=$({ cd "$dir" && board schedule --agent "$agent" --key "$key_prefix$url" --version "$sha" \
    --title "#$number $title ($author)" --json -- /review-pr "$url" --auto; } 2>"$work/board.err" </dev/null); then
    one=$(printf '%s' "$out" | tr -d '\n')
    id=$(printf '%s' "$one" | sed -n 's/.*"id": *"\([A-Za-z0-9]\{1,16\}\)".*/\1/p')
    result=$(printf '%s' "$one" | sed -n 's/.*"result": *"\([a-z]*\)".*/\1/p')
    reason=$(printf '%s' "$one" | sed -n 's/.*"reason": *"\([a-z-]*\)".*/\1/p')
    log "#$number ${result:-?} ${id:-?}${reason:+ ($reason)}"
    [ -n "$id" ] && printf '%s%s%s\n' "$url" "$tab" "$id" >>"$work/ids"
  else
    log "#$number failed: $(head -n 1 "$work/board.err")"
    status=1
  fi
done <"$work/prs.tsv"

# The tasks this run scheduled, then the ones remembered from earlier runs for the other PRs.
mkdir -p "$state_dir" || exit 1
touch "$state"
cat "$work/ids" "$state" | awk -F'\t' 'NF == 2 && !seen[$1]++' >"$work/known"

# PRs that no longer ask for the review: the Todo task of each is done. Only reached with a complete listing (the search above
# succeeded), and only for the repositories given now. A task that is not in Todo any more (running, answered, done) is left
# alone and forgotten; the PR being listed again remembers it.
: >"$work/keep"
# Todo tasks that start a fresh run; one with `"next": "resume"` was answered, paused or woken, and is left to run.
if board tasks --status todo --json >"$work/todo.json" 2>"$work/board.err" </dev/null &&
  awk '/^  \{/ { id = ""; resume = 0 }
    /^    "id": "/ { id = $0; sub(/^    "id": "/, "", id); sub(/".*/, "", id) }
    /^    "next": "resume"/ { resume = 1 }
    /^  \}/ { if (id != "" && !resume) print id }' "$work/todo.json" >"$work/todo.ids"; then
  can_close=1
else
  can_close=0
  log "cannot list the Todo tasks, nothing closed: $(head -n 1 "$work/board.err")"
  : >"$work/todo.ids"
  status=1
fi
while IFS=$tab read -r url id; do
  repo=${url#https://github.com/}
  repo=${repo%/pull/*}
  in_scope=0
  if awk -F'\t' -v repo="$repo" '$1 == repo { found = 1 } END { exit !found }' "$work/repos"; then in_scope=1; fi
  grep -qxF "$url" "$work/listed"
  listed=$?
  # A grep that failed says nothing about the PR: stop before anything is closed on a guess.
  [ "$listed" -le 1 ] || exit 1
  if [ "$can_close" -eq 0 ] || [ "$listed" -eq 0 ] || [ "$in_scope" -eq 0 ]; then
    printf '%s%s%s\n' "$url" "$tab" "$id" >>"$work/keep"
    continue
  fi
  grep -qxF "$id" "$work/todo.ids"
  waiting=$?
  [ "$waiting" -le 1 ] || exit 1
  [ "$waiting" -eq 0 ] || continue
  board move "$id" "done" --expect todo >/dev/null 2>"$work/board.err" </dev/null
  case $? in
    0) log "done $id: $url no longer asks for the review" ;;
    3) log "skip $id: it left Todo since the listing" ;;
    *)
      log "cannot move $id to done: $(head -n 1 "$work/board.err")"
      status=1
      printf '%s%s%s\n' "$url" "$tab" "$id" >>"$work/keep"
      ;;
  esac
done <"$work/known"
cp "$work/keep" "$state.new.$$" && mv "$state.new.$$" "$state"

exit "$status"
