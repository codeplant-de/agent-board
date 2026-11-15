#!/usr/bin/env bash
# worktree.sh: agent-board's git worktree helper.
#
# Subcommands:
#   create <branch> [base-ref]  Create a worktree under <main-repo>/.claude/worktrees/,
#                               branch off base-ref (default: origin/<default branch>
#                               after a fetch), and wire the lightweight symlinks Claude
#                               needs.
#   elevate                     Turn the current lightweight worktree into a full dev
#                               environment (pnpm install).
#   open <pr|branch> [base-ref] [--move]
#                               Find or create the checkout for a PR or branch and print
#                               where to enter it. Used by the /worktree skill.
#   list                        List the main checkout and every worktree, with each
#                               branch's PR when gh is available.
#
# The worktree location is always DERIVED, never chosen: the directory name is the
# branch with '/' replaced by '+', placed under <main-repo>/.claude/worktrees/. This
# is the only supported location. Do not create worktrees anywhere else.
#
# Self-contained: everything a fresh worktree needs is done here, so the skill works
# for anyone who has it, with no local git hook required.

set -euo pipefail

die() { echo "Error: $*" >&2; exit 1; }

resolve_main_repo_root() {
	local common_dir
	common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
		die "Not in a git repository."
	realpath "$common_dir/.."
}

