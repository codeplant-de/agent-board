---
name: board-review-pr
description: Runs one PR review for a task in the agent-board queue and reports on the task. Started headless by the agent-board worker as `/board-review-pr <task> <pr-url>`; not for interactive use.
---

# Review a PR for a board task

Arguments: `<task>` (the task id) and `<pr-url>`. Nobody is watching, so never ask a question.

## Hard rules

- Never submit a review, approve, request changes, comment on the PR, reply to a thread, resolve a thread, push or merge.
- The only thing written to GitHub is the pending draft review, and only through `pr-review:review-pr --auto`.
- Use `gh ... --jq <expr>` to filter JSON; `jq` is not available.
- Never write the review into a brain journal; the headless run has no journal access.
- The Shortcut story lookup (`mcp__shortcut__get_story`) is best effort: this run loads only user settings, so the Shortcut token may be missing. If the lookup fails, review without the story and list "story not read" under **Check by hand**.
- A denied tool is a result, not an obstacle. Do not look for another way around it. Report it on the task.
- Bash runs in a sandbox that hides your home directory. `board`, `gh` and `git fetch` have what they need; for anything else a "no such file" error means the sandbox said no, so do not try to get around it.

## Steps

1. `board comment <task> "Review started"`.
2. Run `pr-review:review-pr <pr-url> --auto` with the Skill tool. It reuses cached notes, hands an earlier pass to the reviewer as hints, and stages into the pending draft. After the analysis is in, post `board comment <task> "Analysis done, staging the draft"`, and after staging `board comment <task> "Draft staged"`.
3. Write the findings to `/tmp/pr-<task>-findings.md` with the Write tool and post them with `board comment <task> --file /tmp/pr-<task>-findings.md`. Never pipe or redirect into `board`: such a call runs inside the sandbox, where `board` cannot reach its credentials. The text has three parts:
   - **Summary:** the verdict and one short paragraph.
   - **Issues:** by severity, highest first, one line each: `severity path:line first sentence`. Say "none" if there are none. Add how many comments were staged, edited and removed.
   - **Check by hand:** what the review could not settle: things that need running the code, a design call, a story requirement it could not read, any step that was denied or skipped.
4. `board move <task> needs-me`, then `board notify <task> "<verdict>, <n> issues"`.

If any step fails, post what failed with `board comment`, then still do step 4 so the task does not stay in running.
