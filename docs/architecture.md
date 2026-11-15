# Architecture

This document explains how agent-board is put together and why, and which rules a change has to keep. The other files in `docs/` are the detailed reference for each part.

## The idea

The board started as a replacement for a Trello board fed by headless PR reviews. Trello centred cards on their description rather than the conversation, had thin formatting, and had no clear "your turn" step and no way to pick from options. So agent-board puts the thread first. A run that reports, asks or fails ends in `needs-me`, and the next step is always a button: answer, reply, re-run, done.

PR review was the first use. A task is any prompt you would type into Claude Code, and its leading `/skill` decides which lane runs it.

## Components

```
              ┌─────────────────────────────── board server ──────────────────────────────┐
 browser ───▶ auth proxy: login, sets Remote-User ──▶ Caddy ── /trpc ──────────▶ backend ──▶ Postgres
 workers ───▶ auth proxy: bearer route, no login ───▶ Caddy ── /api/machine/* ─▶ backend
              └───────────────────────────────────────────────────────────────────────────┘
                    ▲ machine API (POST, sealed)        │ SSE "tasks changed"
                    │                                   ▼
 worker machine:  board internal listen ──▶ dispatch tick ──▶ systemd-run ──▶ worker ──▶ claude -p
                  timers: dispatch (2 min), intake (10 min)        agent ──▶ board comment / ask / wait
```

| Component | Code                     | Role                                                                                                                                                                                                                                                                              |
| --------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend   | `apps/backend`           | Fastify 5, tRPC 11 for the UI, `POST /api/machine/<command>` for workers, `GET /api/machine/events` (SSE). Drizzle on Postgres; migrations run on start. Holds no key.                                                                                                            |
| Frontend  | `apps/frontend`          | React 19, Mantine, TanStack Query over tRPC. Derives the keys from the passphrase (Argon2id), seals and opens every content field. Polls every 5 s. Served by Caddy, which also proxies the backend and strips every response header the backend sets.                            |
| CLI       | `apps/cli`               | One program for people, agents and the worker machine. Runs from source on Node 24 or as a Bun-compiled binary. Its `internal` subcommands `dispatch`, `intake`, `listen` and `worker` run from systemd user units; `hook` is the PreToolUse hook Claude Code calls during a run. |
| Shared    | `packages/shared`        | No dependencies, consumed as source. The contract (`contract.mts`), the sealing rules (`sealing.mts`), crypto, key slots, the fixed server event texts, question and transcript shapes.                                                                                           |
| Infra     | `infra/`, `*/Dockerfile` | Postgres init for compose, and a patch for the separate `codeplant-de/cloud-infra` repo (cluster, login proxy, backups).                                                                                                                                                          |

## A task's life

1. **Created.** `board schedule` (bound to this machine and directory), the New task form, intake (a review request on GitHub), a schedule's next occurrence, or an agent's `board add` proposal. A client that creates a task picks its 12-character id and seals title, prompt and directory against it. The server creates a schedule's occurrence itself, with a copy of the schedule's ciphertext bound to `schedule:<id>`.
2. **Todo.** The server emits a `tasks` event on the SSE stream of every machine of that owner. Each machine's listener runs a dispatch tick; the 2-minute timer is the fallback.
3. **Claimed.** The dispatch tick plans free lane slots, calls `claim-task` (atomic, one machine wins) and starts the worker as a transient systemd unit `agent-board-<id>`.
4. **Running.** The worker opens the sealed prompt and starts `claude -p` with the board's rules (`--append-system-prompt`) and a PreToolUse hook (`--settings`). The prompt goes in on stdin. The hook keeps a heartbeat, records the working directory, and enforces pauses. The worker streams condensed, sealed transcript events to the board every 15 s.
5. **Reporting.** The agent uses `board comment`, `board ask`, `board wait` and `board add`. These are the same CLI, authenticated by the machine's token, which reaches every task of the owner. `AGENT_BOARD_TASK` marks the process as a run, so `board schedule` refuses and `board polish` posts on the run's own task.
6. **Needs me.** The run ends. You answer, reply, re-run or mark it done in the browser. A reply puts the task back in Todo with `next: resume`, and the machine that holds the Claude session resumes it, in the directory the agent last worked in.

## Trust model

The design assumes the server and database may be hostile, and that any PR text an agent reads may be too. Two mechanisms carry this.

**Who created a task decides how it runs.** `createdBy` is the only permission bit:

