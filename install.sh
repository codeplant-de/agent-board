#!/bin/sh
# Symlinks the units, the board command and the skill into place. Enables nothing and starts nothing.
# The backend runs from the repo, wherever config.json points; nothing to link for it.
set -eu
root=$(dirname "$(readlink -f "$0")")
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/bin" "$HOME/.claude/skills"
for unit in "$root"/systemd/*; do
  ln -sfn "$unit" "$HOME/.config/systemd/user/$(basename "$unit")"
done
ln -sfn "$root/bin/board" "$HOME/.local/bin/board"
ln -sfn "$root/skill/board-review-pr" "$HOME/.claude/skills/board-review-pr"
# Link a real Node 24+ binary for bin/_node: $NODE, else the node on PATH, else the newest mise install.
node_bin=${NODE:-$(node -e 'console.log(process.execPath)' 2>/dev/null || true)}
[ -n "$node_bin" ] || node_bin=$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -n "$node_bin" ] && "$node_bin" --version | grep -q '^v2[4-9]\|^v[3-9]' \
  || { echo "no Node 24+ found; run NODE=/path/to/node ./install.sh" >&2; exit 1; }
ln -sfn "$node_bin" "$root/bin/.node"
systemctl --user daemon-reload
echo "installed. Next: set up a backend and ~/.config/agent-board/config.json (for Trello also trello.json and env), run 'board setup', then enable the timers (see README)."
