# Development

## Local stack

`mise.toml` pins Node 24, pnpm 11 and Bun. Bun is only needed to build the CLI binary.

```sh
mise install
pnpm install
docker compose up -d postgres        # local Postgres on :54331 (board_dev, board_test)
cp apps/backend/.env.example apps/backend/.env
pnpm dev:backend                     # :4000, no login: everyone is NO_LOGIN_USER
pnpm dev:frontend                    # :5173, proxies /trpc and /api
```

Migrations run when the backend starts, so restart it after a schema change.

`.env.example` sets `NO_LOGIN_USER=dev`, so every request is the user `dev` and there is no login page. The older name `DEV_AUTH_USER` still works as an alias outside production. The backend logs a warning at start that anyone who reaches the port is that user.

To try the login page, edit `apps/backend/.env`, comment out `NO_LOGIN_USER` and set:

```sh
PUBLIC_URL=http://localhost:5173
SIGNUP_TOKEN=<32 or more characters>
```

Restart the backend and open http://localhost:5173/settings/machines (not `127.0.0.1`: a passkey is bound to the hostname in `PUBLIC_URL`). **Create an account** takes a name, the token and a passkey. The backend refuses to start with `NO_LOGIN_USER` next to `PUBLIC_URL`, `PASSKEYS`, `SESSION_DAYS`, `SIGNUP_TOKEN`, `ALLOWED_GROUPS`, `OIDC_*` or `SAML_*`, so unset one side. `ALLOWED_GROUPS` needs `OIDC_ISSUER` too. Outside production `OIDC_ISSUER` and `SAML_ENTRY_POINT` may be http URLs, for an identity provider on your machine. Vite proxies `/trpc` and `/api`, so the browser sees one origin, and the session cookie is `board-session` because the address is http.

To point a worker at the local board, take a token and the data key from http://localhost:5173/settings and write a `web.json` with `"url": "http://localhost:4000"`. Point `AGENT_BOARD_CONFIG_DIR` and `AGENT_BOARD_STATE_DIR` at scratch directories, so your real config and logs stay untouched. To run the CLI from source: `mise exec -- node apps/cli/src/main.mts <command>`.

## Checks

Run all four before a PR. CI runs the same in its `test` job:

```sh
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

`pnpm format` fixes formatting. Put a pure formatting change in its own commit, so the logic diff stays readable.

- **Backend tests** are integration tests against `board_test`. They use `app.inject` for the machine API and tRPC callers for the UI. The sign-in tests (`auth-*.integration.test.ts`, with `auth-sources` for which method owns a name) run against a fake OIDC provider, a fake SAML provider and a software passkey authenticator in `src/test/`. The global setup drops and recreates the schema on every run, so two worktrees testing at the same time need separate databases (`TEST_DATABASE_URL`). They still share the Postgres cluster. The role `board_app` is cluster-wide, so `ensureAppRole` retries when another suite alters it at the same moment. And `drop database` forces a checkpoint of the whole cluster, which takes seconds while other suites write. So the migration tests create a new scratch database per test and drop them all in one `afterAll` with a long timeout (`src/test/scratch.ts`). Follow that pattern, and do not drop a database in a `beforeEach`.
- **CLI tests** use `node --test`. The decision logic (`apps/cli/src/dispatch/decide.mts`, `worker/plan.mts`, the `run*` functions) takes the backend, GitHub and the system as arguments, and tests pass fakes from `apps/cli/src/__tests__/helpers/fakes.mts`. Where a test goes is in [CLI layout](#cli-layout). A fake backend must behave like the real one. For example, the server clears `runStartedAt` when a task leaves Running.
- **Shared package tests** (`packages/shared`) use `node --test` and follow the same layout as the CLI's: `src/<module>.test.mts` next to the module, fixtures in `src/__tests__/fixtures/`.
- **Completion tests** need zsh and fish and skip without them, so CI may be their first real run.
- **The command reference** in [cli.md](cli.md) is generated from the commander program. A test fails when it is stale. Regenerate it with `pnpm --filter @agent-board/cli run docs`.
- **The example files** in `apps/cli/examples` are embedded in the CLI for `board example` through `examples/examples.json`. A test fails when it differs from the files. Regenerate it with `pnpm --filter @agent-board/cli run examples`.
- **The binary**: `pnpm --filter @agent-board/cli test:binary` builds one for this host and runs it the way a worker machine would. CI does the same in its `binary` job.
- **The images**: a pull request builds the two Dockerfiles in CI's `images` job without pushing them, so a Dockerfile that misses a new file or a Vite-only break fails before the merge. Locally: `docker build -f apps/<app>/Dockerfile .` from the repository root.
- **macOS**: the process supervisor, the portable `readNoteFile` and the launchd agents are tested on Linux too (real detached processes, injected `launchctl`). The `cli-macos` job of CI runs the whole CLI suite on a Mac (on a pull request it does not fail the run: it is not a required check, and macOS runners are sometimes not available; look at the job itself when the change touches the worker), builds `board-darwin-arm64`, runs `test:binary` and `apps/cli/scripts/macos-smoke.sh`, which lints the agents `board setup` writes with `plutil` and has launchd load a throwaway agent when the runner has a `gui` domain.

## CLI layout

`apps/cli/src` is grouped by area. `main.mts` is the entry and does not move: `bin/`, `build.sh` and the systemd units and launchd agents of installed machines name its path. `cli.mts` holds what every command and tick starts from (`Context`, `buildContext`, `runMain`, `UsageError`). `task-id.mts` is the check every place runs before a task id becomes part of a path, a unit name, an argument or a link, and names the unit of a task. `task-rules.mts` holds what both the dispatcher and the worker decide about a task (its own lane, whether it may run) and the markers of the notes the dispatcher writes and the worker reads. A module in `worker/` never imports from `dispatch/` or `commands/`.

| Folder      | What lives there                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands/` | The `board` command: the program (`program.mts`), one `register-*.mts` per command group, the commands, id shortcuts, completion, `cli.md`                           |
| `backend/`  | The machine API client (`backend.mts`, `web-backend.mts`), `web.json` (`web-config.mts`), the version check (`contract-check.mts`), sealing, the event-stream parser |
| `dispatch/` | The dispatcher: its decisions (`decide.mts`), the listener, wait checks, task files, the PR state lookup (`pr-states.mts`, `github.mts`)                             |
| `worker/`   | One run: its plan and prompts (`plan.mts`, `prompts.mts`), starting Claude (`process.mts`), the hook, run files, logs, sessions, transcripts, plugins                |
| `setup/`    | `board init`, `board setup`, `board doctor`, systemd, launchd agents, the macOS process supervisor                                                                   |
| `self/`     | The CLI about itself: its executable, version, self-update, the update hint                                                                                          |
| `catalog/`  | The machine catalogue: asking `claude` for its skills and models (`probe.mts`), the per-directory cache (`cache.mts`), the document and its send (`catalog.mts`)     |
| `config/`   | `config.json`, the `dirs` rules (`dirs.mts`), paths, the credentials file                                                                                            |
| `output/`   | Text for a terminal: stand-ins for control characters, colour, links, small text helpers                                                                             |

