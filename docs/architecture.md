# Architecture

This document explains how agent-board is put together and why, and which rules a change has to keep. The other files in `docs/` are the detailed reference for each part.

## The idea

The board started as a replacement for a Trello board fed by headless PR reviews. Trello centred cards on their description, not the conversation. It had thin formatting, no clear "your turn" step and no way to pick from options. So agent-board puts the thread first. A run that reports, asks or fails ends in `needs-me`, and the next step is always a button: answer, reply, re-run, done.

PR review was the first use. A task is any prompt you would type into Claude Code, and its leading `/skill` decides which lane runs it.

## Components

```text
              ┌─────────────────────────────── board server ──────────────────────────────┐
 browser ───▶ auth proxy: login, sets Remote-User ──▶ Caddy ── /trpc ──────────▶ backend ──▶ Postgres
 workers ───▶ auth proxy: bearer route, no login ───▶ Caddy ── /api/machine/* ─▶ backend
              └───────────────────────────────────────────────────────────────────────────┘
                    ▲ machine API (POST, sealed)        │ SSE "tasks changed"
                    │                                   ▼
 worker machine:  board internal listen ──▶ dispatch tick ──▶ systemd-run (macOS: detached process) ──▶ worker ──▶ claude -p
                  timer: dispatch (2 min)                                     agent ──▶ board comment / ask / watch
```

| Component | Code                     | Role                                                                                                      |
| --------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Backend   | `apps/backend`           | Fastify 5 with tRPC 11 for the UI and the machine API for workers, on Drizzle and Postgres. Holds no key. |
| Frontend  | `apps/frontend`          | React 19, Mantine and TanStack Query over tRPC. Seals and opens every content field.                      |
| CLI       | `apps/cli`               | One program for people, agents and the worker machine.                                                    |
| Shared    | `packages/shared`        | The contract, the sealing rules and the crypto, with no dependencies, consumed as source.                 |
| Infra     | `infra/`, `*/Dockerfile` | Postgres init for compose. The cluster lives in the private `codeplant-de/cloud-infra` repo.              |

- **Backend.** Workers call `POST /api/machine/<command>` and read `GET /api/machine/events` (SSE). Migrations run on start.
- **Frontend.** It derives the keys from the passphrase with Argon2id and polls every 5 s. Caddy serves it, proxies the backend and strips every response header the backend sets.
- **CLI.** It runs from source on Node 24 or as a Bun-compiled binary. Its `internal` subcommands `dispatch`, `listen`, `watch` and `worker` run from systemd user units, or launchd agents on macOS. `internal hook` is the PreToolUse hook Claude Code calls during a run.
- **Shared.** It holds the contract (`contract.mts`), the sealing rules (`sealing.mts`), crypto, key slots, the fixed server event texts, and the question and transcript shapes.

## A task's life

1. **Created.** A task comes from one of five places:
   - `board schedule`, bound to this machine and directory
   - the New task form
   - a script that calls `board schedule --key`, for a review request on GitHub, say
   - a schedule's next occurrence
   - an agent's `board add` proposal

   A client that creates a task picks its 12-character id and seals title, prompt and directory against it. The server creates a schedule's occurrence itself, with a copy of the schedule's ciphertext bound to `schedule:<id>`.

2. **Todo.** The server emits a `tasks` event on the SSE stream of every machine of that owner. Each machine's listener runs a dispatch tick. The 2-minute timer is the fallback.
3. **Claimed.** The dispatch tick plans free lane slots and calls `claim-task`, which is atomic, so one machine wins. It starts the worker as a transient systemd unit `agent-board-<id>`. On macOS the worker is a detached process tracked by a pid file in the run directory (`setup/process-system.mts` is the second implementation of `System`).
4. **Running.** The worker opens the sealed prompt and starts `claude -p` with the board's rules (`--append-system-prompt`) and a PreToolUse hook (`--settings`).
   - The prompt goes in on stdin as a stream-json user message, and stdin stays open. The worker later writes your messages, a pause request and interrupts to it.
   - The hook keeps a heartbeat and records the working directory.
   - The worker streams condensed, sealed transcript events to the board every 15 s.