| Creator  | Runs as                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `user`   | Your full settings and `--permission-mode auto`, as if you typed the prompt yourself.                                               |
| `intake` | `--permission-mode dontAsk`, user settings only, a narrow allow-list from `config.json`. Its input is PR text nobody chose to read. |
| `agent`  | Never runs. A proposal waits in `needs-me` until you press Start, and then the browser seals the prompt again as yours.             |

**Every content field is sealed for its purpose.** The clients encrypt with AES-256-GCM. Each envelope's additional data binds it to the owner, the field, the row and the creator or author. So the server cannot move a prompt to another task, relabel an intake prompt as yours, present an agent's note as your reply, or write a note of its own beyond the fixed event texts. A value that does not open under its exact binding is unreadable, and nothing falls back to a looser reading. The table of bindings is in [encryption.md](encryption.md), and `packages/shared/src/sealing.mts` is its single implementation.

What the server can still do: decide when and where a task runs, reorder or withhold notes, and replay older values of the same task. [encryption.md](encryption.md#encryption) lists all of it.

**Sign-in is the proxy's job.** The backend has no login of its own. It takes the user from the `Remote-User` header and checks `Remote-Groups` against `ALLOWED_GROUPS`. That is only safe behind a proxy that signs the user in, strips any `Remote-*` header the client sent, and sets its own. Never expose the backend's `/trpc` without one. The machine API is the exception: the proxy lets `/api/machine/*` through without a login, and the backend checks the bearer token itself. Which proxy does this is a deployment choice; [operations.md](operations.md#the-board-server) describes the current one.

**Multi-tenancy.** Each signed-in user (`Remote-User`) has a private board. Requests run as the unprivileged `board_app` role with row-level security on `app.owner`, set per request transaction (`apps/backend/src/db/scope.ts`). The privileged `DATABASE_URL` is used only at start, for role setup and migrations. There is deliberately no fallback to it, because a superuser or table owner bypasses RLS.

**No sandbox.** A worker runs as you. A sandbox per command could not support implementation work (worktrees, installs, pushes), and once an agent may push, the boundary that matters is the machine and its credentials. Permission rules are not a security boundary. A dedicated OS user for workers is the planned way to get one.

## Versioning

The CLI sends `version` once per process and checks the server's API range (see [machine-api.md](machine-api.md#version-handshake)): it stops when its `API_VERSION` is below the server's `minClient`, or when the server's version is below its own `MIN_SERVER`. A server that is merely older makes the unattended dispatch and intake ticks skip quietly until it catches up. CLIs up to 0.7.0 compare `contract` exactly, so the server keeps answering it (`LEGACY_CONTRACT`, 9) until a break raises `MIN_CLIENT` above it. The server deploys on every merge to `main`, while the CLI updates only through a `cli-v*` release and `board self-update`, so a raised `MIN_CLIENT` leaves every older machine refusing to work until it is updated.

- The numbers are a break level, not a count of changes. An additive change adds a **feature name** and bumps no number, so parallel branches do not collide: a new machine command, a new optional request field, a new enum value with a vocabulary row (see [machine-api.md](machine-api.md#features)). The server answers the features it has, the CLI checks the one it needs and a missing one disables only that command; the CLI sends the vocabulary it understands, and the server leaves out what the client cannot read. `board attach` and suggested replies shipped this way.
- A new enum value in a response is additive if it gets a vocabulary feature, and breaking if it does not or if it changes what an existing value means: then older CLIs parse it strictly (a list skips an item it does not know, a single object fails). Contracts 8 (`polish` notes) and 9 (`waiting`) were bumped for this, before the vocabulary features existed.
- A break (`API_VERSION` raised, then `MIN_CLIENT` to it) ships with a CLI version bump, an Upgrading note in [setup.md](setup.md#upgrading), and a CLI release right after the merge. CI fails a pull request that raises it without a CLI version above the newest `cli-v*` tag, and runs the newest release against the pull request's server.

## Design decisions

| Decision                                                                                        | Why                                                                                     | Rejected                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| A task is a prompt; its leading `/skill` picks the lane                                         | Works for any skill without per-type code                                               | Task types and labels in config |
| Workers on your own machines, not in the cluster                                                | They need your checkouts, logins and Claude Code session files                          | Hosted workers                  |
| Lanes with borrowing; lane bias beats priority                                                  | Parallelism per kind of work without a scheduler; idle slots never wait                 | Global priority queue           |
| Cooperative pause through the PreToolUse hook                                                   | A paused run can say where it stopped and resume in its session                         | Killing runs                    |
| Heartbeat on every tool call; 15 min idle, 6 h max                                              | Foreground Bash is capped at 10 min, so a quiet agent is stuck                          | Fixed run timeouts              |
| SSE for "something changed", writes stay POST                                                   | Plain GET on the existing token route, through Caddy                                    | WebSocket                       |
| Keep the 2-minute timer next to the listener                                                    | Delays coming due, the stale sweep, slot take-back and missed events have no event      | Event stream only               |
| Board rules and hook passed per run (`--append-system-prompt`, `--settings`)                    | Nothing to install in `~/.claude`, so no machine can miss it                            | A Claude Code plugin            |
| `board ask` instead of AskUserQuestion                                                          | Headless `claude -p` offers no AskUserQuestion; the hook would bridge it if it ever did | Waiting on Claude Code          |
| A schedule keeps one pending card; missed runs are skipped                                      | A machine that was off finds one card, not a pile; no server timer                      | Catch-up runs                   |
| Agent output that changes your text is a suggestion you apply (`board polish`, `--suggest`)     | An agent must never seal anything as `user`                                             | Agents editing tasks            |
| Bun-compiled release binary                                                                     | No Node to find on a worker machine, the most fragile part of installing                | esbuild bundle on Node          |
| Duplicate check by a Haiku call for scheduled tasks; a blind-indexed dedupe key only for intake | A key does not fit free-form prompts                                                    | Dedupe keys everywhere          |

## Rules for changes

Break one of these only with a decision recorded here.

1. **The server never needs plaintext.** New content fields are sealed in the client with a binding in `sealing.mts`, listed in `apps/backend/src/db/sealedColumns.ts` and guarded by a database check. Validation of content happens in the clients.
2. **Nothing runs unless your own client sealed it as runnable.** No code path seals a prompt as `user` for an agent or for the server: proposals and polish are suggestions you apply in the browser. An agent cannot create a task that starts by itself: `board schedule` refuses inside a run, and intake's allow-list excludes it. The limit of this rule: the data key sits in `~/.config/agent-board/env`, so an agent in `auto` mode that reads the file can seal anything.
3. **Clear values from the server are checked to a tight shape** before they reach argv, a path, a unit name, the shell or the agent. The task link is built by the CLI from its own `web.json`, and server error text is quoted, cut and labelled.
4. **The prompt reaches `claude` on stdin**, never as an argument.
5. **Every machine API command is atomic** under concurrent callers (several machines, workers, the browser). Claims return 409 to the losers.
6. **A resume runs only on the machine that holds the session,** and only a session that machine started for the task.
7. **Contract changes follow [Versioning](#versioning).**
8. **CLI code runs on Node and Bun.** Use `node:` APIs only, never `Bun.*`.
9. **Keep `docs/` true.** A behaviour change updates the doc that describes it. The command reference is generated, and a test checks it.

## Where to find things

| Concern                                  | Code                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Wire types, statuses, `API_VERSION` etc. | `packages/shared/src/contract.mts`                               |
| Sealing bindings, crypto                 | `packages/shared/src/sealing.mts`, `crypto.mts`, `keys.mts`      |
| Machine API                              | `apps/backend/src/machine-api.ts`                                |
| UI API                                   | `apps/backend/src/trpc/router.ts`                                |
| Task logic, schedules, retention         | `apps/backend/src/services/`                                     |
| Schema, RLS scope, migrations            | `apps/backend/src/db/`, `apps/backend/drizzle/`                  |
| Change events                            | `apps/backend/src/services/changes.ts` (in-process, one replica) |
| Dispatch decisions                       | `apps/cli/src/decide.mts`, `dispatch.mts`                        |
| Running Claude, transcripts              | `apps/cli/src/worker.mts`                                        |
| Hook                                     | `apps/cli/src/hook.mts`                                          |
| Intake                                   | `apps/cli/src/intake.mts`, `github.mts`                          |
| systemd units                            | `apps/cli/src/setup.mts`, `system.mts`                           |
| Browser keys                             | `apps/frontend/src/crypto/`                                      |

## Known limits

- Change events live in the backend process, so the server runs one replica. Postgres `LISTEN/NOTIFY` would lift that.
- Workers have no OS-level isolation.
- A raised `MIN_CLIENT` is a coordinated rollout.
- Intake is built in and GitHub-specific. Turning intakes into small scripts is planned.