Tests follow the module they test:

- A test of one module sits next to it as `<module>.test.mts`, also when it drives the module through `runBoard`.
- A suite with no single module as its subject goes to a `__tests__/` folder: `src/__tests__/` for suites that run the whole CLI or the release scripts, `src/<area>/__tests__/` for suites that cut across one area (for example `commands/__tests__/output.test.mts`).
- Shared fakes are in `src/__tests__/helpers/` (`fakes.mts`, `gh.mts`), fixtures in `src/__tests__/fixtures/`.
- `pnpm test` runs `src/**/*.test.mts`. A test file anywhere else is not run.

## Self-test skills

Three test skills in `apps/cli/src/__tests__/fixtures/skills` run real headless checks. Link one into `~/.claude/skills` and schedule it with `board schedule /<name>`.

- `board-selftest-ask` asks one question through AskUserQuestion and reports the answer after you answer on the board.
- `board-selftest-slow` works through eight 15-second steps. With two lanes of one slot each, schedule two with `--lane` for the same lane so the other lane borrows, then schedule own work for the borrowing lane with its `--lane`. The next tick after `pauseAfterMinutes` pauses the borrowed run, which later resumes in its session.
- `board-selftest-worktree` enters a worktree first, so a pause and resume show that the session continues in it.

## Database migrations

Edit `apps/backend/src/db/schema.ts`, then generate the migration with `pnpm db:generate --name <change>`. Some migrations carry hand-written SQL (grants, RLS policies, data moves) on top of the generated part. Keep that in the same file.

Parallel branches collide on the migration number. When you rebase onto a `main` that gained a migration, take `main`'s `drizzle/meta` journal and snapshots, delete your migration, generate it again with the same `--name`, and copy any hand-written SQL over from the old file. Don't renumber files by hand.

## Contract and CLI versions

