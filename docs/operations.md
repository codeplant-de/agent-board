# Running the board server

Deployment, server configuration, and the one-off encryption cutover.

## The board server

`apps/backend`: Fastify, tRPC for the UI, Drizzle on Postgres; migrations run on start. `apps/slack`: the optional [Slack app](#the-slack-app). `apps/frontend`: React, Mantine and TanStack Query, served by Caddy, which proxies `/trpc`, `/api` and `/healthz` to the backend. The backend's answers share the app's origin, so Caddy passes on none of their headers (`header_down -*`: an allow-list of nothing, so `Clear-Site-Data`, `Set-Cookie`, `Refresh`, `Link`, `Location`, `Service-Worker-Allowed`, `Strict-Transport-Security`, `Access-Control-*`, `Content-Encoding` and any header nobody thought of are dropped, and only the status and the body get through) and writes its own (`Content-Type: application/json`, `Cache-Control: no-store`, `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, `Cross-Origin-Resource-Policy: same-origin`). The app's own CSP has `worker-src 'none'`, so no service worker can be registered, and a script served from a backend path is JSON to a browser anyway: a page the backend made up under `/api` or `/trpc` is not a page to a browser and cannot run script with the app's access to the keys in IndexedDB. The app itself is served with `Cross-Origin-Opener-Policy: same-origin`. Images: `agent-board-backend`, `agent-board-web` and `agent-board-slack` on GHCR, built by `.github/workflows/ci.yml` on a push to main, only after its typecheck, lint and test job passed (a manual run builds them too), and rolled out by Flux image automation.

Environment of the backend:

| Variable           | Meaning                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`     | Postgres, as a superuser or as the schema owner with CREATEROLE. Used only at start to create the app role and run migrations, then closed.                                                                                                                                                                                       |
| `APP_DATABASE_URL` | The same database as `board_app`, the unprivileged role that serves every request (no superuser, no BYPASSRLS). It must be `board_app`; the backend creates it with this URL's password, or resets the password, on start, and refuses to start if the role is privileged.                                                        |
| `ALLOWED_GROUPS`   | Authelia groups that may use the UI, comma-separated. Default `admins`.                                                                                                                                                                                                                                                           |
| `DEV_AUTH_USER`    | Local development only: act as this user without Authelia. The backend refuses to start with it in production.                                                                                                                                                                                                                    |
| `BACKFILL_OWNER`   | Only for the first start on a database that already has tasks, from before boards were separated: the username that owns them. The migration stops with an error naming this variable when rows exist and it is unset; it is not needed on a fresh database and ignored afterwards.                                               |
| `INTAKE_TOKEN`     | Turns on the Slack intake API and is the bearer token of the [Slack app](#the-slack-app); at least 32 characters, the same value there. Unset, the API does not exist (404). `openssl rand -hex 32` makes one.                                                                                                                    |
| `BOARD_URL`        | The board's public address without a trailing slash, such as `https://board.codeplant.de`. Required with `INTAKE_TOKEN`: the links the Slack app hands out are built on it.                                                                                                                                                       |
| `CLI_VERSION`      | The newest CLI release, `x.y.z`, which the machine API advertises as `cli` in its `version` answer. The backend image sets it from `apps/cli/package.json` at build time (the `build-and-push` job passes it as a build argument). Unset or not `x.y.z` means unknown: nothing is advertised and no machine is shown as outdated. |
| `PORT`             | Default 4000.                                                                                                                                                                                                                                                                                                                     |

Boards are separated per user: every row belongs to the signed-in user (`Remote-User`, lower-cased), and requests run as the unprivileged `board_app` role with row-level security, so a query only sees its owner's rows even if it forgets a `WHERE`. A machine token belongs to the user who made it on the Settings page, and the machine API works on that user's board. Two users may use the same machine name or dedupe key.

Three ways in:

- **The UI** (`/trpc`): Traefik runs Authelia's forward-auth and strips client-sent `Remote-*` headers before it; the backend takes the user from `Remote-User` and requires one of `ALLOWED_GROUPS` in `Remote-Groups`.
- **The machine API** (`POST /api/machine/<subcommand>`): its own Traefik route skips Authelia, matched only for that path with an `Authorization: Bearer` header. The backend looks the token up by its sha256 (tokens are shown once, on the Settings page) and refuses a revoked one. A token claims tasks only under its own machine name.
- **The intake API** (`POST /api/intake/<command>`): for the Slack app only, with the shared `INTAKE_TOKEN`; see [architecture.md](architecture.md#the-slack-companion). Never add it to the proxy's login bypasses: the Slack app calls the backend directly inside the cluster.

The cluster side (namespace, Postgres, Deployments (backend, web, Slack app), IngressRoutes, Authelia rule, image policies, DNS, nightly `pg_dump` into the restic backup) lives in the separate, private codeplant-de/cloud-infra repository. The images come from `codeplant-de/agent-board` on GitHub (`ghcr.io/codeplant-de/agent-board-*`).

## The Slack app

`apps/slack` is a small container (`agent-board-slack`, built next to the backend and web images and rolled out the same way) that answers `/board` in Slack: `/board link`, `/board unlink` and `/board <text>`, which lands in the board's **From Slack** box. It has no state, listens on no port and needs no ingress: it dials out to Slack (Socket Mode) and to the backend. See [usage.md](usage.md#slack) for what users do, and [architecture.md](architecture.md#the-slack-companion) for why it is separate and what its token can do.

| Variable          | Meaning                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SLACK_APP_TOKEN` | The app-level token (`xapp-…`, scope `connections:write`) of the Slack app. The only Slack secret; no bot token is read. |
| `BOARD_API_URL`   | The backend as the container reaches it, inside the cluster: `http://backend:4000` in the `agent-board` namespace.       |
| `INTAKE_TOKEN`    | The same value as on the backend.                                                                                        |

The backend holds no Slack token. Slack outages and backend outages do not stop the app: it retries the connection with growing delays, and a command it cannot answer gets an ephemeral "the board did not answer". Logs name the reason, never a token or what someone typed.

Setting it up:

1. In the Cosuno workspace, create an app from `infra/slack-app-manifest.yaml` (api.slack.com/apps, "Create New App", "From a manifest"). The manifest asks for the `commands` scope and Socket Mode, nothing else. A workspace admin may have to approve it.
2. Under Basic Information, "App-Level Tokens", generate a token with the scope `connections:write`. That is `SLACK_APP_TOKEN`. Install the app to the workspace.
3. Generate an `INTAKE_TOKEN` and put it in the backend's env secret together with `BOARD_URL`, and `SLACK_APP_TOKEN`, `BOARD_API_URL` and `INTAKE_TOKEN` in the Slack app's secret (`agent-board-slack-env`, see the patch). Restart the backend, then the app.
4. In Slack, send `/board link` and open the link.

Without `INTAKE_TOKEN` on the backend the board runs as before and shows no Slack settings. The compose file does not start the app; locally, run `pnpm --filter @agent-board/slack dev` with `apps/slack/.env` (see `.env.example`) against `pnpm dev:backend` with `INTAKE_TOKEN` and `BOARD_URL=http://localhost:5173` set.

## Cutover to encryption

Done once, on 2026-11-14: the only board from before encryption (contract 6) was re-encrypted in place, and migration 0014 then made the database refuse plain text in every sealed column (`apps/backend/src/db/sealedColumns.ts` lists them). A new board starts encrypted and needs none of this.

The re-encryption script (`pnpm --filter @agent-board/backend reencrypt`) and its runbook were removed afterwards. The last tag that ships both is `cli-v0.8.0`: see `apps/backend/src/scripts/reencrypt.ts` and this section at that tag. Migration 0014 still names the script in its error, because migrations are not edited after they ship. On a database this code has migrated that error cannot occur: 0014 only applies when no plain text is left.
