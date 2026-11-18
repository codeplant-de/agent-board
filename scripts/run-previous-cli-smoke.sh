#!/bin/sh
# Starts the board backend of this checkout on a scratch database, seeds an owner with a data key and a machine token,
# and runs scripts/previous-cli-smoke.sh with the given released binary against it. The CI job `previous-cli` runs this.
#
#   DATABASE_URL=postgresql://board:board@localhost:5432/board_prevcli scripts/run-previous-cli-smoke.sh <board binary>
#
# DATABASE_URL is the admin connection of a database that may be wiped: the backend migrates it and creates the
# `board_app` role; every run seeds a new owner, so the database can be reused. APP_DATABASE_URL defaults to the same database as that role. PORT defaults to a free one.
set -eu

binary=${1:?usage: run-previous-cli-smoke.sh <board binary>}
: "${DATABASE_URL:?set DATABASE_URL to the admin URL of a scratch database}"
root=$(cd "$(dirname "$0")/.." && pwd)

# The backend migrates the database and resets the password of the board_app role, so only a scratch database is allowed.
database_name() {
  node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).pathname.slice(1)))' "$1"
}
guard() {
  case "$(database_name "$2")" in
    *_prevcli) ;;
    *)
      echo "run-previous-cli-smoke: refusing $1, its database name does not end in _prevcli (it would be migrated and its board_app role reset)" >&2
      exit 2
      ;;
  esac
}
guard DATABASE_URL "$DATABASE_URL"
[ -z "${APP_DATABASE_URL:-}" ] || guard APP_DATABASE_URL "$APP_DATABASE_URL"

if [ -z "${APP_DATABASE_URL:-}" ]; then
  APP_DATABASE_URL=$(node -e 'const u = new URL(process.argv[1]); u.username = "board_app"; u.password = "board_app"; console.log(u.toString())' "$DATABASE_URL")
fi
if [ -z "${PORT:-}" ]; then
  PORT=$(node -e 'const s = require("node:net").createServer().listen(0, () => { console.log(s.address().port); s.close(); })')
fi
# The smoke test only speaks the machine API, which has its own tokens; the backend still wants to know how the UI signs in.
NO_LOGIN_USER=smoke-ci
export DATABASE_URL APP_DATABASE_URL PORT NO_LOGIN_USER
unset DEV_AUTH_USER BACKFILL_OWNER PUBLIC_URL PASSKEYS SESSION_DAYS ALLOWED_GROUPS SIGNUP_TOKEN

work=$(mktemp -d)
server=
cleanup() {
  [ -z "$server" ] || kill "$server" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

cd "$root"
pnpm --filter @agent-board/backend exec tsx src/index.ts >"$work/backend.log" 2>&1 &
server=$!

ready=
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$server" 2>/dev/null || break
  sleep 1
done
if [ -z "$ready" ]; then
  echo "the backend did not start; its log:" >&2
  cat "$work/backend.log" >&2
  exit 1
fi

(umask 077 && pnpm --filter @agent-board/backend exec tsx src/scripts/seedMachine.ts "smoke-$$-$(date +%s)" smoke-ci >"$work/env")

BOARD_URL="http://127.0.0.1:$PORT" BOARD_ENV_FILE="$work/env" "$root/scripts/previous-cli-smoke.sh" "$binary" || {
  echo "the backend log:" >&2
  tail -n 40 "$work/backend.log" >&2
  exit 1
}
