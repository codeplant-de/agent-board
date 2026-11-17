#!/bin/sh
# What only a Mac can show about a built binary: `board setup` writes launch agents that plutil accepts, and launchd takes an
# agent of the same kind. The process supervisor and readNoteFile run against the real /tmp (/private/tmp) in the CLI tests, which
# CI runs on macOS too. Usage: macos-smoke.sh <path to board-darwin-arm64>
set -eu
[ "$(uname -s)" = Darwin ] || { echo "macos-smoke.sh runs on macOS only" >&2; exit 1; }
binary=${1:?usage: macos-smoke.sh <board binary>}
binary=$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")
work=$(mktemp -d "${TMPDIR:-/tmp}/board-macos-smoke.XXXXXX")
label=de.codeplant.agent-board.smoke-$$
cleanup() {
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

export HOME="$work/home"
export AGENT_BOARD_CONFIG_DIR="$work/config"
export AGENT_BOARD_STATE_DIR="$work/state"
mkdir -p "$HOME" "$AGENT_BOARD_CONFIG_DIR"

# setup writes the two agents (no --enable: nothing is loaded), the log and run directories, and no intake agent.
"$binary" setup --force
agents="$HOME/Library/LaunchAgents"
[ "$(find "$agents" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 2 ] || { echo "expected two launch agents in $agents" >&2; ls "$agents" >&2; exit 1; }
for plist in "$agents"/*.plist; do
  plutil -lint "$plist"
done
[ -d "$AGENT_BOARD_STATE_DIR/run" ] || { echo "setup made no run directory" >&2; exit 1; }
[ "$(stat -f %Lp "$AGENT_BOARD_STATE_DIR/run")" = 700 ] || { echo "the run directory is not mode 700" >&2; exit 1; }
# The agents run the binary under lockf, and plutil reads the program arguments back.
[ "$(plutil -extract ProgramArguments.0 raw "$agents/de.codeplant.agent-board.dispatch.plist")" = /usr/bin/lockf ]
[ "$(plutil -extract ProgramArguments.0 raw "$agents/de.codeplant.agent-board.listen.plist")" = "$binary" ]

# launchd takes an agent like these when this session has a gui domain; a runner without one is no failure of the CLI.
plist="$work/$label.plist"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/true</string>
	</array>
	<key>AbandonProcessGroup</key>
	<true/>
</dict>
</plist>
PLIST
if launchctl bootstrap "gui/$(id -u)" "$plist" 2>"$work/bootstrap.err"; then
  launchctl print "gui/$(id -u)/$label" >/dev/null
  launchctl bootout "gui/$(id -u)/$label"
  echo "launchd loaded and unloaded a throwaway agent"
else
  echo "skipped the launchd load: $(head -n 1 "$work/bootstrap.err")"
fi
echo "macOS smoke test passed"
