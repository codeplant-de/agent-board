---
name: board-review-pr
description: Runs one PR review for a task in the agent-board queue and reports on the task, asking the user on the board when a finding hinges on intent. Started headless by the agent-board worker as `/board-review-pr <task> <pr-url>`, and resumed with the user's answer; not for interactive use.
---

# Review a PR for a board task

Arguments: `<task>` (the task id) and `<pr-url>`. Nobody is watching the terminal. The user reads the task on the board, and you reach them only through `board ask` (see [Asking](#asking)); never ask in your answer text.

## Hard rules

- Never submit a review, approve, request changes, comment on the PR, reply to a thread, resolve a thread, push or merge.
- The only thing written to GitHub is the pending draft review, and only through `pr-review:review-pr --auto`.
- Use `gh ... --jq <expr>` to filter JSON; `jq` is not available.
- Never write the review into a brain journal; the headless run has no journal access.
- `board show <task>` prints the task and its whole thread, including the user's comments. Read it at the start of a fresh run: the user may have left instructions there.
- The Shortcut story lookup (`mcp__shortcut__get_story`) is best effort: this run loads only user settings, so the Shortcut token may be missing. If the lookup fails, review without the story and list "story not read" under **Check by hand**.
- A denied tool is a result, not an obstacle. Do not look for another way around it. Report it on the task.
- Run every command on its own, by its full path: no `cd`, no `VAR=... ; $VAR` indirection, and never a `board` call chained with a command that is not `board` (it would run in the sandbox, where `board` is not found). Such calls are refused or fail, and each one costs a turn.
- Temp files go in `/tmp/pr-<n>-<sha7>-<what>`, never under `$TMPDIR` (inside the sandbox that is `/tmp/claude`, and the script rules only allow `/tmp/pr-*`). Use that path wherever `pr-review:review-pr` says `${TMPDIR:-/tmp}/pr-...`, and create the files with the Write tool.
- Bash runs in a sandbox that hides your home directory. `board`, `gh` and `git fetch` have what they need; for anything else a "no such file" error means the sandbox said no, so do not try to get around it.

## Steps

1. `board show <task>`, then `board comment <task> "Review started"`.
2. Run `pr-review:review-pr <pr-url> --auto` with the Skill tool. It reuses cached notes, hands an earlier pass to the reviewer as hints, and stages into the pending draft. After the analysis is in, post `board comment <task> "Analysis done, staging the draft"`, and after staging `board comment <task> "Draft staged"`.
3. Write the findings to `/tmp/pr-<task>-findings.md` with the Write tool and post them with `board comment <task> --file /tmp/pr-<task>-findings.md`. Never pipe or redirect into `board`: such a call runs inside the sandbox, where `board` cannot reach its credentials. The text has three parts:
   - **Summary:** the verdict and one short paragraph.
   - **Issues:** by severity, highest first, one line each: `severity path:line first sentence`. Say "none" if there are none. Add how many comments were staged, edited and removed.
   - **Check by hand:** what the review could not settle: things that need running the code, a design call, a story requirement it could not read, any step that was denied or skipped.
4. If an open point is one the user can settle in a sentence, ask now (see [Asking](#asking)) and stop: `board ask` moves the task to needs-me and notifies. Otherwise: `board move <task> needs-me`, then `board notify <task> "<verdict>, <n> issues"`.

Your last message, after step 4, ends with the `auto-result` line that `review-pr --auto` printed, unchanged, so the log shows the flow reached its end.

If any step fails, post what failed with `board comment`, then still do step 4 so the task does not stay in running.

## Asking

Ask when a finding or the review's scope hinges on intent you cannot read: a story you could not load, a design call, whether a pattern is deliberate, whether a finding is blocking. Do not ask what the code, the PR or the story answers, and do not ask to confirm a finding you are sure of.

- Stage what is certain first (steps 1-3), so the draft is useful even before the user answers.
- Write `/tmp/pr-<task>-questions.json` with the Write tool and run `board ask <task> --file /tmp/pr-<task>-questions.json`. The file is `{"questions": [...]}` with 1 to 4 questions, each `{"header": "<at most 16 chars>", "question": "...", "multiSelect": false, "options": [{"label": "...", "description": "...", "recommended": true}, ...]}`, 2 to 4 options, the recommended one first and marked. The user can always write their own answer next to the options.
- Then stop. Your last message is the `auto-result` line.

## Resumed run

When the prompt starts with "The user replied on board task", the user answered your questions or sent a follow-up. You have the earlier run's context. Act on it:

- Adjust the review: re-check what the answer changes and update the pending draft through `pr-review:review-pr <pr-url> --auto` (it edits or removes only its own staged comments).
- A request for more work that is not this review (a refactor, a ticket, research) becomes a proposal: write its description to `/tmp/pr-<task>-followup-<n>.md` and run `board add --label <label> --title "<title>" --file /tmp/pr-<task>-followup-<n>.md --parent <task>`. It takes this task's priority; add `--priority urgent|high|normal|low` only when the follow-up clearly matters more or less than this review (a security hole: higher; a cleanup: `low`). Use `review-pr` for another review; for other work use the label the user named. `board add` fails on a label the board does not know: then list the follow-up under **Check by hand** instead. A proposal waits for the user to start it; never do that work in this run.
- Post what changed with `board comment <task> --file ...` (same three parts as step 3, shorter), then ask again or end with step 4.