# Wire the symlinks Claude needs to read the codebase and operate normally in a fresh
# worktree. Idempotent: only links what is missing. No node_modules.
wire_lightweight() {
	local main_repo_root="$1" worktree_root="$2"

	# Personal local files, if the main repo has them.
	local rel src dest
	for rel in CLAUDE.local.md .claude/settings.local.json; do
		src="$main_repo_root/$rel"
		dest="$worktree_root/$rel"
		if [[ -e "$src" && ! -e "$dest" && ! -L "$dest" ]]; then
			mkdir -p "$(dirname "$dest")"
			ln -s "$src" "$dest"
		fi
	done

	# .claude/agents and .claude/skills are partially gitignored: some entries live
	# only in the main repo. Link each entry the worktree is missing so Claude sees the
	# same agents and skills here as in the main checkout.
	local parent_rel src_parent dest_parent entry
	for parent_rel in .claude/agents .claude/skills; do
		src_parent="$main_repo_root/$parent_rel"
		[[ -d "$src_parent" ]] || continue
		dest_parent="$worktree_root/$parent_rel"
		mkdir -p "$dest_parent"
		for entry in "$src_parent"/*; do
			[[ -e "$entry" ]] || continue
			dest="$dest_parent/$(basename "$entry")"
			if [[ ! -e "$dest" && ! -L "$dest" ]]; then
				ln -s "$entry" "$dest"
			fi
		done
	done
}

# Warn when an existing branch's upstream is not a branch of its own name, for example one
# created by an older version of this script, which let autoSetupMerge point the new
# branch at the base ref. A bare 'git push'/'git pull' from such a branch targets that
# ref, not the branch. Never rewritten automatically: deliberately stacking a branch on
# another feature branch is a legitimate reason to track a different ref.
warn_mismatched_upstream() {
	local main_repo_root="$1" branch="$2"

	local merge_ref
	merge_ref=$(git -C "$main_repo_root" config --get "branch.$branch.merge" || true)
	[[ -n "$merge_ref" && "$merge_ref" != "refs/heads/$branch" ]] || return 0

	local remote
	remote=$(git -C "$main_repo_root" config --get "branch.$branch.remote" || echo origin)

	echo
	echo "Warning: branch '$branch' tracks '$remote/${merge_ref#refs/heads/}', not a branch of its own name."
	echo "         A bare 'git push' or 'git pull' will target that ref instead of '$branch'."
	echo "         If that is not deliberate, clear it:"
	echo "             git branch --unset-upstream $branch"
}

# Prints the absolute path of the checkout that has <branch> checked out, or nothing.
find_checkout() {
	local main_repo_root="$1" branch="$2"
	git -C "$main_repo_root" worktree list --porcelain | awk -v ref="refs/heads/$branch" '
		/^worktree / { path = substr($0, 10) }
		$0 == "branch " ref { print path; exit }
	'
}

# Fetch the branch's upstream and report how far the checkout has drifted from it. With
# allow_ff=1, fast-forward when the branch is strictly behind and has no tracked changes.
# Never pulls a diverged branch, never resets, never touches a branch whose upstream is not
# a branch of its own name (see warn_mismatched_upstream).
sync_checkout() {
	local checkout="$1" branch="$2" allow_ff="$3"

	local merge_ref remote
	merge_ref=$(git -C "$checkout" config --get "branch.$branch.merge" || true)
	if [[ -z "$merge_ref" ]]; then
		echo "No upstream yet, nothing to sync."
		return 0
	fi
	remote=$(git -C "$checkout" config --get "branch.$branch.remote" || echo origin)
	if [[ "$merge_ref" != "refs/heads/$branch" ]]; then
		echo "Upstream is '$remote/${merge_ref#refs/heads/}', not '$branch'. Not syncing."
		return 0
	fi

	if ! git -C "$checkout" fetch --quiet "$remote" "${merge_ref#refs/heads/}" 2>/dev/null; then
		echo "Could not fetch '$remote/$branch' (offline, or deleted on the remote). Not syncing."
		return 0
	fi

	local ahead behind
	read -r ahead behind < <(git -C "$checkout" rev-list --left-right --count "HEAD...@{upstream}")

	if ((behind == 0)); then
		((ahead == 0)) && echo "Up to date with its upstream." || echo "$ahead commit(s) ahead of its upstream."
	elif ((ahead > 0)); then
		echo "Diverged from its upstream ($ahead ahead, $behind behind). Not syncing."
	elif ((allow_ff == 0)); then
		echo "$behind commit(s) behind its upstream. Left untouched."
	elif [[ -n "$(git -C "$checkout" status --porcelain --untracked-files=no)" ]]; then
		echo "$behind commit(s) behind its upstream, but has uncommitted changes. Not fast-forwarding."
	elif git -C "$checkout" merge --ff-only --quiet "@{upstream}"; then
		echo "Fast-forwarded $behind commit(s) from its upstream."
	else
		echo "$behind commit(s) behind its upstream, but the fast-forward failed (see above). Left untouched."
	fi
}

# The branch new worktrees are based on: origin's default branch if the clone knows it,
# else main.
default_branch() {
	local main_repo_root="$1" ref
	ref=$(git -C "$main_repo_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)
	echo "${ref#origin/}"
}

# The last two lines of 'open' are the machine-readable result the /worktree skill acts on.
print_result() {
	echo
	echo "RESULT=$1"
	echo "PATH=$2"
}

cmd_open() {
	local target="" base="" move=0 arg
	for arg in "$@"; do
		case "$arg" in
		--move) move=1 ;;
		*)
			if [[ -z "$target" ]]; then target="$arg"
			elif [[ -z "$base" ]]; then base="$arg"
			else die "Usage: scripts/worktree.sh open <pr|branch> [base-ref] [--move]"
			fi
			;;
		esac
	done
	[[ -n "$target" ]] || die "Usage: scripts/worktree.sh open <pr|branch> [base-ref] [--move]"

	local main_repo_root
	main_repo_root=$(resolve_main_repo_root)

	local branch pr="" pr_repo=""
	if [[ "$target" =~ ^#?([0-9]+)$ ]]; then
		pr="${BASH_REMATCH[1]}"
	elif [[ "$target" =~ ^https://github\.com/([^/]+/[^/]+)/pull/([0-9]+) ]]; then
		pr_repo="${BASH_REMATCH[1]}"
		pr="${BASH_REMATCH[2]}"
	fi

	if [[ -n "$pr" ]]; then
		command -v gh >/dev/null 2>&1 || die "gh not found on PATH, so PR #$pr cannot be resolved to a branch."
		if [[ -n "$pr_repo" ]]; then
			local this_repo
			this_repo=$(cd "$main_repo_root" && gh repo view --json nameWithOwner --jq .nameWithOwner) ||
				die "Could not determine this checkout's GitHub repository."
			# GitHub names are case-insensitive. tr rather than ${,,}, which needs bash 4.
			[[ "$(tr '[:upper:]' '[:lower:]' <<<"$pr_repo")" == "$(tr '[:upper:]' '[:lower:]' <<<"$this_repo")" ]] ||
				die "$target is a PR of $pr_repo, not of this repository ($this_repo)."
		fi
		branch=$(gh pr view "$pr" --json headRefName --jq .headRefName) ||
			die "Could not resolve PR #$pr to a branch."
		echo "PR #$pr is branch '$branch'."
		if [[ -n "$base" ]]; then
			echo "Ignoring base ref '$base': a PR's branch already exists."
			base=""
		fi
	else
		branch="$target"
	fi

	local conventional="$main_repo_root/.claude/worktrees/${branch//\//+}"

	local checkout
	checkout=$(find_checkout "$main_repo_root" "$branch")

	# A worktree folder deleted by hand stays registered (as prunable) until pruned.
	[[ -z "$checkout" || -d "$checkout" ]] ||
		die "Git still lists $checkout for '$branch', but the directory is gone. Run 'git worktree prune' and retry."

	# A detached conventional worktree, typically one stopped mid-rebase, has no branch for
	# find_checkout to match. Enter it as it is rather than letting create fail on the path.
	if [[ -z "$checkout" ]] &&
		git -C "$main_repo_root" worktree list --porcelain | grep -xF "worktree $conventional" >/dev/null; then
		# A folder named after one branch can hold another (a branch renamed after creation).
		local occupant
		occupant=$(git -C "$conventional" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
		[[ -z "$occupant" ]] || die "$conventional is on branch '$occupant', not '$branch'."
		echo "$conventional is not on '$branch' right now (detached, or mid-rebase). Not syncing."
		print_result worktree "$conventional"
		return 0
	fi

	# A PR's branch must already exist. Its absence means the PR was merged and its branch
	# deleted, or it comes from a fork; creating a fresh branch off the default branch would hide both.
	if [[ -z "$checkout" && -n "$pr" ]] &&
		! git -C "$main_repo_root" show-ref --verify --quiet "refs/heads/$branch" &&
		! git -C "$main_repo_root" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
		die "PR #$pr's branch '$branch' does not exist locally or on origin (merged and deleted, or a fork PR)."
	fi

	if [[ -z "$checkout" ]]; then
		cmd_create "$branch" ${base:+"$base"}
		sync_checkout "$conventional" "$branch" 1
		print_result worktree "$conventional"
		return 0
	fi

	[[ -n "$base" ]] && echo "Ignoring base ref '$base': branch '$branch' already exists."

	if [[ "$checkout" == "$main_repo_root" ]]; then
		echo "Branch '$branch' is checked out in the main checkout."
		sync_checkout "$checkout" "$branch" 0
		print_result main "$checkout"
		return 0
	fi

	# Anything under .claude/worktrees/ is enterable where it is, including worktrees made by
	# 'claude --worktree', whose branch name never matches the derived folder.
	if [[ "$checkout" != "$main_repo_root/.claude/worktrees/"* ]]; then
		if ((move == 0)); then
			echo "Branch '$branch' is checked out at $checkout,"
			echo "outside .claude/worktrees/. Its conventional location is $conventional."
			echo "Re-run with --move to relocate that worktree there."
			print_result needs-move "$checkout"
			exit 3
		fi
		[[ -e "$conventional" ]] && die "Cannot move: $conventional already exists."
		mkdir -p "$(dirname "$conventional")"
		git -C "$main_repo_root" worktree move "$checkout" "$conventional"
		echo "Moved $checkout to $conventional."
		checkout="$conventional"
		wire_lightweight "$main_repo_root" "$checkout"
	else
		echo "Worktree for '$branch' already exists at $checkout."
	fi

	sync_checkout "$checkout" "$branch" 1
	print_result worktree "$checkout"
}

cmd_list() {
	local main_repo_root
	main_repo_root=$(resolve_main_repo_root)

	# One gh call for every PR rather than one per worktree, newest first, so a lookup finds
	# a branch's latest PR. Kept as a string, not an associative array: macOS ships bash 3.2.
	# Optional: without gh the PR column is just left empty.
	local prs=""
	if command -v gh >/dev/null 2>&1; then
		prs=$(cd "$main_repo_root" && gh pr list --state all --limit 300 \
			--json headRefName,number,state --jq '.[] | [.headRefName, .number, .state] | @tsv' 2>/dev/null || true)
	fi

	local path="" branch kind line pr
	while IFS= read -r line; do
		case "$line" in
		"worktree "*) path="${line#worktree }"; branch="(detached)" ;;
		"branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
		"")
			[[ -n "$path" ]] || continue
			if [[ "$path" == "$main_repo_root" ]]; then kind=main
			elif [[ "$path" == "$main_repo_root/.claude/worktrees/"* ]]; then kind=worktree
			else kind=other
			fi
			pr=$(awk -F'\t' -v b="$branch" '$1 == b { printf "#%s (%s)", $2, $3; exit }' <<<"$prs")
			printf '%s\t%s\t%s\t%s\n' "$kind" "$branch" "$pr" "$path"
			path=""
			;;
		esac
	done < <(git -C "$main_repo_root" worktree list --porcelain; echo)
}

cmd_create() {
	local branch="${1:-}"
	[[ -n "$branch" ]] || die "Usage: scripts/worktree.sh create <branch> [base-ref]"
	local base="${2:-}"

	local main_repo_root
	main_repo_root=$(resolve_main_repo_root)

	local slug="${branch//\//+}"
	local worktree_root="$main_repo_root/.claude/worktrees/$slug"

	[[ -e "$worktree_root" ]] && die "Worktree path already exists: $worktree_root"

	if git -C "$main_repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
		echo "Branch '$branch' already exists locally. Checking it out into a new worktree."
		git -C "$main_repo_root" worktree add "$worktree_root" "$branch"
		warn_mismatched_upstream "$main_repo_root" "$branch"
	elif git -C "$main_repo_root" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
		echo "Branch '$branch' exists on origin. Checking it out with tracking."
		git -C "$main_repo_root" fetch origin "$branch"
		git -C "$main_repo_root" worktree add --track -b "$branch" "$worktree_root" "origin/$branch"
	else
		if [[ -z "$base" ]]; then
			local default
			default=$(default_branch "$main_repo_root")
			default="${default:-main}"
			echo "Fetching origin/$default..."
			git -C "$main_repo_root" fetch origin "$default"
			base="origin/$default"
		fi
		echo "Creating branch '$branch' off '$base'."
		# --no-track: branching off a remote-tracking ref like origin/<default> would
		# otherwise set that as the upstream (branch.autoSetupMerge defaults to true),
		# pointing a bare 'git push'/'git pull' at the base branch. A new branch has no
		# upstream until its first 'git push -u origin HEAD'.
		git -C "$main_repo_root" worktree add --no-track "$worktree_root" -b "$branch" "$base"
	fi

	wire_lightweight "$main_repo_root" "$worktree_root"

	echo
	echo "Worktree ready (lightweight): $worktree_root"
	echo "Start working:"
	echo "  cd $worktree_root"
	echo "Elevate it when you need to run tests/lint/typecheck/dev servers:"
	# Absolute: a branch older than this script has no scripts/worktree.sh after the cd.
	echo "  $(cd "$(dirname "$0")" && pwd)/$(basename "$0") elevate"
}

cmd_elevate() {
	local main_repo_root worktree_root
	main_repo_root=$(resolve_main_repo_root)
	worktree_root=$(git rev-parse --show-toplevel)

	[[ "$worktree_root" == "$main_repo_root" ]] &&
		die "Refusing to elevate the main repo checkout. Run this from inside a worktree."

	echo "Main repo: $main_repo_root"
	echo "Worktree:  $worktree_root"
	echo

	cd "$worktree_root"

	if [[ -d node_modules ]]; then
		echo "node_modules exists, skipping pnpm install"
		exit 0
	fi

	# pnpm comes from mise here (mise.toml) and is often not on PATH by itself.
	command -v mise >/dev/null 2>&1 ||
		die "mise not found on PATH. Install mise and re-run, or run 'mise exec -- pnpm install' manually."

	echo "Installing dependencies..."
	mise exec -- pnpm install --frozen-lockfile --prefer-offline

	echo
	echo "Worktree elevated: $worktree_root"
}

case "${1:-}" in
create)
	shift
	cmd_create "$@"
	;;
elevate)
	shift
	cmd_elevate "$@"
	;;
open)
	shift
	cmd_open "$@"
	;;
list)
	shift
	cmd_list "$@"
	;;
*)
	cat >&2 <<'USAGE'
Usage: scripts/worktree.sh <command> [args]

  create <branch> [base-ref]   Create + bootstrap a worktree under
                               <main-repo>/.claude/worktrees/<branch-with-+>.
                               Defaults to branching off origin/<default branch>, usually
                               main (after a fetch).
  elevate                      Install node_modules in the current worktree.
  open <pr|branch> [base-ref] [--move]
                               Find or create the checkout for a PR or branch,
                               fast-forward it if clean, and print RESULT= and PATH=.
  list                         List the main checkout and every worktree, tab-separated:
                               kind, branch, PR, path.
USAGE
	exit 1
	;;
esac
