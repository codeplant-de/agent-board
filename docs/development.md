# Development

## Local stack

`mise.toml` pins Node 24, pnpm 11 and Bun. Bun is only needed to build the CLI binary.

```
mise install
pnpm install
docker compose up -d postgres        local Postgres on :54331 (board_dev, board_test)
cp apps/backend/.env.example apps/backend/.env
pnpm dev:backend                     :4000, as DEV_AUTH_USER
pnpm dev:frontend                    :5173, proxies /trpc and /api
```

Migrations run when the backend starts, so restart it after a schema change.

To point a worker at the local board, take a token and the data key from http://localhost:5173/settings and write a `web.json` with `"url": "http://localhost:4000"`. Point `AGENT_BOARD_CONFIG_DIR` and `AGENT_BOARD_STATE_DIR` at scratch directories, so your real config and logs stay untouched. To run the CLI from source: `mise exec -- node apps/cli/src/main.mts <command>`.

## Checks

Run all four before a PR. CI runs the same in its `test` job:

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

`pnpm format` fixes formatting. Put a pure formatting change in its own commit, so the logic diff stays readable.

- **Backend tests** are integration tests against `board_test`. They use `app.inject` for the machine API and tRPC callers for the UI. The global setup drops and recreates the schema on every run, so two worktrees testing at the same time need separate databases (`TEST_DATABASE_URL`).
- **CLI tests** use `node --test`. The decision logic (`apps/cli/src/decide.mts`, `planIntake`, the `run*` functions) takes the backend, GitHub and the system as arguments, and tests pass fakes from `apps/cli/test/helpers.mts`. A fake backend must behave like the real one. For example, the server clears `runStartedAt` when a task leaves Running.
- **Slack app tests** (`apps/slack`) use vitest with a fake Socket Mode client and a local HTTP server standing in for the backend. The backend's `intake.integration.test.ts` runs the app's real intake client against the real intake API.
- **Completion tests** need zsh and fish and skip without them, so CI may be their first real run.
- **The command reference** in [cli.md](cli.md) is generated from the commander program. A test fails when it is stale; regenerate it with `pnpm --filter @agent-board/cli run docs`.
- **The binary**: `pnpm --filter @agent-board/cli test:binary` builds one for this host and runs it the way a worker machine would. CI does the same in its `binary` job.

Three test skills in `apps/cli/test/skills` run real headless checks. Link one into `~/.claude/skills` and schedule it with `board schedule /<name>`.

- `board-selftest-ask` asks one question through AskUserQuestion and reports the answer after you answer on the board.
- `board-selftest-slow` works through eight 15-second steps. With two lanes of one slot each, schedule two so one lane borrows, then schedule own work for that lane. The next tick after `pauseAfterMinutes` pauses the borrowed run, which later resumes in its session.
- `board-selftest-worktree` enters a worktree first, so a pause and resume show that the session continues in it.

## Database migrations

Edit `apps/backend/src/db/schema.ts`, then generate the migration with `pnpm db:generate --name <change>`. Some migrations carry hand-written SQL (grants, RLS policies, data moves) on top of the generated part; keep that in the same file.

Parallel branches collide on the migration number. When you rebase onto a `main` that gained a migration, take `main`'s `drizzle/meta` journal and snapshots, delete your migration, generate it again with the same `--name`, and copy any hand-written SQL over from the old file. Don't renumber files by hand.

## Contract and CLI versions

`API_VERSION`, `MIN_CLIENT` and `MIN_SERVER` in `packages/shared/src/contract.mts` are a break level between the server and the CLIs (see [machine-api.md](machine-api.md#version-handshake)); they are not a count of changes. An addition old clients can ignore, such as a new command, an optional field or a new enum value with a vocabulary row, adds a feature name in `packages/shared/src/features.mts` and bumps nothing ([machine-api.md](machine-api.md#features)). Anything an old client would misread, including a new enum value without a vocabulary row, raises `API_VERSION`, then `MIN_CLIENT` to it, which breaks every older CLI until it is updated. [architecture.md](architecture.md#versioning) has the reasoning. `LEGACY_CONTRACT` stays 9 for the CLIs up to 0.7.0 and is never changed.

When you raise `MIN_CLIENT`:

1. Raise the CLI version in `apps/cli/package.json` in the same PR (CI checks it against the newest `cli-v*` tag).
2. Add a note for the change under [Upgrading](setup.md#upgrading).
3. After the merge, release the CLI before machines are expected to work again (see below).

Parallel branches also collide on these numbers and the CLI version. Renumber on rebase.

## Releasing the CLI

A merge to `main` deploys the server: CI builds the images and Flux rolls them out. The CLI is released separately, by a tag:

```
git tag -s -m "board CLI 0.8.0" cli-v0.8.0 <commit on main>
git push origin cli-v0.8.0
```

The tag must match `apps/cli/package.json`, and the commit must be on `main`. `.github/workflows/release-cli.yml` checks both, runs the checks and the CLI tests, builds the binaries for Linux x64 and arm64 and macOS arm64, smoke-tests a Linux x64 build (the arm64 and macOS binaries never run in CI), and publishes a GitHub release with `SHA256SUMS` and `install.sh`. Machines then run `board self-update`, and the listener needs a restart (`board setup` does that when the unit changed).

## Dependencies

[Renovate](https://docs.renovatebot.com/) ([`renovate.json`](../renovate.json)) opens PRs on Monday mornings (Europe/Berlin) and keeps a Dependency Dashboard issue listing what is pending. It needs the Renovate GitHub App installed on the repository. It covers:

- the pnpm workspace, including `packageManager` in `package.json`;
- the tools in `mise.toml`, and the pnpm and Bun versions the workflows pass to `pnpm/action-setup` and `oven-sh/setup-bun` (a regex manager in `renovate.json`; keep those `with:` blocks in the same shape);
- the GitHub Actions in `.github/workflows`;
- the images in `apps/*/Dockerfile`, `docker-compose.yml` and CI.

It waits seven days after a release before proposing it. Minor and patch bumps come as one grouped PR and each major as its own PR, except that every change to node, pnpm or bun is one PR per tool across all the files that name it, so `mise.toml`, `package.json` and CI never disagree. Node and Postgres majors are disabled: a new Node LTS and a Postgres major (which needs a dump and restore of production) are moved to by hand.

CI runs on these PRs like on any other, and merging one deploys the server like any other merge to `main`. A dependency bump in `apps/cli` changes the next CLI release, not the installed CLIs; it reaches the machines with the next `cli-v*` release.

## Git

- Commits and tags are SSH-signed. Never bypass signing; if it fails, ask the user to run `ssh-add-signing`.
- PRs merge with merge commits.
- `~/workspace/agent-board` is a live checkout: the installed timers may run from it. Do unfinished work in a worktree under `.claude/worktrees/`, made with `scripts/worktree.sh open <pr|branch>`.
