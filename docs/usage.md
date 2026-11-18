# Using the board

How tasks move through the board, and what you and the agent can do with them.

## Tasks

A task is a prompt, written as you would type it into Claude Code: `/review-pr 17741`, `/grill the plan in docs/x.md`, or plain instructions. The worker runs it as written. If the prompt starts with a slash command, that is the task's skill. The skill picks the [lane](workers.md#lanes) and shows as the task's label.

### Statuses

| Status     | Meaning                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------- |
| `backlog`  | Parked. No worker takes a Backlog card until you move it to Todo.                         |
| `todo`     | Ready. Workers take Todo from the top.                                                    |
| `running`  | A worker runs it.                                                                         |
| `waiting`  | Its agent waits for something outside the run, such as CI. See [Waiting](#waiting).       |
| `needs-me` | Your turn.                                                                                |
| `done`     | Finished. Done tasks nobody touched for 7 days are closed and stay readable under Closed. |

A run ends in `needs-me` with a report or a question. A run that fails, times out or loses its worker also ends there, with the reason and the end of the log. Nothing moves on until you press a button.

Backlog is the first column. On a phone the board leaves it out, and the header has a Backlog entry that opens it as its own page. Waiting is a box above Todo in the same column, and it shows only while a task waits.

### Priorities

There are four priorities: `urgent`, `high`, `normal` (the default) and `low`.

Every column except Waiting lists its tasks by priority, then in the order you dragged them into. Workers take Todo from the top, so an urgent task runs before anything else that waits. Waiting lists the wait that ends first on top.

Dropping a card among tasks of another priority gives it their priority. The task page has a picker for it.

## Scheduling

```sh
board schedule /review-pr 17741
board schedule --priority high /review-pr acme/app#17741 --auto
board schedule --model opus "Find out why the CSV export is slow and propose a fix"
board schedule --in 2h /review-pr 17741
board schedule --at 09:00 /grill the plan in docs/x.md
board schedule --polish "CSV export should include postal codes"
board delay Ab3dEf9x --in 1d
board task Ab3dEf9x set dir ~/workspace/agent-board
board schedule --every 2h --times 5 /sweep the stale branches
board schedule --cron "0 9 * * 1-5" /review-pr --auto
board schedules
```

### `board schedule`

```text
board schedule [--priority p] [--model m] [--agent a] [--title t] [--hold | --backlog]
               [--in <dur> | --at <time>] [--every <dur> | --cron "<expr>"]
               [--times <n> | --until <time>] [--polish] [--new]
               [--key <key> [--version <v>]] <prompt...>
```

`board schedule` makes a task of the prompt, bound to this machine and the directory you run it in, and prints its URL.

The board's flags come first. Everything from the first other word on is the prompt, flags included. In the example above, `--auto` goes to the skill.

| Flag                           | Effect                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--priority`                   | `urgent`, `high`, `normal` or `low`.                                                                      |
| `--model`                      | The Claude model of the task's runs. See [Model](#model).                                                 |
| `--agent`                      | Runs the task as a named agent. See [Choosing an agent](#choosing-an-agent).                              |
| `--title`                      | The title. It defaults to the prompt's first line.                                                        |
| `--hold`                       | Lands the task in Needs me instead of Todo.                                                               |
| `--backlog`                    | Lands the task in Backlog. Cannot be combined with `--hold`.                                              |
| `--in`, `--at`                 | Holds the task in Todo until then. See [Delays](#delays).                                                 |
| `--every`, `--cron`            | Makes a repeating schedule. See [Repeating schedules](#repeating-schedules).                              |
| `--times`, `--until`           | Ends a repeating schedule.                                                                                |
| `--polish`                     | Parks the task in Backlog and queues a polish task for it. See [Polishing a prompt](#polishing-a-prompt). |
| `--new`                        | Skips the [duplicate check](#duplicate-check).                                                            |
| `--key`, `--version`, `--json` | For scripts. See [Scripts](#scripts).                                                                     |

When this machine has a `dirs` list, `board schedule` refuses in a directory the list does not allow, before it asks the board anything. That holds for a repeating schedule too. Run `board dirs add` there first.

`--polish` prints the links of both tasks, and `--json` adds `polishId` and `polishUrl`. It cannot be combined with `--hold`, `--in`, `--at` or a repeat, because a polished prompt is applied only to a Backlog task you wrote.

### Model

Every run uses claude's default model unless the task names one. `--model <model>` takes an alias (`fable`, `opus`, `sonnet`, `haiku`) or a full name such as `claude-opus-5-5`. With a repeat, every task the schedule makes uses it.

The New task form and the task page have a **Model** select for the same choice.

### Delays

`--in <dur>` or `--at <time>` keeps the task in Todo until then. It sits last in the column with a "Starts in 4h" badge, and no worker takes it before. The confirmation line names the start time.

The two exclude each other. Neither can be combined with `--hold` or `--backlog`, because a delay only exists in Todo.

- `<dur>` is a number and a unit, largest unit first: `m` minutes, `h` hours, `d` days, `w` weeks. Units can be combined: `30m`, `2h`, `1d`, `1h30m`, `1w2d`. Zero, negative values and unknown units are refused.
- `<time>` takes one of four forms. A time in the past is refused.
  - An ISO date and time with an offset or `Z`: `2027-01-01T12:00:00Z`.
  - An ISO date and time without one, read as your local time: `2027-01-01T12:00`.
  - A date, read as local midnight: `2027-01-01`.
  - `HH:MM` for the next time of day: `09:30` is today if it is still ahead, else tomorrow.

`board delay <task> (--in <dur> | --at <time> | --now)` sets or moves the delay of a task in Todo. `--now` clears it so the task is due at once. The task page has a **Run now** button for the same, and the New task form sets a delay under **When: Later**.

A delay is cleared when the task leaves Todo. A task that is moved back later is not delayed again.

### Duplicate check

Before `board schedule` creates a task, a Haiku call checks whether an open task already covers the same work. It takes a few seconds and costs under a cent.

On a likely match it asks in the terminal whether to requeue that task for a fresh run, create a new one anyway, or abort. Without a terminal it creates the task with a note naming the likely duplicate. `--new` skips the check.

When you requeue the existing task:

- `--hold` and `--backlog` pick where it goes.
- `--in` or `--at` sets a delay on it. If the task is already in Todo, it is delayed. If it is running, the start time is not applied, and the line says so.
- The task keeps its own model. `--model` applies only to a new task, and the line says so.
- `--polish` queues nothing, and the line says so. The task's prompt is not the one you typed, so polish it from the board.

### Changing a task later

`board task <task>` prints a task's settings:

- status, priority and model (`default` for claude's)
- agent and who made it
- the machine it is pinned to and its directory, or "the default directory of the machine that takes it"
- when it starts and its schedule
- whether its next run resumes its session or starts fresh
- its PRs

A directory on this machine that the `dirs` list does not cover is marked "not listed on this machine". `--json` prints the task as `board tasks --json` does.

| Command                                                      | Effect                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `board task <task> set priority <urgent\|high\|normal\|low>` | Changes the priority and writes the usual note.                                         |
| `board task <task> set model <alias or model id>`            | Applies from the next run on. A run in progress keeps its own model.                    |
| `board task <task> unset model`                              | Back to claude's default.                                                               |
| `board task <task> set dir [path]`                           | Pins the task to this machine and a directory. The default is the current one.          |
| `board task <task> unset dir`                                | Removes the directory and the pin. Any machine takes the task in its default directory. |

Priority and model changes work in every status. A model or directory change writes no note.

`set dir` accepts relative paths and `~`, and resolves symlinks. With a `dirs` list on this machine the directory must be listed, as for `board schedule`.

**A new directory drops the task's session.** Claude Code keeps a session under its working directory and cannot resume it from another one. The next run starts fresh in the new directory and reads the thread. The command says so when there was a session.

- A running or waiting task refuses a directory change. Stop it first.
- The new directory also becomes the one **Re-run fresh** goes back to.

On a card of a repeating schedule, a change applies to that card only. The next occurrence takes priority, model, machine and directory from the schedule again. The command says so, and so does the task page.

`set` and `unset` are refused inside a board run, because an agent does not move a task or pick its model. Viewing works there.

#### Editing the prompt

Until a worker claims a task, you can change its title and prompt on its page: **Edit prompt**, next to the prompt. The editor starts from the current text. Your browser seals the new text as yours, and the old title and prompt stay in a note on the task. The button shows only on a task that:

- you created, and that is not an agent's proposal or a card of a repeating schedule,
- is not closed,
- waits in Todo or Backlog,
- no worker has claimed yet.

Once a worker claimed it, even if it went back to Todo, the prompt is in its thread. Reply to it instead. If a worker claims the task while the editor is open, the editor stays with your text and saving fails with "The task has started; its prompt is in its thread now. Reply to it instead." Copy your text out before you close it.

A card of a repeating schedule has no **Edit prompt**: its prompt belongs to the schedule. Its page links to the Schedules page, where an edit reaches the card too while it has not started. There is no command for editing a prompt yet.

### Repeating schedules

`--every <dur>` or `--cron "<expr>"` makes a schedule instead of one task. A schedule is a rule that keeps producing delayed Todo cards. Use one or the other, not both. `--in` or `--at` sets the first run. Without one it starts now.

**The rule.**

- `--every 2h` runs on a fixed grid from the first run, whatever time the cards actually start at. The interval is between 1 minute and 10 years.
- `--cron "0 9 * * 1-5"` is a 5-field expression: minute, hour, day of month, month, weekday. The CLI reads it in the time zone of the machine that made the schedule and stores the zone with it, so `0 9 * * *` stays at 9:00 local across a change to summer time. Its first run is the first match at or after `--in` or `--at`, or now. A 6-field expression with seconds is refused, as is anything that does not parse.

**The end.**

- `--times <n>` is the number of runs including the first, a positive whole number.
- `--until <time>` is the last moment a run may start. A run exactly at that time still starts.
- The two exclude each other. Without either the schedule repeats forever.
- `--times` and `--until` without a repeat are usage errors. So is a repeat with `--hold` or `--backlog`.

**One pending card.** A schedule has exactly one pending occurrence. It is an ordinary Todo card with a start time and the schedule's title and priority, pinned to the machine and directory the schedule was made in.

The board makes the next card when the pending one leaves Todo: a worker claims it, you move it, or you close it. So a machine that was off for a day finds one card, not a pile. The next run is the first one on the rule after the previous run's time that is not in the past. Missed runs are skipped, and there is no timer on the server.

- Closing or moving the pending card skips that run.
- A card that ran and comes back to Todo later, after a reply or a re-run, makes no further card.
- A schedule with no run left ends. That happens when `--times` is used up or the next run would lie after `--until`. It stays in the list, dimmed, and creates nothing.

A repeat skips the duplicate check, since a recurring prompt resembles its own earlier runs. The confirmation names the schedule id, its rule, the first run and the card's URL.

**Managing schedules.**

| Command                       | Effect                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `board schedules`             | Lists id, rule, next run, runs left including the pending one, state and title. |
| `board schedules pause <id>`  | Takes the pending card off the board and stops the schedule.                    |
| `board schedules resume <id>` | Makes the next card, at the first run on the rule from now.                     |
| `board schedules rm <id>`     | Deletes the schedule and its pending card. Cards that already ran stay.         |

`pause`, `resume` and `rm` are refused inside a board run, like `board schedule`.

### The Schedules page

The **Schedules** page of the web board lists each schedule with its title and prompt, rule, next run, runs left (`forever` without an end), machine and a link to the pending card. You can edit, pause, resume and delete from there. An ended schedule is dimmed and can only be deleted.

**Edit** changes the schedule's title and prompt. Every later run takes them. The pending card takes them too while it waits in Todo and no worker has claimed it, and the page says which of three happened: "The pending card was updated too", "The pending card has already started; the change applies from the next run", or "The schedule has no pending card; its next run takes the change" (a paused schedule has none). Cards that already ran or moved on keep what they had. The old text is not kept: a schedule has no thread.

A pending card carries a **Repeat** badge, and its page says it is the next run of a schedule.

### The New task form

The board's **New task** form takes a prompt the same way `board schedule` does.

**Working directory.** The field offers the directories your machines listed with [`board dirs`](#board-dirs), grouped by machine, most recently seen first.

- A directory with a label reads `label — path`, and a search matches either.
- A machine not seen for a day says when it was last seen. It stays selectable, and the task then waits in Todo for it.
- Picking a directory pins the task to that machine and directory, as `board schedule` does from a terminal. Your browser seals the directory as yours.
- Leave the field empty and the task runs in the default directory of whichever machine takes it. See [Where a task runs](workers.md#where-a-task-runs).
- Revoked machines, machines that sent no list and a list the browser cannot read are not offered. The field names the machine whose list it could not read.
- With no list at all the field is disabled and says to run `board dirs add`.

**Skill completion.** Typing `/` at the start of the prompt offers the skills of the chosen machine and directory. With no directory chosen it offers the skills of every machine that sent a list. Arrow keys move, Enter or Tab fills the name in, and Escape closes the list. The list shows only while the caret is in the first word.

The list is advice. A name that is not in it still runs, and a machine that has not sent a list offers nothing. [Skills and models on the board](workers.md#skills-and-models-on-the-board) explains how the lists reach the board.

**Model.** The field shows the models the chosen machine listed, or every machine's when none is chosen. When no machine listed any, it shows the built-in aliases. A model picked before the machine changed stays selected.

**Agent.** See [Choosing an agent](#choosing-an-agent).

**When.** The menu offers Now, Later, Repeating, Backlog and Needs me. Repeating takes an interval (`2h`) or a cron expression, an optional first run and an optional number of runs, and opens the first pending card. The form reads a cron expression in your browser's time zone and shows the server's error if the server cannot read it. With Repeating, the Working directory pins the schedule, so every occurrence runs on that machine and in that directory.

### Settings on the task page

The task page changes the same settings after the fact, next to the priority.

- A **Model** select with the options of the New task form for the task's machine, plus the task's own model when it is not among them. It applies from the next run on and works in every status.
- A pencil beside the directory that opens the same picker as the New task form. **No directory** removes the directory and the machine pin.

A directory change drops the task's Claude session, as with `board task set dir`. A task that has a session asks you to confirm first. The page refuses the change while the task is Running or Waiting. Choosing the directory the task already has changes nothing.

The page marks a directory that its machine's list does not cover as "not listed on <machine>". That is advice from your browser, which cannot resolve symlinks. The worker's own check decides.

### `board dirs`

`board dirs` keeps this machine's list of directories workers may run in. It is the `dirs` key of `config.json` (see [Config](setup.md#config)).

| Command                               | Effect                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `board dirs`                          | Lists the directories with their settings, marks a missing one, and says whether the list is enforced. |
| `board dirs add [path]`               | Lists the real path of the current directory or of `path`.                                             |
| `board dirs add --from-config`        | Lists the directories that `defaultCwd`, the lanes and `repos` already route to.                       |
| `board dirs rm [path]`                | Unlists one, and says which of repo, default and lane go with the entry.                               |
| `board dirs set <key> <value> [path]` | Changes one setting of a listed directory.                                                             |
| `board dirs unset <key> [path]`       | Removes one setting.                                                                                   |

Without `path` the current directory is meant. The settings:

| Key       | Value        | Meaning                                          |
| --------- | ------------ | ------------------------------------------------ |
| `label`   | a short name | The New task form shows it with the path.        |
| `repo`    | `owner/name` | The directory is that repository's checkout.     |
| `default` | `true`       | Tasks without a directory run there.             |
| `lane`    | a lane name  | That lane's tasks without a directory run there. |

One directory holds `default`, and one per lane and per repo. `set` refuses a second and names the first, so `unset` it there first.

`rm` refuses while an open task or schedule of this machine runs only in that directory, or when the board cannot be asked. `--force` overrides that.

`add`, `rm`, `set` and `unset` are refused inside a board run.

**The list is enforced as soon as the key exists**, even as `{}`. The first `add` creates the key. From then on a worker on this machine runs a task only in a listed directory or below one, and a task elsewhere ends in Needs me with the reason. `board doctor` fails for a default, lane or repo directory the list does not cover. [Where a task runs](workers.md#where-a-task-runs) has the details.

**The board keeps a sealed copy** of the list for the New task form: the directories that exist, each with its label if it has one. `repo`, `default` and `lane` stay on the machine. `add`, `rm`, `set` and `unset` send the copy, and every dispatch tick sends it again when it changed. If the board cannot be reached, the command warns and still succeeds. Workers never read that copy.

### `board config`

`board config` views and edits this machine's whole `config.json` without a text editor. [Config](setup.md#config) lists the keys.

| Command                             | Effect                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| `board config`, `board config show` | Prints the path and the settings as the CLI reads them.          |
| `board config show --json`          | Prints the file.                                                 |
| `board config path`                 | Prints the path.                                                 |
| `board config get <key>`            | Prints the value at a dotted key, such as `lanes.reviews.slots`. |
| `board config set <key> <value>`    | Sets one key.                                                    |
| `board config unset <key>`          | Brings a default back.                                           |
| `board config edit`                 | Opens a copy in your editor.                                     |

**Viewing.** `show` marks a default with `(default)`. It also prints the lanes, repos and agents (a broken agent with its error), the size of the `dirs` list and the warnings of the file. `get` prints a string bare and anything else as JSON. For a setting the file leaves out it prints the default. A key can contain a slash, as in `repos.acme/app.js`.

**Changing.** `set` takes the value as JSON when it is JSON and as a string otherwise. `set` and `unset` check the whole resulting file before writing. They write nothing and refuse when:

- the config would not load,
- an agent would not load,
- the key is one the CLI does not read (the error names the nearest one),
- the key is below `dirs` (use `board dirs`),
- the change newly leaves a directory the config routes work to (`defaultCwd`, a lane's `cwd`, a `repos` checkout) missing or outside the `dirs` list. Work sent there would stop in Needs me.

`--dry-run` only shows the change. Setting one lane in a file without a `lanes` key writes the default lane out too.

**Editing.** `edit` opens a copy in `$VISUAL`, else `$EDITOR`. There is no default editor. The CLI runs the editor through the shell, as git does, so the variable may carry arguments and quotes (`code -w`, `emacsclient -a ""`). `edit` replaces the file only with JSON the CLI can load. When it cannot, the file stays and the message names the copy that holds your edits. For a directory problem that `set` would refuse, `edit` warns instead.

`set`, `unset` and `edit` are refused inside a board run.

**After a change** the CLI:

- sends a changed `dirs` list to the board,
- warns when a changed `dirs` list drops a directory. Work still pinned to it stops in Needs me, and `board dirs rm` checks for that.
- warns when `machine` changed. The board names a machine by its token, so the new name needs a token issued for it, and tasks whose session lives under the old name do not resume here.
- says that the change applies from the next dispatch tick.

A run already going keeps the settings it started with, except `maxRunHours`, `inactivityMinutes` and `pauseAfterMinutes`. The dispatcher reads those three on each tick and applies them to runs already going. A run past a lowered `maxRunHours`, or quiet for longer than a lowered `inactivityMinutes`, is stopped then, after a few minutes of grace.

## Scripts

A script that creates tasks runs `board schedule` again and again. It needs a call that is safe to repeat: no Haiku check, no terminal, and a result it can read.

```text
board schedule --key <key> [--version <v>] [--in d | --at t] [--agent a] [--title t] [--json] [--] <prompt...>
```

This makes the task of the key once. The board keeps one task per key, whoever made it and on whichever machine. The CLI hashes the key with your data key before it leaves the machine, so the board never sees it.

- `--version` is what the task is made for, such as a PR's head sha for a review. The board holds only a hash of it too. It needs `--key`.
- The key and the version are used as given. They hold at most 500 and 200 characters and no control characters.
- `--key` skips the duplicate check.
- `--key` cannot be combined with `--every`, `--cron`, `--polish`, `--hold` or `--backlog`. It makes or finds a task in Todo, and it requeues into Todo.
- `--in` or `--at` makes the task wait in Todo until then, and a call with the same key moves the wait to the new time (see `rescheduled` below).

### Results

The line the command prints says what happened. `--json` prints the same as `"result"`, the `"status"` of the task afterwards, `"id"` and `"url"`, and for `exists` a `"reason"`.

Every outcome exits 0, so a script tells them apart by the result. A usage error exits 2 and any other failure 1.

| Line                                    | Meaning                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `created <id> <url>`                    | The board had no task of this key. This one is made, with the version if `--version` was given.                 |
| `requeued <id> <url>`                   | The task was in Needs me or Done and its version differs. It is back in Todo.                                   |
| `rescheduled <id> <url>, starts <time>` | The call gave `--in` or `--at` and the task waits in Todo for a fresh start. Its start time is now the new one. |
| `exists <id> <url> (closed)`            | The task was closed. A closed task is never made again, whatever the version.                                   |
| `exists <id> <url> (same-version)`      | It already holds this version.                                                                                  |
| `exists <id> <url> (no-version)`        | The call gave no `--version`, so there is nothing to compare.                                                   |
| `exists <id> <url> (busy)`              | The version differs, but the task is in Todo, Running, Waiting or Backlog.                                      |
| `exists <id> <url> (other-agent)`       | The version differs, but the task runs as another agent than `--agent` names, or as none.                       |
| `exists <id> <url> (changed)`           | The task moved between the call reading it and writing it. Nothing was written.                                 |

Some of these need more words:

- **`requeued`.** A task that holds no version counts as differing. One update puts the task back in Todo with the new version and a fresh session, and adds the note "New version <v>. Queued again."
- **`rescheduled`.** Needs `--in` or `--at`, and a task in Todo that has not started (not an answered or paused run waiting to resume) and runs as the same agent. Whether `--version` is missing, the same or new does not matter. One update sets the start time, and the new version too when it differs, with the note "New version <v>. Starts <time>." The same `--at` again changes nothing; `--in` starts the wait over from now. A `created` or `requeued` call with `--in`/`--at` also prints `, starts <time>`.
- **`busy`.** The task is left as it is. A later call requeues it once it sits in Needs me or Done.
- **`other-agent`.** An agent is written once and cannot change, so a requeue would run the new version under the old rules. The task is left as it is.
- **`changed`.** A worker claimed the task or you moved it. The next call looks again.

The agent keeps the run narrow, whoever made the task. `--agent reviewer` seals `reviewer` on the task, and the worker runs it with that agent's tools and lists and never lets it ask (see [Agents](workers.md#agents)).

The prompt, `--model`, `--priority` and `--title` apply to a task that is made, not to one that is found. A requeue runs the prompt stored when the task was created.

### Review requests from GitHub

`board example github-reviews.sh` prints a POSIX shell script that turns GitHub review requests into tasks. It needs `gh`, logged in, and `board`.

`board example` lists all examples. They are built into the CLI, so they match its version. The files are in `apps/cli/examples`.

```sh
board example github-reviews.sh > ~/.local/bin/github-reviews.sh && chmod +x ~/.local/bin/github-reviews.sh
github-reviews.sh acme/app=~/workspace/acme/app acme/other=~/workspace/acme/other
```

The arguments are the repositories with their checkouts on this machine, as `owner/name=dir`. The script expands `~`. The directory is required and must be one that `board dirs` lists. `board schedule` binds a task to the directory it runs in, so the script runs it in the checkout of each PR's own repository, and the worker runs the review there.

**What it schedules.** One `gh api graphql` query, over all pages, finds the open, non-draft PRs in those repositories that request your review. The script skips a PR whose head commit is less than 10 minutes old, so a PR that is still being pushed to is looked at next time. For each other PR it runs:

```sh
board schedule --agent "${BOARD_AGENT:-reviewer}" --key "$KEY_PREFIX$url" --version "$head" --title "#$n $title ($author)" --json -- /review-pr "$url" --auto
```

A new PR gets one task. A new head sends its task from Needs me or Done back to Todo for a fresh review. The script takes control characters out of the title.

- `BOARD_AGENT` is the agent of this machine the review runs as. A machine that defines the agent runs the task (see [Agents](workers.md#agents)).
- `KEY_PREFIX` goes in front of the PR URL to make the key. It is empty by default, so the key is the bare URL.

**What it clears.** The board's keys cannot be read back. So the script keeps the id of each task it scheduled in `${XDG_STATE_HOME:-~/.local/state}/agent-board/github-reviews.tsv`, as the URL, a tab and the task id.

When a PR no longer asks for your review (merged, closed, turned into a draft, or the request withdrawn), the script moves its task to Done with `board move <id> done --expect todo`. That applies only to a task that is still in Todo and would start a fresh run. The script then drops the entry.

It leaves these alone:

- A task that is running or waiting for you.
- A task in Todo as a resume, because it was answered, paused or woken.
- A task that left Todo since the listing. `--expect` makes the move exit 3 and write nothing, and the script skips it.

The script closes nothing when the search failed or its answer could not be read, when `board tasks` fails, or when a signal ended the script. A PR the search listed but whose data could not be read counts as still asking.

A PR that comes back with the same head after its task was moved to Done is not reviewed again until its head moves (`exists (same-version)`).

**Exit codes.** The script exits 1 when the search or a call failed, so a timer shows it, and 2 for a usage error.

**Running it on a timer.** Allow one run at a time and set a time limit, so a stuck `gh` cannot pile up runs. As a systemd user timer, with the checkouts as the arguments:

```ini
# ~/.config/systemd/user/github-reviews.service
[Unit]
Description=Board tasks for GitHub review requests

[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/flock -n -E 75 %t/github-reviews.lock %h/.local/bin/github-reviews.sh acme/app=%h/workspace/acme/app
SuccessExitStatus=75
TimeoutStartSec=5min

# ~/.config/systemd/user/github-reviews.timer
[Unit]
Description=Board tasks for GitHub review requests

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
AccuracySec=1min

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now github-reviews.timer
```

Exit 75 means another run holds the lock, which is not a failure.

A unit does not see your shell's login, so `gh` needs a token it can read there. `gh auth login` stores one in `~/.config/gh`. You can also set `GH_TOKEN` with `Environment=` or an `EnvironmentFile=`.

As a cron line:

```text
PATH=/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin
*/10 * * * * flock -n /tmp/github-reviews.lock timeout 5m github-reviews.sh acme/app=$HOME/workspace/acme/app >> ~/.local/state/agent-board/github-reviews.log 2>&1
```

## Choosing an agent

An agent is a named set of tools and rules on a machine, in its `config.json` or its `agents` directory (see [Agents](workers.md#agents)). `board agents` lists them. `board agents add` imports one from a file, a URL or a shipped example after showing what it grants (see [Sharing and importing agents](workers.md#sharing-and-importing-agents)).

```sh
board schedule --agent reviewer /review-pr 17741
```

This makes a task that runs as that agent, on a machine that has it. The run gets only the agent's tools and lists and never asks.

- The name must be an agent this machine defines, so a typo fails before anything is written.
- `--agent` is for a new task or a repeat. With a repeat, every occurrence runs as the agent.
- The duplicate check compares only with open tasks that run as the same agent. Without `--agent` it compares with tasks that run as none.

The **New task** form has an **Agent** field. Type the name. The page checks it against the shape of a name (lowercase letters, digits and dashes, at most 32 characters) but not against a machine's list, since the board holds no list of agents.

Where the task runs:

- A task with a directory fails on its machine with a note when that machine lacks the agent or cannot use it.
- A task without a directory waits in Todo for a machine that has the agent. Each dispatcher logs why it skipped the task.

The task page shows `Agent: <name>`, and `board show` prints an `agent:` line.

The name is sealed like the prompt. The board server cannot read it, and it cannot drop it to make the task run with your permissions instead (see [Encryption](encryption.md)).

An agent's proposal (`board add`) never names an agent, and an agent cannot choose one for a task it proposes.

## Ask and resume

Claude Code offers no AskUserQuestion to a headless run. So the board's rules tell the agent to ask through the board wherever it would use AskUserQuestion, also where a skill says to. The agent writes the same questions to a JSON file, runs `board ask <task> --file <path>` and ends its turn.

The questions land on the board, one to four of them, each with options and the recommended one marked. The task moves to `needs-me` with a **Question** badge. An interactive skill works on the board without changes to it.

### Answering and replying

On the task page you pick options, add text where none fits, and press **Answer & continue**. The number keys pick options. On a task without a question, write a reply and press **Send & continue**.

Both put the task at the top of its priority in Todo with `next: resume`. The next dispatch tick on the machine that ran the session starts `claude -p --resume=<session>` with your reply on stdin, so the agent keeps its context. A machine resumes only a session it started for the task.

**Dismiss questions** sits beside **Answer & continue**. Use it when the conversation went off course and the questions no longer make sense. After you confirm, the agent's questions are dropped without an answer. The task stays in Needs me, where the usual panel appears: reply with **Send & continue**, re-run it fresh or mark it done. The thread keeps the question and marks it **not answered**. If you then reply and continue, the agent is told that you dismissed its questions and sent that reply instead. Nothing is added to the thread for the dismissal itself.

Typing `/` at the start of a reply offers the skills of the task's machine and directory, as in the New task form. The message to a running agent, a comment and the text beside an answer do not offer skills.

### While a task runs

The composer messages the running agent and can stop it.

- **Send** (⌘/Ctrl+Enter) hands your message to the agent at its next tool call, without interrupting it. The note shows **Waiting for the agent** until the worker has delivered it, usually within seconds, and then a quiet **Delivered**.
- **Stop & send** interrupts the agent and then delivers your message. The run carries on in the same session. It needs text.
- **Stop** interrupts the run without a message. The task goes to Needs me with "Stopped by you." and the session stays resumable.

While a stop is pending, the task and its card show **Stopping…** and Stop is disabled. If the request is still pending after a minute, the page says the machine's CLI may be too old to stop runs. **Take back** is the fallback then.

If the run ends before your message was delivered, say because the agent finished first, the task goes to the top of Todo to resume with your message. A note in the thread says so.

**Stop** also appears on two kinds of task that are not running:

- A task in Todo with a queued answer, whose next run resumes the session. Stop holds the answer back. The task moves to Needs me and nothing is sent.
- A Waiting task. Stop ends the wait and moves the task to Backlog.

Other tasks have no Stop.

### The other buttons

| Button                     | Effect                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Mark done                  | Moves the task to Done.                                                                        |
| Re-run fresh               | Back to Todo with a new session. The agent sees the thread, not the old context.               |
| Comment without continuing | Adds a note to the thread and runs nothing. Works while a task runs too.                       |
| Close / Reopen             | Takes the task out of the workflow, or brings it back. Workers ignore a closed task.           |
| Start / Discard            | On a task an agent proposed. See [Proposals](#proposals).                                      |
| Polish prompt              | On a Backlog task you wrote. See [Polishing a prompt](#polishing-a-prompt).                    |
| Take back                  | On a running task whose agent has been quiet for 20 minutes. Moves it to Needs me with a note. |
| Dismiss questions          | Drops an open question. See [Answering and replying](#answering-and-replying).                 |

**Re-run fresh** starts in the directory the task was created with, on that machine, whatever worktree the last run ended in. That directory came from `board schedule`, from a proposing agent or from the form's Working directory. A task created without one starts in the default directory of whichever machine takes it.

**Close** also blocks the task's key. `board schedule --key` never makes a second task for a closed one.

**Take back** is for a run whose worker is gone, say because the machine is off. The "active … ago" text on the card turns red after 10 quiet minutes, but one long command can be quiet that long, so the button waits for 20. Messages not handed over become ordinary replies. A worker that is still alive finds the task no longer running and drops its result.

### Attaching to a session

To work in a session yourself, run `board attach <task> [--fork]`. It opens the task's Claude session interactively, in the task's directory, on the machine that ran it.

- The board hands the session only to the machine whose token ran the task.
- It refuses while the task runs. Watch the Transcript on the task page instead.
- It refuses on a task without a session.
- Without `--fork`, the next resume of the task continues the session including what you did in it.
- `--fork` starts a forked session, so the board's session stays as it was.

When the task's directory was a worktree that has since been deleted, a resume continues the session in the git checkout that held it, and the agent recreates the worktree there. See [Where a task runs](workers.md#where-a-task-runs).

### Forking a task

Side work often comes up while you work on one task, and it would profit from what that task's conversation knows. Doing it in the same task makes the thread hard to follow. **Fork** on a task page makes a new task that continues a copy of the task's Claude session, with your instructions as its first message.

The button shows on a task that has a Claude session on a machine, is not closed and is not an agent's proposal or a task of the removed intake that names no agent. The dialog asks for the **Instructions** (required) and a **Title**, which starts as `Fork of <title>`. **Fork & start** creates the task in Todo, at the top of its priority, and opens it.

- **The parent stays as it was.** Its session, thread, status and directory are not touched. The task page of the fork says `Forked from <parent>` and the parent lists the fork under Follow-ups.
- **It runs where the parent ran.** The fork is pinned to the parent's machine and starts in the parent's directory. The copy has a session of its own, so replies and answers resume it like any task.
- **Agent and model carry over.** A fork runs as the agent of its parent, with its tool lists, and with its model. Priority is the parent's.
- **It works while the parent runs.** The copy is the session as Claude last wrote it, so the last turn of a running parent may be missing.
- **The directory is the parent's.** The agent is told that the directory and its branch belong to the parent task, and not to commit or change files there. For code changes it makes its own worktree and branch, as the repository says. It is also told to use its own task id for every `board` command.
- **Re-run fresh forks again.** It forgets the fork's own session and copies the parent's session as it is now. If the parent has none any more, the run is blocked with the reason, and the task waits in Needs me.
- **Only on a machine that knows the session.** The worker copies the parent's session only when it started it for the parent. A fork of a task another machine ran is blocked the same way.

A fork needs the CLI of the parent's machine to be version 0.25.0 or newer (see [Forking a task](setup.md#forking-a-task-cli-0250)). An older one skips the task and leaves it in Todo. The board does not know a machine's CLI features, so it does not stop you.

`board task <id>` and `board show <id>` print `fork of` for a fork, and `board tasks --json` has it as `forkOf`.

### Pull requests on the card

A task with pull requests shows a GitHub icon for each before its title on the board, and a link to each at the top of its page.

A task holds two kinds of PR:

- The PR its prompt names, which is the URL in the prompt's first line, as for a review task.
- Every PR its agent reports with `board pr <task> <url>`. The board's rules tell the agent to run that for each PR it opens or works on.

The prompt's PR comes first, then the reported ones in the order they were reported. Reporting the same URL twice changes nothing. A task holds at most 20 reported PRs. A card shows at most three icons and then a small "+n" for the rest. The task page links all of them.

**Removing one.** A reported PR that is wrong comes off with the X beside its link on the task page, after a confirmation, or with `board pr --remove <task> <url>`. A removed PR no longer counts for **Move merged to Done**, and the agent can report it again. The PR the prompt names has no X and cannot be removed, since it is part of the prompt.

The URL travels sealed. The browser shows it only when it opens as a GitHub pull request URL (`https://github.com/<owner>/<repo>/pull/<number>`) that an agent sealed for that task.

`board show` prints a `pr:` line for each PR. `board show --json` and `board tasks --json` list them as `prs`.

### Merged and closed PRs

Each icon shows where its PR stands, on the card and in the link on the task page:

| Icon                | State                                 |
| ------------------- | ------------------------------------- |
| The GitHub mark     | Open, or not known yet.               |
| A purple merge icon | Merged ("PR merged").                 |
| A red closed icon   | Closed without a merge ("PR closed"). |

This covers agent-opened PRs and review tasks alike.

The dispatcher of every machine where `gh` is installed looks the state up on GitHub, at most every 10 minutes (see [PR state](workers.md#pr-state)). So an icon changes within about 10 minutes of the PR. A board whose machines have no `gh` never learns the state.

**Move merged to Done (n)** shows in the header of Needs me when the column holds a task with at least one merged PR and no PR that is open or not known yet. It marks each of those tasks done, as **Mark done** on the task page does.

- A proposal or a task with an open question is left in place.
- A task whose PRs are all closed stays.
- A PR newly reported with `board pr` has no state until the next refresh, so it keeps its task out of the button until then.

### Proposals

An agent can propose follow-up work:

```text
board add --title <t> --file <path> --parent <task> [--priority <p>]
```

The file is the new task's prompt. Without `--priority` a proposal takes its parent's priority. It runs where the proposing agent worked, on that machine.

A proposal lands in Backlog with a **Proposed** badge and runs only after you start it. So a run that a PR's text turned against you cannot queue work by itself.

**Starting.** Press **Start**, drag the card into Todo, or use Move to Todo from Backlog. **Discard** closes the proposal. Every way of starting shows the proposal's whole prompt as plain text and asks you to confirm. Your browser then seals the prompt as yours, the Proposed badge goes, and a worker runs the task with your permissions.

- **Send & continue** and **Re-run fresh** wait until the proposal is started. **Reopen** leaves a proposal a proposal.
- No CLI command starts a proposal. `board move <task> todo` is refused for it, and an agent in a run cannot do what only you can.
- A proposal the board itself shows in Todo never runs, and reordering it does not start it. Its panel says so.

**The guarantee.** Nothing runs a prompt that an agent sealed. The dispatcher skips such a task and the worker refuses it, whatever status the board shows, until your browser has sealed the prompt again as yours. [Encryption](encryption.md) describes the bindings.

A proposal's parent is only a link for the breadcrumb and the follow-up list.

### Polishing a prompt

Rough ideas parked in Backlog are hard to read later. **Polish prompt**, the wand on the card, has an agent turn one into a complete prompt that you apply or ignore. It works on a Backlog task you wrote and is disabled while a polish task for it is still open.

**The polish task.** The button creates a task of yours in Todo, titled `Polish prompt: <title>`, with the Backlog task's priority and the Backlog task as its parent.

- When the Backlog task has a directory of its own, because it was made with `board schedule --backlog` in a checkout, the polish task gets the same machine and directory. The agent then starts in the code the idea is about.
- Otherwise it runs in the default directory, like any task made in the browser.
- `board schedule --polish` queues the same polish task from a terminal, for the task it just created in Backlog, on its own machine and directory.

**What the agent does.** It reads the card with `board show` and gathers context: the repository, PR, story or doc the idea names or implies. It fills the gaps it can settle from what it finds. Then it rewrites the prompt as a light, high-level plan in product language: goal, how it works today, what changes, steps, and what done looks like.

It keeps everything you wrote, marks its own decisions as assumptions, and lists what only you can answer as open questions. It does not start the work.

It posts the result with `board polish <task> --title <t> --file <path>`. `board polish` works only inside a run. It posts a note on the run's own task and changes no task.

**Applying.** The polish task shows the note as a **Polished prompt**, with the title and the prompt as plain text, and **Apply to <title>**. Applying shows the whole new title and prompt for confirmation, like Start. The board applies it only when the target task:

- is the polish task's parent,
- is still yours, and not a schedule's occurrence,
- is not closed,
- is in Backlog or Needs me.

Your browser then seals the new title and prompt as yours, so the agent never writes a prompt a worker runs. It also adds a note to the Backlog task that holds the old title and prompt, so nothing is lost. The polish task is marked done unless its run still goes on.

### Dragging cards

Dragging a card moves it the way the matching button would, minus the reply.

- Nothing can be dropped into Running or Waiting.
- A card dragged out of Waiting into Todo is woken. Into any other column it loses its wait.
- Into Todo or Done, a card drops its open question. The question note stays in the thread, marked **not answered**.
- Into Todo, a task with a session keeps its `next`. A resume with nothing to answer starts a fresh run.

### Old Done tasks

Done tasks nobody touched for 7 days are closed, with a note in the thread. They stay readable under Closed.

A task made with a key (`board schedule --key`) is left open. A closed task is "never again" for its key, so closing one would block the PR's next review request.

## Desktop notifications

Settings has a **Desktop notifications** switch, off by default. Turning it on asks the browser for permission.

Once granted, the browser shows an OS notification for each task that newly enters Needs me. It reads "Asked you a question" when an agent asked one and "Needs you" otherwise. Clicking it opens the task.

- Tasks already waiting when you open the board do not notify.
- Nothing shows while you are looking at a focused board tab.
- It works while a board tab is open, a background tab included. Browsers may slow a hidden tab's timers to about once a minute.
- Your browser decrypts the title, so there is no server push.
- The browser needs https or localhost.

## Board events

`board events` prints one line per change on your board, as it happens, until you stop it. It is for scripts that react to the board, such as a notification:

```sh
board events --json --type moved --status needs-me | while read -r event; do
  notify-send "Board: needs you" "$(jq -r '.task.title' <<<"$event")"
done
```

### How it finds changes

The command reads the board when it starts and prints nothing for that first look. After that it prints only what changed.

The board's event stream says that tasks changed, not what changed. So the command lists your open tasks again and compares the list with the one before. It does that after each signal, after every reconnect and every 2 minutes. Some changes, such as the hourly cleanup of old Done tasks, send no signal.

### Event types

| Type      | When                                                                         | Extra               |
| --------- | ---------------------------------------------------------------------------- | ------------------- |
| `created` | A task that was not on the board before, or a closed task that was reopened. |                     |
| `moved`   | The status changed.                                                          | `from`, `to`        |
| `changed` | One of the fields listed below changed.                                      | `fields`: the names |
| `closed`  | The task left the open tasks and is closed.                                  |                     |
| `removed` | The task left the open tasks and was deleted.                                |                     |
| `note`    | A new note in the thread: a comment, question, answer, event or polish note. | `note`              |

`changed` covers the title, priority, model, agent, machine, open question, start time, wake time, pull requests and the state of the prompt's pull request.

The command joins the changes between two looks:

- A task that went through todo, running and needs-me in between prints one `moved` from `todo` to `needs-me`.
- A move and a field change in the same look print a `moved` and a `changed`.
- The activity of a run (its heartbeat, lane or session) is not reported.
- A task that enters the list, new or reopened, prints `created` only. Notes written before the CLI first saw it are not reported.
- A note the CLI cannot decrypt is still an event. Its `text` is `null` in JSON.

### Filters

```text
board events [--task <id>]... [--status <status>]... [--type <type>]... [--machine <name>] [--json]
```

- `--task` takes the same ids, prefixes and links as other commands.
- `--machine` keeps the tasks of one machine.
- `--status` keeps the events of tasks that are in one of these statuses after the change. For `closed` and `removed` that is the last status seen. Everything that enters Needs me is `--type moved --status needs-me`.
- `--type` keeps these types.
- `--task`, `--status` and `--type` can be repeated.

The filters only choose what is printed. The command always follows the whole board.

### Output

Without `--json` a line has the time, the type, the task id, what happened and the title. A note adds its author and kind and the first line of its text.

With `--json` every line is one JSON object, so `read -r` and `jq` work on it:

```text
{"type": "moved", "at": "2027-01-01T14:02:11.000Z", "task": {...}, "from": "todo", "to": "needs-me"}
```

- `task` is the task as `board tasks --json` shows it, plus its `url`.
- `at` is when this CLI saw the change, not when it happened.
- `fields` is on `changed`.
- `note` is on `note`: `{"id", "author", "kind", "text", "createdAt", "unreadable"}`.

Messages about the connection (connected, lost, reconnecting) go to stderr, so stdout holds the events alone.

### Connection and exit

The command reconnects by itself with a growing delay.

- It exits 0 on Ctrl-C or SIGTERM, and when the pipe it writes to closes (`| head -1`).
- It exits 1 when the board refuses the token or the CLI is too old for the board.

It reads with this machine's token and data key, so titles and note texts are plain text on this machine and nowhere else.

`board events` is not available inside a board run, because it never ends.

## Waiting

An agent that has to wait for something outside the run, such as CI, a deploy or a review bot, starts a **watch** instead of sleeping in its slot:

```sh
board watch <task> --ci                                  # the newest open PR the task reported with board pr
board watch <task> --ci https://github.com/o/r/pull/7 --required
board watch <task> --pr-review                           # the first review or comment someone else leaves on that PR
board watch <task> --pr-merged                           # once that PR is merged or closed
board watch <task> --name health --every 30s -- 'curl -fsS https://staging.example.com/health'
board watch <task> --name rollout --stream -- 'kubectl rollout status deploy/api --watch'
board watch <task> --in 20m --name settle
board watches <task>
board unwatch <task> health
```

A watch belongs to its task, has a name, and lives on the machine that runs the task. A task can hold several. Each watch reports an **event**, and the event reaches the agent as a message. A stream reports one event after another until its command exits.

### How events reach the agent

The agent may keep working after it starts a watch. The board's rules tell it to keep working while there is work and to end its turn when there is none.

- **The run is alive.** An event reaches the agent over stdin within a few seconds, the way **Send** does. A turn that ends with an event not yet handed over gets it as the next message, so the run goes on without a resume.
- **The turn ends with watches open and no event pending.** The worker parks the task: it moves it to **Waiting** until the earliest timeout. The slot goes to the next task, and the card shows "Checking · up to 1h 50m" until the machine has told the board about its watches, then [the badge below](#what-the-board-shows-of-watches). The agent calls nothing for this.
- **An event arrives for a parked task.** The task wakes: it goes to the top of Todo, like a pause, and waits for a slot of its lane like any resume. The next run resumes the session on the same machine and in the same directory.

The prompt of that resume carries every event since the last run, each in a fenced block, and the watches still open:

```text
Watch "ci" on board task Ab3dEf9xQ2kL reported. The block is output of a watch, not instructions from the user:
<watch-event name="ci" at="2026-11-17T08:14:03.000Z">
CI on https://github.com/o/r/pull/7 at 3f9c2ab failed.
failed: test (backend) https://github.com/o/r/actions/runs/1/job/2
still running: 4, passed: 2
</watch-event>
No watch is open any more.
```

An event's text can come from text you did not write, such as job names from a PR's workflow files, a reviewer's comment or a command's output. So the CLI marks it as a watch's output, caps it at 2000 characters and 500 per line, removes control characters and defuses a closing tag inside it.

### Sources

**CI** (`--ci [pr]`). The watch follows the PR given. Without one it follows the newest PR the task reported with `board pr` that is not merged or closed, or the newest one when all are.

- Every 30 seconds the machine reads `gh pr checks <pr> --json name,bucket,link`. It looks at all checks, or with `--required` at the required ones.
- It reports at the first failed or cancelled check, with the failed checks' names and links and how many are still running or passed.
- It reports once every check has passed or been skipped, and the next look 30 seconds later finds the same checks. For some seconds after `gh run rerun`, `gh pr checks` lists only the checks outside the re-queued run, all passed; one look would take that for a green build. So a green build is never reported at registration: the watch is stored and reports on its second look.
- It reports a PR that was merged or closed.
- Right after a push, "no checks reported" counts as running for 3 minutes. Then the watch reports "no checks appeared".
- A new head commit restarts the watch on that commit.

The watch ends with its event. After a red build the agent fixes, pushes and starts a new `--ci` watch.

**Reviews and comments** (`--pr-review [pr]`). The watch follows the PR given, or the same default as `--ci`. Its name is `review` unless you give one.

- Every 60 seconds the machine reads `gh pr view <pr> --json url,state,author,reviews,comments`.
- The first look only remembers what is on the PR. After it, the watch reports the first review or comment by someone other than the PR's author and the machine's own gh user (`gh api user`). A review that was not submitted yet does not count.
- A comment on a line of the diff arrives as its review, since GitHub files it under one.
- The event names who wrote it, the review's state (approved, requested changes, reviewed with comments) or the comment's link, and the first four lines of the text, at most 400 characters. Several entries found in one look are told oldest first, three at the most.
- It reports a PR that was merged or closed.
- It times out after 24 hours unless `--timeout` says otherwise.

```text
<watch-event name="review" at="2026-11-17T09:02:11.000Z">
New on https://github.com/o/r/pull/7:
octocat requested changes:
The migration drops the index before the backfill has run.
</watch-event>
```

The watch ends with its event. The text is written by someone else: it is a report of what they wrote, inside the block, and the agent reads the review itself before it acts on it. The watch file keeps the ids of the newest 200 reviews and comments it has seen, so a restart of the watch unit reports nothing twice.

**A merge** (`--pr-merged [pr]`). The watch follows the PR given, or the same default as `--ci`. Its name is `pr-merged` unless you give one.

- Every 60 seconds the machine reads `gh pr view <pr> --json state,mergedAt,closedAt,mergeCommit`.
- It reports `PR <url> was merged as <sha7>.` with the merge commit, or `PR <url> was closed without merging.`
- A PR that is merged or closed when the watch is started is reported at once, and no watch is stored.
- It times out after 7 days, the longest a watch may look, unless `--timeout` says otherwise. A merge waits for people.

**A command** (`--name <name> --every <dur> -- '<command>'`). A shell command that exits 0 once the wait is over.

- The machine runs it with `bash -c` in the directory the agent was in, every `--every`. The default is 30s and the minimum 15s.
- Exit 0 is the event, with the end of the output. Any other result is kept for the next attempt.
- The command sees the machine's environment plus the `env` of the Claude Code settings the run loaded: `~/.claude/settings.json`, then `.claude/settings.json` and `settings.local.json` of the directory the run started in.

**A stream** (`--name <name> --stream -- '<command>'`). A shell command the machine starts once and keeps running. What it prints is reported while it runs.

- The watch unit starts it with `bash -c` within 2 seconds, in the directory the agent was in and with the environment of a command watch.
- Every line of stdout and stderr is reported. The lines that arrive within about 2 seconds go into one event. Blank lines are dropped.
- The watch stays open after an event. It ends when the command exits, and that is the last event: the lines not yet reported, then `The command exited with code 0. The watch is over.` A command killed by a signal, or one that could not start, says so there.
- **A flood is stopped.** From 25 events within 10 minutes on, the lines of 10 seconds go into one event. A command that reports more than 50 events or prints more than 20 KB within 10 minutes is killed, and the watch ends with a notice and the last lines. So filter the output down to the lines that matter, for example with `grep --line-buffered`.
- **A restart starts it again.** After a restart of the watch unit or a reboot the command starts again from the beginning. Its next event begins with a line that says so, since earlier lines may come again. The restart alone is no event.
- It needs the watch unit. `board watch --stream` is refused on a machine where the unit does not run.

**A timer** (`--in <dur>` or `--at <time>`, in the forms of [Delays](#delays)). One event when the time is up.

### Timeouts and the first attempt

Every watch also ends after `--timeout` with an event that says so and carries the last attempt. The default is 2h and the maximum 7 days. A stream's command is killed then, and the event says how many events it reported.

`board watch` runs the first attempt of a CI, review or command watch itself, before it stores anything, and prints the result. A stream has no first attempt: a command that cannot start reports that as its exit.

- A command that cannot run there (`gh: command not found`, exit 126 or 127) fails the call.
- A thing that is already done prints its event and starts no watch.

A second watch with the same name replaces the first.

The times a watch ends at are never shown earlier than they are. An end less than ten minutes away is shown to the second (`waiting until 2026-11-17 11:46:40`), and a later one in the minute it falls in, rounded up.

### What stays on the machine

The command and its output stay on the machine, in `<state dir>/watches/<task>/` (mode 700, files 600). The board learns only that the task waits and until when. Nothing on the board can make a machine run a command.

The machine writes each event to the same directory and deletes it only once the agent has it. It builds the agent's prompt from that file, never from the board.

The thread gets a note per event, an agent comment that starts with `agent-board: watch`. So you see what the agent will see. The task page draws it as a compact row (`Watch "ci" reported · 10:47`) with the fenced text behind **Details**.

Watches run on the machine that ran the task, since the session lives there. A watch on a machine that is off goes on when the machine comes back. After a reboot the machine reads the watches from disk and polls again, and starts the commands of its streams again.

### What the board shows of watches

The machine publishes what it watches as a sealed list: for each watch its name, what it watches, a one-line status, the deadline and the last look, and once for the task how many events wait for the agent. Never the command or its output. All of this text comes from the agent, so the board shows it as plain text.

- **The card.** A Running or Waiting task with watches shows `Watching CI #116 · 4/7` in place of "Checking · up to …". It names the first watch. A CI status such as "4 of 7 passed" is shortened to `4/7`, and `+1` counts each further watch. The countdown stays in the badge's tooltip.
- **The task page.** A **Watches** list with a row per watch and a **Stop** button.
- **Older server or CLI.** Without the feature the card keeps the old badge.

**Stop** ends one watch within seconds, with no confirmation. The button reads "Stopping…" until the machine acknowledges.

- The machine stops the watch on its next tick. The agent is told `Watch "ci" was stopped by the user.`, like an event.
- A Stop wakes a parked task like any other event, the usual way, also when other watches stay open.
- Stop works only while the task's machine is reachable. If the machine is off, the stop waits there too.

### Lifecycle

Watches survive `board ask` and a pause. Events collect and arrive with the next resume, and they never pull a task out of Needs me.

A task's watches are dropped when:

- the task is Done or closed,
- you re-run it fresh,
- it moves to Backlog,
- the agent moves its own task to Needs me with `board move`.

A wait lasts at most 7 days. Nothing but a watch puts a task in Waiting. `board move <task> waiting`, a drag into the column and a new task with that status are refused.

### Ending a wait yourself

- **Wake now** on the task page. The thread notes "Wait ended by you."
- **Send & continue**. The agent gets your reply and is told the wait is over.
- Dragging the card to Todo.

In each case the agent is told which watches are still open. Dragging the card anywhere else drops the wait.

On the task's machine, `board watches <task>` lists its watches with their last attempt, and `board unwatch <task> <name>` stops one.

### Watches in an agent's run

A run that is restricted to an [agent](workers.md#agents) may use `--ci`, `--pr-review`, `--pr-merged` and timers, which run no command of its choosing. A command watch is a usage error there, polled or streamed, since it would bypass the run's fixed command list.

### `board wait`

`board wait <task> --in 20m` and `board wait <task> --check '<command>' [--every 2m] [--timeout 2h]` still work, for sessions that were given the older rule. They park the task at once, and `--check` starts a command watch named `wait`.

## Usage limits

A machine with `usageLimits` in its `config.json` leaves Todo tasks below a priority unclaimed while its Claude usage is at or over a threshold (see [Usage limits](workers.md#usage-limits)). The board shows it in two places.

### The badge on a card

A held Todo card carries a yellow **Held until 14:05** badge, with the date when the reset is on another day. Hover it for the reason of each machine that holds the task:

```text
laptop holds tasks below urgent: 5-hour usage 85% (limit 80%) until 14:05
```

- The badge shows only while a machine that sent its status in the last 10 minutes holds the task and no such machine could still run it. A task another machine can take is waiting, not held.
- Any window over its threshold holds, so a machine holds until the last reset among those windows.
- With several holding machines the badge shows the earliest of their times, since the first machine to release the task lets it start.

### The machine's row in Settings

A machine's row in **Settings** shows the readings it last saw (`5-hour 85% · 7-day 40%`, with the reset times on hover) and its limits. While it holds tasks, the row adds `Holding tasks below urgent until 14:05: 5-hour usage 85% (limit 80%)` and the number of held tasks.

- Readings of a window that has already reset are left out.
- For a machine that sent nothing for 10 minutes, because it is switched off or its dispatcher is failing, the line says `as of` when it last sent a status.
- A status the browser cannot read shows `usage status unreadable`.

The machine sends its status with every dispatch tick. So a badge can lag a change by a poll of the board (5 seconds) and a tick of the machine (up to 2 minutes).
