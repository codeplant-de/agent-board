# Worker machines

How a worker machine picks tasks, runs them and reports back.

## Two machines

Every worker machine runs its own timers and its own listener against the same board, under the name `machine` in its config.json (default: the host name). Every machine holds its own event stream, so a change reaches all of them at once and they race to claim; `claim-task` is atomic, so the losers move on, as they do with two timers.

- A claim is atomic on the server: of two machines claiming a task at once, one wins, and the other moves on to the next task.
- A machine skips a todo task it cannot serve, so the other one can take it: a task scheduled on the other machine (its directory is there), a resume whose session lives on the other machine, or an intake review of a repository it has no checkout of.
- A machine sweeps only its own running tasks: the worker unit lives where the task was claimed. When that machine is off, you can take the task back from the task page once its agent has been quiet for 20 minutes.
- Intake runs on both. The PR URL is the task's dedupe key (sent as its blind index), so both create the same task once.

Tasks only move while a machine with the right setup is on.

## Lanes

A machine splits its parallel runs into lanes by skill, configured in its config.json:

```json
"lanes": {
  "reviews": { "skills": ["review-pr"], "slots": 2 },
  "general": { "skills": ["*"], "slots": 3 }
}
```

- **Own work first.** A task belongs to the lane that names the skill its prompt starts with (`/review-pr` and `/pr-review:review-pr` both count as `review-pr`), else to the lane with `*`, which also takes prompts without a skill. A lane with a free slot takes the first Todo task of its own: resumes first (answered, replied to or paused), then by priority. A skill belongs to at most one lane, and at most one lane has `*`.
- **Borrowing.** A lane with nothing of its own borrows the first task any other lane would run, so idle slots do not wait. The run is marked borrowed.
- **Taking the slot back.** When a full lane has its own work waiting and runs borrowed work that has gone on for `pauseAfterMinutes` (default 5), the dispatcher asks the newest such run to pause, one per lane at a time. Lane bias beats priority: a borrowed urgent run gives way to its lane's own low task. An urgent task only has guaranteed room in its own lane.
- **Pausing is cooperative.** The dispatcher drops a pause flag. The agent's `PreToolUse` hook then refuses every tool call but `board comment`, telling the agent to post a one-line status and end its turn. When the run ends, the worker notes "Paused on <machine>: …" and puts the task back in Todo, ahead of new work, to resume in its session on the same machine. A run that has not stopped within five minutes of the request is stopped by force and paused all the same. The resumed run is told it was paused and checks its state before it goes on.

