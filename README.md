# agent-board

A Kanban board for headless Claude Code runs. You write a task the way you would type a prompt into Claude Code (`/review-pr 17741`, or plain instructions). A worker on one of your machines runs it with `claude -p`, and the agent reports back on the board as a thread. When it needs you, it asks questions with options to pick, and it carries on in the same session once you answer.

All content is end-to-end encrypted. The server never sees a prompt, a note or a transcript in plain text.

## How it works

```
 browser ──tRPC──▶ backend (Fastify, Postgres) ◀──machine API + SSE── board CLI on each worker machine
                   board.codeplant.de, behind a login proxy             dispatch · intake · listen · worker
                                                                          └─ starts `claude -p` per task
```

| Part | What it is |
| --- | --- |
| `apps/backend` | Fastify server with tRPC for the browser and a token-authenticated machine API for workers. Postgres is the only state. |
| `apps/frontend` | React, Mantine and TanStack Query. Encrypts and decrypts in the browser. |
| `apps/cli` | The `board` command. Agents use it to report, and on a worker machine it runs the systemd units that claim and run tasks. |
| `apps/slack` | Optional Slack app in its own container: `/board <text>` puts a task idea in your board's inbox. It reaches the backend only through a narrow, token-gated intake API. |
| `packages/shared` | The contract between all three: wire types, the sealing rules, crypto. |

A task moves through `backlog → todo → running → needs-me → done`, with `waiting` for tasks parked on CI or a timer. A run that reports, asks or fails ends in `needs-me`, and nothing moves on until you press a button. [docs/architecture.md](docs/architecture.md) explains the design.

## Install a worker machine

You need Linux with systemd, plus `gh` and `claude`, both logged in. On macOS the `board` commands work except `ask`, `add`, `polish` and `setup`; the worker needs Linux.

1. Open the board in the browser and set up encryption (passphrase and recovery key). On **Settings**, create a token for this machine and copy the data key.
2. Install the CLI from the newest release:

   ```sh
   gh release download --repo codeplant-de/agent-board --pattern install.sh -O - | sh
   ```

3. Configure and start it:

   ```sh
   board init            # board URL, machine token, data key, machine name
   board setup --enable  # systemd user units: dispatch, intake, listener
   board doctor          # checks config, token, key, server version and units
   ```

4. Edit `~/.config/agent-board/config.json`: map `repos` to your local checkouts, and adjust `lanes` if you want parallel runs split by skill.

For runs after you log out, enable lingering with `loginctl enable-linger $USER`. Update later with `board self-update`.

[docs/setup.md](docs/setup.md) covers installing from a checkout, every config key, and upgrading across contract versions.

## Use it

Make a task from the terminal. It runs on this machine, in this directory:

```sh
board schedule /review-pr 17741
board schedule --priority high "Find out why the bidder export is slow and propose a fix"
board schedule --in 2h /review-pr 17741
board schedule --cron "0 9 * * 1-5" /review-pr --auto
```

Or use **New task** on the board. Whichever machine takes it picks the directory: the PR's checkout, the lane's `cwd` or `defaultCwd` (see [where a task runs](docs/workers.md#where-a-task-runs)).

Then work from the task page:

- **Answer & continue** or **Send & continue** resumes the agent's session with your reply.
- **Re-run fresh** starts over with a new session.
- **Mark done** moves it to Done, and **Close** takes it out of the workflow.
- **Transcript** shows every tool call of every run, live while it runs.
- `board attach <task>` opens the session in your terminal on the machine that ran it.

Agents report with `board comment`, ask with `board ask`, park on CI with `board wait`, report the PRs they open with `board pr`, and propose follow-up work with `board add`. A proposal only runs after you press **Start**.

With the optional Slack app, `/board <text>` in Slack puts an idea in a **From Slack** box on the board; you turn it into a task in the browser (see [docs/usage.md](docs/usage.md#slack)).

Intake runs on a timer and turns GitHub review requests into review tasks. These run with a narrow allow-list, because their input is PR text nobody chose to read.

Further reading:

- [docs/usage.md](docs/usage.md): statuses, scheduling, questions, waiting, polishing prompts.
- [docs/workers.md](docs/workers.md): lanes, liveness limits, where a task runs, what a worker may do.
- [docs/cli.md](docs/cli.md): every `board` command, generated from `board help`.

## Security in short

- Workers run Claude Code as you, with your home directory, SSH agent and `gh` login. There is no sandbox. Permission rules keep an agent on its task, but they are not a security boundary.
- Prompts, notes and transcripts are sealed with a data key that exists only in your browser and on your machines. Each value is bound to the row and role it was written for, so the server cannot move a value to another task or forge one.
- The server still sees metadata and decides when and where a task runs.

[docs/encryption.md](docs/encryption.md) lists exactly what the server can and cannot do.

## Develop

```sh
mise install                        # Node 24, pnpm 11, Bun
pnpm install
docker compose up -d postgres       # Postgres on :54331
cp apps/backend/.env.example apps/backend/.env
pnpm dev:backend                    # :4000, signed in as DEV_AUTH_USER
pnpm dev:frontend                   # :5173
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

[docs/development.md](docs/development.md) covers tests, migrations, CLI releases and how to point a worker at the local board. Server deployment and its environment are in [docs/operations.md](docs/operations.md). The wire protocol between CLI and server is in [docs/machine-api.md](docs/machine-api.md).

## Documentation

| Document | Contents |
| --- | --- |
| [architecture.md](docs/architecture.md) | Components, data flow, design decisions and the rules a change must keep. |
| [usage.md](docs/usage.md) | Tasks, scheduling, questions and resume, waiting, proposals, polish. |
| [workers.md](docs/workers.md) | Multiple machines, lanes, liveness, transcripts, permissions, how dispatch decides. |
| [setup.md](docs/setup.md) | Installing the CLI, `config.json`, upgrading. |
| [cli.md](docs/cli.md) | Generated `board` command reference. |
| [encryption.md](docs/encryption.md) | Threat model, sealing contexts, what the server can still do. |
| [machine-api.md](docs/machine-api.md) | The contract between CLI and server. |
| [operations.md](docs/operations.md) | Server deployment, environment, the encryption cutover. |
| [development.md](docs/development.md) | Local setup, tests, migrations, releases. |