5. **Reporting.** The agent uses `board comment`, `board ask`, `board watch`, `board pr` and `board add`. These are the same CLI, authenticated by the machine's token, which reaches every task of the owner.
   - `AGENT_BOARD_TASK` marks the process as a run, so `board schedule` refuses and `board polish` posts on the run's own task.
   - `AGENT_BOARD_RUN` is the board's id of the run (see [Design decisions](#design-decisions)). The agent's calls for its own task carry it, so an agent left over from an earlier run cannot ask, wait or move the task under a later one.
   - The browser may remove a PR the agent reported (`tasks.removePr`, and `remove-pr` for the CLI), because that deletes a row and seals nothing. It never writes a reported PR, which only an agent seals.
6. **Needs me.** The run ends. You answer, reply, re-run or mark it done in the browser. A reply puts the task back in Todo with `next: resume`. The machine that holds the Claude session resumes it, in the directory the agent last worked in.

## Trust model

The design assumes the server and database may be hostile, and that any PR text an agent reads may be too. Two mechanisms carry this.

**Who created a task, and the agent it names, decide how it runs.** A task that names an agent runs as that agent, whoever made it (see [Agents](workers.md#agents)). Otherwise `createdBy` is the permission bit:

| Creator  | Runs as                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `user`   | Your full settings and `--permission-mode auto`, as if you typed the prompt yourself.                                  |
| `intake` | Tasks of the removed built-in intake, which run only when they name an agent.                                          |
| `agent`  | Never runs. A proposal waits in `backlog` until you press Start, and then the browser seals the prompt again as yours. |

**Every content field is sealed for its purpose.** The clients encrypt with AES-256-GCM. Each envelope's additional data binds it to the owner, the field, the row and the creator or author. So the server cannot:

- move a prompt to another task
- relabel another creator's prompt as yours
- present an agent's note as your reply
- write a note of its own beyond the fixed event texts

A value that does not open under its exact binding is unreadable, and nothing falls back to a looser reading. The table of bindings is in [encryption.md](encryption.md), and `packages/shared/src/sealing.mts` is its single implementation.

The server can still decide when and where a task runs, reorder or withhold notes, and replay older values of the same task. [encryption.md](encryption.md#what-the-server-can-still-do) lists all of it.

**Sign-in is the proxy's job.** The backend has no login of its own. It takes the user from the `Remote-User` header and checks `Remote-Groups` against `ALLOWED_GROUPS`.

- That is only safe behind a proxy that signs the user in, strips any `Remote-*` header the client sent, and sets its own.
- Stripping at the edge does not cover callers that reach the backend without passing the proxy, such as another pod in the cluster. So the backend takes those headers only together with `Board-Proxy-Secret`, a shared secret (`PROXY_SECRET`) that the web container's Caddy adds to every request it proxies.
- The backend compares the secret in constant time and refuses to start in production without it. Without the secret, a request to `/trpc` is a 403 whatever `Remote-*` headers it carries.
- Never expose the backend's `/trpc` without such a proxy.
- The machine API is the exception. The proxy lets `/api/machine/*` through without a login, and the backend checks the bearer token itself.

Which proxy does this is a deployment choice. [operations.md](operations.md#the-board-server) describes the current one.

**Multi-tenancy.** Each signed-in user (`Remote-User`) has a private board. Requests run as the unprivileged `board_app` role with row-level security on `app.owner`, set per request transaction (`apps/backend/src/db/scope.ts`). The privileged `DATABASE_URL` is used only at start, for role setup and migrations. There is deliberately no fallback to it, because a superuser or table owner bypasses RLS.

**No sandbox.** A worker runs as you. A sandbox per command could not support implementation work (worktrees, installs, pushes). Once an agent may push, the boundary that matters is the machine and its credentials. Permission rules are not a security boundary. A dedicated OS user for workers is the planned way to get one.

## Versioning

The CLI sends `version` once per process and checks the server's API range (see [Version handshake](machine-api.md#version-handshake)).

- It stops when its `API_VERSION` is below the server's `minClient`, or when the server's version is below its own `MIN_SERVER`.
- A server that is merely older makes the unattended dispatch tick skip quietly until the server catches up.
- CLIs up to 0.7.0 compare `contract` exactly. The server keeps answering it (`LEGACY_CONTRACT`, 9) until a break raises `MIN_CLIENT` above it.

The server deploys on every merge to `main`. The CLI updates only through a `cli-v*` release and `board self-update`. So a raised `MIN_CLIENT` leaves every older machine refusing to work until it is updated.

**The numbers are a break level, not a count of changes.** An additive change adds a feature name and bumps no number, so parallel branches do not collide. Additive means a new machine command, a new optional request field, or a new enum value with a vocabulary row (see [Features](machine-api.md#features)).

- The server answers the features it has. The CLI checks the one it needs, and a missing one disables only that command.
- The CLI sends the vocabulary it understands, and the server leaves out what the client cannot read.

**A new enum value in a response** is additive if it gets a vocabulary feature. It is breaking if it does not, or if it changes what an existing value means. Older CLIs parse strictly: a list skips an item it does not know, and a single object fails.

**A break** raises `API_VERSION`, then `MIN_CLIENT` to it. It ships with a CLI version bump, an Upgrading note in [setup.md](setup.md#upgrading), and a CLI release, which CI makes after the merge and before the images. CI fails a pull request, and a push to `main`, that raises `MIN_CLIENT` without a CLI version above the newest `cli-v*` tag. It also runs the newest release against the pull request's server.

## Design decisions

| Decision                                                                                                                          | Why                                                                                                                                                                                                | Rejected                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A task is a prompt, and its leading `/skill` picks the lane                                                                       | Works for any skill without per-type code                                                                                                                                                          | Task types and labels in config                                                  |
| Workers on your own machines, not in the cluster                                                                                  | They need your checkouts, logins and Claude Code session files                                                                                                                                     | Hosted workers                                                                   |
| Lanes with borrowing, and lane bias beats priority                                                                                | Parallelism per kind of work without a scheduler, and idle slots never wait                                                                                                                        | Global priority queue                                                            |
| Pause and stop through claude's stream-json stdin: a message, then an interrupt                                                   | The session stays clean, with no refused tool calls to confuse it. A paused run can say where it stopped, and you can reach a running agent                                                        | A hook that denies tool calls; killing runs                                      |
| Heartbeat on every tool call, 15 min idle, 6 h max                                                                                | Foreground Bash is capped at 10 min, so a quiet agent is stuck                                                                                                                                     | Fixed run timeouts                                                               |
| SSE for "something changed", writes stay POST                                                                                     | Plain GET on the existing token route, through Caddy                                                                                                                                               | WebSocket                                                                        |
| `board events` derives changes on the client by comparing two listings                                                            | The stream carries no data and the server cannot read titles or notes, so only a client with the data key can say what changed. A note count per task (`noteCount`) tells it which threads to read | A server-side change log; sending content over the stream                        |
| Keep the 2-minute timer next to the listener                                                                                      | The stale sweep, missed events and a dead listener have no event. Delays, waits, checks and take-backs run on the listener's own timer, set to what each tick says is next due                     | Event stream only; a server-side tick                                            |
| Board rules and hook passed per run (`--append-system-prompt`, `--settings`)                                                      | Nothing to install in `~/.claude`, so no machine can miss it                                                                                                                                       | A Claude Code plugin                                                             |
| The directory list is enforced from the machine's own `config.json`                                                               | The server may be hostile. A list it holds, including the copy each machine sends it (`machine.dirs`), is advice the worker cannot rely on                                                         | Enforcing a list the server holds                                                |
| Each machine sends a sealed catalogue of its skills and models, found by asking `claude`                                          | The browser completes `/skill` and offers models, and only the program that runs a task knows its plugins and bundled skills. The probe costs no tokens, and no CLI reads the copy back            | Reading skill folders; an unsealed list                                          |
| Each machine sends a sealed usage status: limits, readings, the tasks it holds and the tasks it leaves open                       | The browser can say which machine holds a task, for which window and until when. The open list lets it tell a held task from one that only waits for a slot elsewhere                              | Showing the dispatcher log; a server-side hold                                   |
| `board ask` instead of AskUserQuestion                                                                                            | Headless `claude -p` offers no AskUserQuestion. The hook stays offline, so it never slows a tool call                                                                                              | Waiting on Claude Code                                                           |
| A schedule keeps one pending card, and missed runs are skipped                                                                    | A machine that was off finds one card, not a pile. No server timer                                                                                                                                 | Catch-up runs                                                                    |
| Agent output that changes your text is a suggestion you apply (`board polish`, `--suggest`)                                       | An agent must never seal anything as `user`                                                                                                                                                        | Agents editing tasks                                                             |
| Bun-compiled release binary                                                                                                       | No Node to find on a worker machine, which was the most fragile part of installing                                                                                                                 | esbuild bundle on Node                                                           |
| Duplicate check by a Haiku call for scheduled tasks, and a blind-indexed dedupe key only for scripts (`board schedule --key`)     | A key does not fit free-form prompts                                                                                                                                                               | Dedupe keys everywhere                                                           |
| Slack intake was built and removed (`/board <text>`, a Send to board shortcut, an inbox)                                          | The bot had to be invited to every channel, and a worker can read a Slack message through your own claude.ai connector when a task links to it                                                     | A Slack app as the way in                                                        |
| An open task's worktree is locked with `git worktree lock`, and the dispatcher unlocks it once the task is finished               | A cleanup's plain `git worktree remove` refuses and names the task. The worker never learns that a task is done, so the sweep that already drops a finished task's files takes the lock off        | -                                                                                |
| Changing a task's directory drops its session, and only the user does it (`board task set dir`, refused in a run)                 | Claude Code keeps a session under its working directory and cannot resume it from another one. See the note below                                                                                  | Resuming the session in the new directory; keeping the old directory as the home |
| Every claim gets a run id, and a run's calls for its task name it                                                                 | Status and the token's machine cannot tell two runs on the same machine apart. The id is opaque and exact, unlike `runStartedAt`                                                                   | Comparing `runStartedAt`; fencing by machine only                                |
| Agent definitions are files on each machine, and `board agents add` shows every grant, asks before it writes and never re-fetches | A definition decides what an unattended run may do, so it must not change without the user reading it. A copy on the board could swap one machine's rules for another's                            | Definitions held (sealed) on the board; URLs that update themselves              |
| Watches run in a unit of their own (`agent-board-watch.service`) with all state on disk                                           | Polls leave the dispatch tick's 2-minute pace and 45-second budget. The unit can restart at any time without losing a watch                                                                        | Watches inside the listener; a server-side poller                                |
| A watch event reaches the agent from a spool file on the machine, never from a board note                                         | The server can withhold or replay a note, and an event can hold text you did not write. The file is deleted only once handed over, so no event is lost between a park and its wake                 | Reading the wake note back, as `board wait` does                                 |
| The watch unit and the dispatch tick share watches through a heartbeat file, and finish one by renaming its file                  | No lock to leak when a process dies. Whoever renames first writes the event                                                                                                                        | File locks; a socket between the two                                             |
| The dispatch tick compares each task's published watches with the store and publishes again when they differ                      | Publishing is best effort and comes after the store changed, so a crash in between leaves the board stale. The tick already has both sides in hand                                                 | A journal of unpublished changes; publishing before the store changes            |
| Stop on the board goes through the dispatch tick as a `stopped` event; the board only lists the ids (`watchStops`)                | The server can neither run nor read a watch, so it can only ask. The machine ends the watch itself and tells the agent like any event, and an id it has no watch for does nothing                  | The board deleting a watch; a command the machine runs for the server            |
| A woken task waits for a slot of its lane like any resume                                                                         | The lane limit stays strict, and an event for a live run needs no slot at all                                                                                                                      | Overbooking a lane by one for a wake                                             |

**Changing a task's directory.** The next run starts fresh in the new directory and reads the thread. The new directory also becomes `home_workdir`, so Re-run fresh keeps it. An agent must not move a task or pick its model. The refusal is the CLI's, like `board schedule`'s, so it has the limit stated in rule 2: an agent that reads the data key and the machine token can call `configure-task` itself.

## Rules for changes

Break one of these only with a decision recorded here.

1. **The server never needs plaintext.** New content fields are sealed in the client with a binding in `sealing.mts`, listed in `apps/backend/src/db/sealedColumns.ts` and guarded by a database check. Validation of content happens in the clients.
2. **Nothing runs unless your own client sealed it as runnable.** No code path seals a prompt as `user` for an agent or for the server. Proposals and polish are suggestions you apply in the browser. An agent cannot create a task that starts by itself: `board schedule` refuses inside a run, and the reviewer agent's allow-list excludes it. The limit of this rule is that the data key sits in `~/.config/agent-board/env`, so an agent in `auto` mode that reads the file can seal anything.
3. **Clear values from the server are checked to a tight shape** before they reach argv, a path, a unit name, the shell or the agent. The CLI builds the task link from its own `web.json`, and server error text is quoted, cut and labelled.
4. **The prompt reaches `claude` on stdin**, never as an argument.
5. **Every machine API command is atomic** under concurrent callers (several machines, workers, the browser). Claims return 409 to the losers.
6. **A resume runs only on the machine that holds the session,** and only a session that machine started for the task.
7. **Contract changes follow [Versioning](#versioning).**
8. **CLI code runs on Node and Bun.** Use `node:` APIs only, never `Bun.*`.
9. **Keep `docs/` true.** A behaviour change updates the doc that describes it. The command reference is generated, and a test checks it.

## Where to find things

| Concern                                           | Code                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Wire types, statuses, `API_VERSION` etc.          | `packages/shared/src/contract.mts`                                                |
| Sealing bindings, crypto                          | `packages/shared/src/sealing.mts`, `crypto.mts`, `keys.mts`                       |
| Machine API                                       | `apps/backend/src/machine-api.ts`                                                 |
| UI API                                            | `apps/backend/src/trpc/router.ts`                                                 |
| Task logic, schedules, retention                  | `apps/backend/src/services/`                                                      |
| Schema, RLS scope, migrations                     | `apps/backend/src/db/`, `apps/backend/drizzle/`                                   |
| Change events                                     | `apps/backend/src/services/changes.ts` (in-process, one replica)                  |
| Dispatch decisions                                | `apps/cli/src/dispatch/decide.mts`, `dispatch.mts`                                |
| Run plan, prompts, limits                         | `apps/cli/src/worker/plan.mts`, `prompts.mts`                                     |
| Running Claude, transcripts                       | `apps/cli/src/worker/worker.mts`, `process.mts`, `transcript-upload.mts`          |
| Hook                                              | `apps/cli/src/worker/hook.mts`                                                    |
| PR state lookup                                   | `apps/cli/src/dispatch/pr-states.mts`, `github.mts`                               |
| systemd units, launchd agents, worker supervision | `apps/cli/src/setup/setup.mts`, `launchd.mts`, `system.mts`, `process-system.mts` |
| The `board` commands                              | `apps/cli/src/commands/`                                                          |
| Browser keys                                      | `apps/frontend/src/crypto/`                                                       |

## Known limits

- Change events live in the backend process, so the server runs one replica. Postgres `LISTEN/NOTIFY` would lift that.
- Workers have no OS-level isolation.
- On macOS a run is not a cgroup. When it ends, what stayed in the agent's process group is killed, but a process that started its own session (a daemon, `setsid`) survives it. A stop from the dispatcher's sweep has the same gap.
- A Mac worker runs only while its user is logged in and awake. The worker holds `caffeinate -i` during a run.
- A raised `MIN_CLIENT` is a coordinated rollout.
- Turning GitHub review requests into tasks is a script (`github-reviews`) that each machine runs on its own timer, not part of the dispatcher.