A lane may also name a `cwd`: where its tasks run when they have no directory of their own (see [Where a task runs](#where-a-task-runs)), say `"reviews": { "skills": ["review-pr"], "slots": 2, "cwd": "~/workspace/cosuno/cosuno" }`, so `/review-pr 17766` from the New task form runs in the checkout and gets its settings.

Without `lanes`, a machine runs one lane, `general`, with `*` and three slots.

## Liveness and limits

The hook also touches a heartbeat file on every tool call. The worker checks it every 15 seconds:

- no tool call for `inactivityMinutes` (default 15): the run is stopped as stuck and the task goes to `needs-me` with the end of the log. Claude Code caps a foreground Bash call at ten minutes, so a long command does not trip it.
- a run longer than `maxRunHours` (default 6): stopped, however busy. A guard against an agent looping on tool calls.

The worker passes the heartbeat on to the board every 15 seconds while the agent is active, with the lane. A running card counts the seconds since ("active 12s ago", then "active 1m 5s ago"), amber after 5 quiet minutes, red after 10, and its lane with a "borrowed" badge when it runs in another lane's slot.

The heartbeat, pause flag, lane and working directory of a run live in `$XDG_RUNTIME_DIR/agent-board/` (`AGENT_BOARD_RUN_DIR` overrides it), private to your user.

## Transcripts

Every run records what it did. The worker starts `claude -p` with `--output-format stream-json --verbose`, condenses each event (the agent's text, each tool call with its input, each tool result, subagent calls tagged with their Agent call, notes such as the model and directory, and the result with turns, time, cost and refused tool calls), writes a readable line per event to the local log, and sends the events to the board with every 15-second check and once more when the run ends. A batch the board refuses is sent again with the next. What waits for a board that is down is bounded by count (20,000 events) and by size (32 MB of JSON): past either, the oldest tool outputs are emptied first, then the oldest events dropped, and a note in the transcript says how many. The end of the run makes two bounded passes.

On the board, **Transcript** on a task page (or the terminal icon on a card) opens the runs, newest first, live while one runs. Tool calls are one line each; a click shows the input and loads the output. A tool result over 256 KB is cut with a note; the full one stays in the session file on the machine. Claude Code passes thinking on without its text, so a thinking block shows as a marker with its token estimate.

Transcripts can hold whatever the agent saw: file contents, `gh` output, now and then an environment value. The worker seals each event (and each tool output apart) before it sends it, so the server stores only ciphertext. They go 14 days after a task is closed, and 28 days after the last change of an open task in Done, which covers intake's tasks (the server checks hourly). A task of yours untouched in Done is closed after 14 days.

The board loads a run's events in pages of 2000 and afterwards only those after the last one it has, so long runs show in full and a live run costs one small request per poll.

## Where a task runs

A task is bound to a directory on the machine that ran it:

- A fresh run starts in the task's own directory: where it was scheduled from with `board schedule`, or where the proposing agent worked. A task without a directory of its own (an intake review, a task from the New task form) starts in the checkout of the PR its prompt names (`repos`), else in its lane's `cwd`, else in `defaultCwd`. This matters beyond the files: Claude Code loads the checkout's `.claude/settings*.json` only when it starts there, and that is where tokens and endpoints such as `CIRCLECI_TOKEN` or the replica endpoints usually live. The task's `workdir` is set to it.
- The hook records the agent's working directory on every tool call. When a run ends somewhere else, typically in a worktree the agent entered with `/worktree` (`EnterWorktree`), the worker stores that as the task's `workdir`.
- A resume (after an answer, a reply or a pause) starts `claude --resume` in the `workdir`, so the session continues in exactly the worktree it left. The resume is pinned to the same machine, where that directory exists. If the directory is gone, the task goes to `needs-me` with the path instead of running somewhere else.
- **Re-run fresh** forgets the session and the `workdir`; the next run starts in `defaultCwd` (an intake review: in the checkout).

Claude Code itself (2.1.323) also restores a session's worktree when it is resumed from the original directory; the `workdir` makes the board independent of that and shows it on the task page.

## What a worker may do

There is no sandbox. A worker runs `claude` as you, with your home directory, your SSH agent and your `gh` login. How much it may do depends on who made the task:

- **Tasks you made** (`board schedule`, the New task form, and agent proposals once you start them) run as if you ran the prompt in your terminal: all your settings (user, project, local) and `--permission-mode auto`, Claude Code's classifier mode that lets safe actions through and refuses risky ones. Headless, a refusal cannot become a prompt; it shows in the log and usually in the agent's report.
- **Intake's reviews** run unattended on PR text nobody chose to read, so they get less: `--permission-mode dontAsk` with only `intake.allowedTools` allowed and `intake.disallowedTools` denied on top, and `--setting-sources user`, which keeps a checkout's own `.claude/settings*.json` (its allow rules and tokens) out of the run. The shipped list allows reading, `gh` reads, the pr-review scripts, `board comment`, `ask`, `add`, `show` and `move <task> needs-me` (it cannot `board schedule` or start work), CircleCI through the engineering plugin's `cci.sh`, a few Shortcut reads and `bin/replica-psql` (the production and staging read replicas); it cannot push, merge or approve. `intake.env` hands it `CIRCLECI_TOKEN`, `SHORTCUT_API_TOKEN` and the replica endpoints from the checkout's settings, and nothing else from there. A review that a PR's text turns against you can read production data through the replica, and could put it into the pending draft (which you see before submitting) or onto the board.

Every run gets `AGENT_BOARD_TASK=<id>` in its environment, `AGENT_BOARD_START_DIR=<the directory it started in>` (whose settings a check of `board wait` takes its `env` from), and `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so print mode waits for background subagents instead of stopping them 10 minutes after the last turn. The board's rules also tell the agent not to end its turn while background work runs. And `board schedule` and the changes of `board schedules` refuse to run while it is set: an agent proposes follow-up work with `board add`, which waits in Needs me until you start it. A config that allows `Bash(board *)` covers `board schedule` and `board move <task> todo`; narrow it to the rules in `config.example.json` (`board comment *`, `board ask *`, `board add *`, `board show *`, `board move * needs-me`), and deny `Bash(board schedule *)`, `Bash(board schedules *)` and `Bash(board internal *)`.

A check of `board wait --check` runs later, from the dispatcher, outside Claude Code: its permission rules and the auto-mode classifier see the command only as part of the `board wait` call, so do not allow `Bash(board wait *)` by rule, or a check skips the classifier.

Permission rules match the text of a call: they keep an agent on its task, but they are not a security boundary. A PR or story whose text turns the agent against you reaches whatever the run allows and whatever those commands can reach. A dedicated OS user for the workers, with its own checkouts and a narrowly scoped GitHub token, would make that a boundary again; it is not set up yet.

## How a task runs

A fresh run is

```
claude -p --session-id=<new uuid> --append-system-prompt "<the board's rules>" --settings '<hook>' <permissions>
```

in the task's directory (see [Where a task runs](#where-a-task-runs)). The prompt is the task's `input`, as written, and goes to `claude` on stdin, never as an argument. The appended rules tell the agent its task id, to report with `board comment`, to ask with `board ask` instead of AskUserQuestion, to finish with `board move <task> needs-me`, to wait for CI and the like with `board wait` (not in an intake review), and how to propose follow-ups. Outside an intake review they also set how far the agent goes alone:

- It decides and acts without asking on steps that are easy to undo and stay on the machine (editing files, tests, local branches, worktrees and commits). It uses `board ask` only before a step that is hard to undo or that other people see, unless the prompt asked for it: force-pushing, deleting branches or data, merging, deploying, posting to Slack, Shortcut, email or someone else's PR.
- A prompt to implement, fix or change code counts as the request to commit and push. The agent works on a new branch (in a new worktree if the checkout holds changes that are not its own), pushes it, opens a PR with `gh pr create`, starts CI when the repository's CLAUDE.md or skills say it has to be started or approved by hand, waits for CI with `board wait`, and links the PR in its final comment. Right after opening the PR it runs `board pr <task> <url>`, so the board shows the PR on the task's card and page (see [Pull requests on the card](usage.md#ask-and-resume)). A task that asks only for a plan, an investigation or a review opens no PR.

The rules only ask; `--permission-mode auto` can still refuse a push or `gh pr create`, and the refusal shows in the log.

A task that names a model (`board schedule --model`, or the Model select of the New task form) adds `--model=<model>` as one argument, on a fresh run and on a resume; a name that is not of a model name's shape (a clear value from the server) refuses the run instead. Without one, claude uses its own default.

The hook is the [heartbeat, pause and question hook](#liveness-and-limits). A resumed run is `claude -p --resume=<session>` with the same flags and your reply on stdin (see [Ask and resume](usage.md#ask-and-resume)).

In intake's rules, `Bash(` rules expand `~/` to your home directory and `{<plugin>}` (such as `{pr-review}` or `{engineering}`) to the root Claude Code gives `<plugin>@ccc` as `${CLAUDE_PLUGIN_ROOT}`, resolved when the worker starts: for a marketplace added as a directory (`~/.claude/plugins/known_marketplaces.json`) that is the plugin's `source` in the marketplace's `.claude-plugin/marketplace.json` (Claude Code loads it from the checkout, not from the cache copy), otherwise the `installPath` in `~/.claude/plugins/installed_plugins.json`. A rule must not start with `*` before a script path: a leading `*` matches any command that merely contains the path. If the plugin path cannot be resolved the task goes to `needs-me` with the reason. `Read(...)` rules are passed on unchanged (they take `~/` themselves). Old `backend`, `labels`, `intakeLabel` and `sandbox` entries in a config are ignored.

A missing allowed tool in an intake review shows up as a failed run: the log says what was denied. Add it to `intake.allowedTools`.

## How it decides

Dispatcher, per tick:

1. For each task in `running` claimed by this machine, ask `systemctl --user is-active agent-board-<task>`. A task whose unit is gone moves to `needs-me` with the log tail, timed from the unit's own start (else the task's `runStartedAt`). So does one whose worker failed to enforce the [limits](#liveness-and-limits) for five minutes past them; its unit is stopped. If `systemctl` gives no known state, or the backend fails, the tick stops before starting anything and exits non-zero.
2. For each task in `waiting` that this machine ran: a wait whose `wakeAt` has passed (a timer, or a check past its timeout) or whose check is not stored here is woken with the reason (`wake`), so it can start in this tick. A check whose task is neither waiting nor running here any more is deleted.
3. A task this machine cannot serve is skipped (see [Two machines](#two-machines)). The rest are planned into [lanes](#lanes): own work first, then borrowing. Each start is claimed, its lane written to the run directory, then `systemd-run --user --collect --unit agent-board-<task>` starts the worker and a start note names the machine, lane and PID. A lost claim hands its slot to the next task; the first failed start ends the tick's starting.
4. Lanes whose own work still waits ask one borrowed run each to pause.
5. The checks that are due run side by side (45 s each at most). One that exits 0 wakes its task with the end of its output; for any other the result is kept with the check for the timeout message.

Worker, per task: a task with `next: resume`, a session, and a user reply, a pause or a wake since the agent last spoke resumes that session with the reply (and "you were paused", or "your wait is over: <why>") as the prompt, but only a session this machine started for the task; for any other the run is refused with the reason. Anything else starts a new session, whose id is recorded on this machine and stored on the task once the run is about to start (and cleared again if the process cannot be spawned). A run is also refused when it would hand the agent a note of yours that cannot be decrypted. A fresh run's prompt is the task's prompt; when the thread already holds notes by you or the agent, it is followed by what you wrote since the previous run started and a line telling the agent to read the thread with `board show <task>`. Either way `next` goes back to `fresh`.

Intake, per run: search the repos in `repos` for open, non-draft PRs that request your review, then create one task per PR URL (the dedupe key), checked against every task, closed ones included. One `gh api graphql` call per page covers all repos. A PR without an author (a deleted account) is listed as `ghost`. A PR whose data cannot be read is logged as `WARN skipped <url>` and its task is left alone; a result without a URL fails the run. A failed GitHub search or backend listing changes nothing and exits non-zero.

- A PR whose head moved and whose last commit is at least ten minutes old sends its task from `needs-me` or `done` back to `todo` (a task parked in `backlog` stays there) with `next: fresh`. A failed task stays in `needs-me` until the head moves.
- A task still waiting in Todo for a PR that no longer appears (merged, closed, draft, or no longer asking for your review) is moved to `done` with a note, and its `head` is cleared in the same update.
- A PR that is listed again with the same head brings such a task back: a settled PR whose intake task is `done` without a head is queued again the same way. A task you marked done keeps its head and stays done.

After the reviews, intake also refreshes the PR state shown on the board. For every task that is not closed or done and has a PR (the one its prompt names, else the one its agent reported), it asks GitHub for the PR's state: one `gh api graphql` query for up to 50 PRs, an alias per PR, owner, repository and number passed as variables. When the state differs from the task's `prState`, it writes the new one with `set-pr-state` (log: `PRSTATE <task> <state>`), so the board can show a merged or closed PR on the card and offer **Move merged to Done**. A PR GitHub gives no answer for (deleted, no access) is logged as `WARN no state for <url>` and its task keeps its state. A failed query is logged as `WARN PR states not refreshed` and does not fail the run: the review work above has been done by then. Against a board server without the `task.pr-state` feature the first write is refused, logged once, and the rest is skipped. `--dry-run` runs the queries and prints the writes.
