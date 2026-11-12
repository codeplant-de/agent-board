# agent-board

A Trello board is the queue. A systemd user timer runs a dispatcher every two minutes. The dispatcher takes cards from the top of Todo and starts a headless `claude -p` worker for each, with a cap on parallel runs. The worker reports on the card. Phase 1 is PR review.

Trello is the only state. There is no database and no state file: the card's list says where it is, and the worker unit says when it started.

## Board

Four lists: **Todo**, **Running**, **Needs me**, **Done**. Order in Todo is priority. A card's label picks the worker. The first line of the description is the input (a PR URL); intake adds a `head: <sha>` line.

A finished card moves itself to Needs me. A card that fails, times out, has no known label, or whose worker disappears also ends in Needs me, with the reason and the end of the log as a comment.

## Install

Needs Node 24+, `flock`, `systemd-run`, `gh` and `claude`. No runtime dependencies; `npm install` only adds TypeScript for the type check.

1. Create a Trello board and note its ID or short link (the part after `/b/` in the URL).
2. Create an API key and token at https://trello.com/power-ups/admin and put them in `~/.config/agent-board/env`, mode 600:

   ```
   TRELLO_API_KEY=...
   TRELLO_TOKEN=...
   ```

   The key and token are sent in the `Authorization` header and are never put in a URL or printed. A file with any other mode is refused.
3. Copy `config.example.json` to `~/.config/agent-board/config.json` and set `boardId`.
4. `./install.sh` symlinks the units into `~/.config/systemd/user`, `bin/board` into `~/.local/bin` and the skill into `~/.claude/skills`. It enables and starts nothing.
5. `board setup` creates the missing lists and one label per entry in `labels`.
6. Enable when ready:

   ```
   systemctl --user enable --now agent-board-dispatch.timer
   systemctl --user enable --now agent-board-intake.timer
   ```

The units expect the repo at `~/workspace/agent-board`; edit `ExecStart` if it lives elsewhere. They set `PATH` to include `~/.local/share/mise/shims` because Node is not on the default user PATH.

User timers only run while you are logged in. For runs after logout: `loginctl enable-linger $USER`.

## Config

`~/.config/agent-board/config.json` (`AGENT_BOARD_CONFIG_DIR` changes the directory):

| Key | Meaning |
| --- | --- |
| `boardId` | Trello board ID or short link. |
| `maxParallel` | Cards in Running at once. Default 2. |
| `timeoutMinutes` | A worker is stopped after this long. Default 45. |
| `slackWebhookFile` | One-line file with the Slack incoming webhook URL, mode 600. |
| `intakeLabel` | Label intake puts on new cards. Default `review-pr`. |
| `repos` | `owner/name` to local checkout. A PR in another repo is ignored by intake and sent to Needs me by the worker. |
| `labels` | Label name to worker, below. |

Logs: `~/.local/state/agent-board/logs/<card>.log`, one per card, emptied when a worker starts. The worker's own fatal errors are appended to it.

## Adding a label-to-worker mapping

Create a label on the board with the same name as the key, or run `board setup`. Two shapes:

```json
"review-pr": {
  "skill": "board-review-pr",
  "cwd": "pr-repo",
  "allowedTools": ["Read", "Bash(board *)"],
  "disallowedTools": ["Bash(git push *)"]
}
```

Runs `claude -p "/<skill> <card> <first line of description>" --permission-mode dontAsk --setting-sources user` with these allow and deny rules. `dontAsk` denies everything not allowed, without prompting. `--setting-sources user` keeps the checkout's `.claude/settings*.json` (their allow rules and env tokens) out of the run; only `~/.claude/settings.json` loads. If you ever add `permissions.allow` rules there, they widen the reviewer's sandbox too. Rules starting with `Bash(` expand `~/` to your home directory and `{pr-review}` to the install path of the `pr-review@ccc` plugin, read from `~/.claude/plugins/installed_plugins.json` when the worker starts. A rule must not start with `*` before a script path: a leading `*` matches any command that merely contains the path. If the plugin path cannot be resolved the card goes to Needs me with the reason. `Read(...)` rules are passed on unchanged (they take `~/` themselves).

`cwd` is `pr-repo` (the checkout `repos` maps the PR's repository to) or a directory. The skill must exist in `~/.claude/skills`, and it should end by moving the card to Needs me.

```json
"selftest": { "command": ["sleep", "300"] }
```

Runs a plain command (optional `cwd`). Use it to test the cap and the sweep without spending tokens. An exit code other than 0 is a failure; exit 0 with the card in any list but Needs me or Done is reported as "finished without reporting".

Known gaps of the headless review: it loads no project settings, so the Shortcut MCP token from the project settings is missing and `mcp__shortcut__get_story` may fail (the skill treats the story lookup as best effort). The review is not mirrored into the brain journal; do that by hand if you want it.

A missing allowed tool shows up as a failed run: the log says what was denied. Add it to `allowedTools`.

## Commands

```
board lists                     cards per list
board comment <card> <text>     add a comment; `-` reads the text from stdin
board move <card> <list>        move to the bottom of a list
board notify <card> <text>      Slack message with the card link
board setup                     create missing lists and labels
dispatch                        one dispatcher tick
intake                          review requests to cards
```

`<card>` is the short link from the card URL. `dispatch`, `intake` and `board` take `--dry-run`: reads happen, every write and process start is printed as `DRY ...`. An unknown argument is a usage error. `board` only touches cards of the configured board.

`bin/dispatch` and `bin/intake` take their own lock (`$XDG_RUNTIME_DIR/agent-board-{dispatch,intake}.lock`), so a run by hand cannot overlap a timer run. When the lock is held they exit 75 without output.

## How it decides

Dispatcher, per tick:

1. For each card in Running, ask `systemctl --user is-active agent-board-<card>`. A card whose unit is gone, or whose unit started more than the timeout plus five minutes ago (the start comment is the fallback), moves to Needs me with the log tail. If `systemctl` gives no known state, the tick stops before starting anything and exits non-zero. The worker enforces the timeout itself; this catches a worker that died.
2. While fewer than `maxParallel` run (the larger of the cards in Running and the active `agent-board-*` units), take the top card of Todo. No known label: Needs me with a comment. Otherwise: Running, start `systemd-run --user --collect --unit agent-board-<card>`, then comment the start time and PID. The first failed start ends the tick's starting.

Intake, per run: search each repo in `repos` for open, non-draft PRs that request your review, then create one card per PR URL, checked against every card on the board, archived ones included (an archived card is never requeued). A PR that `gh pr view` cannot read is logged and skipped. A PR whose head moved and whose last commit is at least ten minutes old sends its card from Needs me or Done back to Todo. A failed card stays in Needs me until the head moves. A failed GitHub search changes nothing and exits non-zero. The age of a head is the date of its last commit, so a push of old commits counts as settled.

## Development

```
npm test           node --test
npm run typecheck  tsc --noEmit
```

Decision logic is in `src/decide.mts`, `planIntake` and the `run*` functions, which take a Trello client, GitHub and system interface as arguments. Tests inject fakes (`test/helpers.mts`).
