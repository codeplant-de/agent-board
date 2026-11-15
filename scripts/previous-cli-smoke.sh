#!/bin/sh
# Runs an earlier released `board` binary against a running board and checks that the commands an installed CLI makes
# still work. The CI job `previous-cli` runs it through scripts/run-previous-cli-smoke.sh; locally:
#
#   BOARD_URL=http://127.0.0.1:4000 BOARD_ENV_FILE=<file with AGENT_BOARD_TOKEN and AGENT_BOARD_DATA_KEY> \
#     scripts/previous-cli-smoke.sh <path to board binary>
#
# A binary from before the named features sends no X-Board-Features header, so this also checks that the server serves it
# as a client that knows the baseline vocabulary. The binary reads a temporary configuration, never the one of the user running this.
set -eu

binary=${1:?usage: previous-cli-smoke.sh <board binary>}
: "${BOARD_URL:?set BOARD_URL to the board's address}"
: "${BOARD_ENV_FILE:?set BOARD_ENV_FILE to a file with AGENT_BOARD_TOKEN and AGENT_BOARD_DATA_KEY}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
binary=$(readlink -f "$binary")
chmod +x "$binary"

config="$work/config"
mkdir -p "$config" "$work/home" "$work/state" "$work/bin"
printf '{"url": "%s"}\n' "$BOARD_URL" >"$config/web.json"
cp "$BOARD_ENV_FILE" "$config/env"
chmod 600 "$config/env"
printf '{"machine": "smoke-ci"}\n' >"$config/config.json"

# A CI runner has no systemd user session, so the tools a tick calls are stubs: systemctl reports no unit, systemd-run
# starts what follows `--` in the background (a worker), and claude prints one result line and ends without having
# reported on the task, which the worker then reports as a failure on the board.
printf '#!/bin/sh\nexit 0\n' >"$work/bin/systemctl"
cat >"$work/bin/systemd-run" <<'STUB'
#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
nohup "$@" >/dev/null 2>&1 &
STUB
cat >"$work/bin/claude" <<'STUB'
#!/bin/sh
echo '{"type":"result","subtype":"success","result":"stub"}'
STUB
chmod +x "$work/bin/systemctl" "$work/bin/systemd-run" "$work/bin/claude"

board() {
  env -i PATH="$work/bin:$PATH" HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" \
    AGENT_BOARD_CONFIG_DIR="$config" AGENT_BOARD_STATE_DIR="$work/state" "$binary" "$@"
}

failures=0
step() {
  printf '%s\n' "- $1"
}
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}
# expect <description> <pattern> <output>
expect() {
  printf '%s\n' "$3" | grep -Eq -- "$2" || fail "$1: expected /$2/ in: $3"
}

step "board --version"
version=$(board --version) || fail "board --version exited non-zero"
printf '%s\n' "$version"

step "board tasks on an empty board"
out=$(board tasks 2>&1) || fail "board tasks: $out"

step "board schedule --in 1h (add-task)"
out=$(board schedule --new --in 1h --json "smoke: a task for the previous CLI" 2>"$work/err") || fail "board schedule: $(cat "$work/err")"
id=$(printf '%s\n' "$out" | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -n 1)
if [ -z "$id" ]; then
  fail "board schedule printed no task id: $out"
  exit 1
fi
printf 'task %s\n' "$id"

step "board tasks lists it (list-tasks)"
out=$(board tasks 2>&1) || fail "board tasks: $out"
expect "board tasks" "$id" "$out"

step "board show (get-task, read-notes)"
out=$(board show "$id" 2>&1) || fail "board show: $out"
expect "board show" "smoke: a task for the previous CLI" "$out"

step "board comment (add-note)"
out=$(board comment "$id" "a comment from the previous CLI" 2>&1) || fail "board comment: $out"
out=$(board show "$id" 2>&1) || fail "board show after comment: $out"
expect "board show after comment" "a comment from the previous CLI" "$out"

step "board delay and board move (update-task)"
out=$(board delay "$id" --in 2h 2>&1) || fail "board delay: $out"
out=$(board move "$id" needs-me 2>&1) || fail "board move: $out"
out=$(board tasks --status needs-me 2>&1) || fail "board tasks --status needs-me: $out"
expect "board tasks --status needs-me" "$id" "$out"

step "board schedule --every (add-schedule) and board schedules (list-schedules)"
out=$(board schedule --new --every 1d --in 1h "smoke: a repeating task" 2>&1) || fail "board schedule --every: $out"
out=$(board schedules 2>&1) || fail "board schedules: $out"
expect "board schedules" "smoke: a repeating task" "$out"

step "a dispatch tick, dry run"
board schedule --new --json "smoke: a task that is due" >/dev/null 2>"$work/err" || fail "board schedule: $(cat "$work/err")"
out=$(board internal dispatch --dry-run 2>&1) || fail "board internal dispatch --dry-run: $out"
expect "dispatch tick" "TICK started=" "$out"

step "a real dispatch tick starts a worker (claim-task, heartbeat, transcript), which reports (fail)"
out=$(board internal dispatch 2>&1) || fail "board internal dispatch: $out"
expect "dispatch tick" "STARTED " "$out"
# The worker runs in the background: wait until the claimed task is no longer running.
waited=0
while [ "$waited" -lt 60 ]; do
  running=$(board tasks --status running 2>&1) || true
  printf '%s\n' "$running" | grep -Eq 'smoke: a task that is due' || break
  sleep 1
  waited=$((waited + 1))
done
if printf '%s\n' "$running" | grep -Eq 'smoke: a task that is due'; then
  fail "the worker left the task running after 60 s: $running"
fi
out=$(board tasks --status needs-me 2>&1) || fail "board tasks --status needs-me: $out"
expect "the worker reported the task into needs-me" "smoke: a task that is due" "$out"

step "the event stream opens (board internal listen for a few seconds)"
out=$(timeout 6 env -i PATH="$work/bin:$PATH" HOME="$work/home" AGENT_BOARD_CONFIG_DIR="$config" \
  AGENT_BOARD_STATE_DIR="$work/state" "$binary" internal listen 2>&1) || true
expect "listener" "connected" "$out"

if [ "$failures" -gt 0 ]; then
  printf '%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'previous-cli smoke: ok\n'
