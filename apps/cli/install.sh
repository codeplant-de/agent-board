#!/bin/sh
# Copies the units and symlinks the board command into place. Enables nothing and starts nothing.
# The CLI talks to the board over HTTPS (web.json); nothing of the board itself is installed here.
set -eu
root=$(dirname "$(readlink -f "$0")")
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/bin"
for unit in "$root"/systemd/*; do
  # Copied, not linked: `systemctl disable` deletes a unit file that is a symlink.
  install -m 644 "$unit" "$HOME/.config/systemd/user/$(basename "$unit")"
done
ln -sfn "$root/bin/board" "$HOME/.local/bin/board"
# Link a real Node 24+ binary for bin/_node: $NODE, else the node on PATH, else the newest mise install.
node_bin=${NODE:-$(node -e 'console.log(process.execPath)' 2>/dev/null || true)}
[ -n "$node_bin" ] || node_bin=$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -n "$node_bin" ] && "$node_bin" --version | grep -q '^v2[4-9]\|^v[3-9]' \
  || { echo "no Node 24+ found; run NODE=/path/to/node ./install.sh" >&2; exit 1; }
ln -sfn "$node_bin" "$root/bin/.node"
systemctl --user daemon-reload
echo "installed. Next: ~/.config/agent-board/config.json, web.json and env (AGENT_BOARD_TOKEN), then enable the timers (see README)."