`API_VERSION`, `MIN_CLIENT` and `MIN_SERVER` in `packages/shared/src/contract.mts` are a break level between the server and the CLIs (see [Version handshake](machine-api.md#version-handshake)). They are not a count of changes. An addition old clients can ignore, such as a new command, an optional field or a new enum value with a vocabulary row, adds a feature name in `packages/shared/src/features.mts` and bumps nothing ([machine-api.md](machine-api.md#features)). Anything an old client would misread, including a new enum value without a vocabulary row, raises `API_VERSION`, then `MIN_CLIENT` to it, which breaks every older CLI until it is updated. [architecture.md](architecture.md#versioning) has the reasoning. `LEGACY_CONTRACT` stays 9 for the CLIs up to 0.7.0 and is never changed.

When you raise `MIN_CLIENT`:

1. Raise the CLI version in `apps/cli/package.json` in the same PR (CI checks it against the newest `cli-v*` tag, and on `main` it stops a break that has no higher version before the images are built).
2. Add a note for the change under [Upgrading](setup.md#upgrading).
3. After the merge CI releases the CLI by itself, before the images (see below). Machines can then run `board self-update`.

Parallel branches also collide on these numbers and the CLI version. Renumber on rebase.

## Releasing the CLI

A merge to `main` deploys the server: CI builds the images and Flux rolls them out. The CLI is released from the same run. To release one, raise the version in `apps/cli/package.json` in the PR. After the merge, CI checks whether `cli-v<version>` has a published release; if not, it calls `.github/workflows/release-cli.yml`, and the images wait for it, so a machine told to update finds the release. A merge that leaves the version alone releases nothing.

The workflow refuses to run outside `main`. It checks that the version is `x.y.z` and above the newest `cli-v*` tag, runs the checks and the CLI tests, builds the binaries for Linux x64 and arm64, and smoke-tests a Linux x64 build (the Linux arm64 binary never runs in CI). The macOS arm64 binary is built on `macos-latest` by `.github/workflows/macos-binary.yml`, which runs `test:binary` (with `BOARD_BINARY`, so on that very file) and `apps/cli/scripts/macos-smoke.sh` before handing the file to the release job, which adds it to the checksums. GitHub's macOS runners are sometimes short and cancel a job that no runner picked up within about 15 minutes, so when the first macOS attempt does not succeed, a `macos-retry` job runs it once more. The images wait on the release's `published` output rather than the call's result, because the cancelled first attempt can leave the call marked failed after the retry released. It then creates a draft release for the commit, uploads the binaries, `SHA256SUMS` and `install.sh`, and publishes it. GitHub creates the tag `cli-v<version>` when the draft is published, so a failed run leaves a draft and no tag, and the next run deletes the draft and starts over. Two runs never publish at once; the second finds the release published and does nothing.

The tag is lightweight and unsigned. The tags `cli-v0.3.0` to `cli-v0.8.0` were signed by hand. The integrity of a release is meant to come from GitHub's immutable releases, under which a published release cannot change its assets or its tag. They are not enabled in the repository settings yet. Check one with `gh release verify cli-v<version>`, and a downloaded file with `gh release verify-asset cli-v<version> <file>`.

If the release fails, the images are held. Use "Re-run failed jobs" on the CI run, or run the Release CLI workflow by hand (`workflow_dispatch`) from `main`, which releases the head of `main`. Once the release is published, re-run the failed `build-and-push` of the CI run if it was not started again. Machines then run `board self-update`, and the listener needs a restart (`board setup` does that when the unit changed).

## Dependencies

[Renovate](https://docs.renovatebot.com/) ([`renovate.json`](../renovate.json)) opens PRs on Monday mornings (Europe/Berlin) and keeps a Dependency Dashboard issue listing what is pending. It needs the Renovate GitHub App installed on the repository. It covers:

- the pnpm workspace, including `packageManager` in `package.json`;
- the tools in `mise.toml`, and the pnpm and Bun versions the workflows pass to `pnpm/action-setup` and `oven-sh/setup-bun` (a regex manager in `renovate.json`; keep those `with:` blocks in the same shape);
- the GitHub Actions in `.github/workflows`;
- the images in `apps/*/Dockerfile`, `docker-compose.yml` and CI.

It waits seven days after a release before proposing it. Minor and patch bumps come as one grouped PR and each major as its own PR, except that every change to node, pnpm or bun is one PR per tool across all the files that name it, so `mise.toml`, `package.json` and CI never disagree. Node and Postgres majors are disabled: a new Node LTS and a Postgres major (which needs a dump and restore of production) are moved to by hand.

CI runs on these PRs like on any other, and merging one deploys the server like any other merge to `main`. A dependency bump in `apps/cli` changes the next CLI release, not the installed CLIs; it reaches the machines with the next `cli-v*` release.

## Git

- Commits and tags are SSH-signed. Never bypass signing. If it fails, ask the user to run `ssh-add-signing`.
- PRs are squash-merged. The repository allows no other merge method.
- `~/workspace/agent-board` is a live checkout: the installed timers may run from it. Do unfinished work in a worktree under `.claude/worktrees/`, made with `scripts/worktree.sh open <pr|branch>`.
