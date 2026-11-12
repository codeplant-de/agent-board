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
PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" node --version | grep -q '^v2[4-9]\|^v[3-9]' \
  || { echo "node 24+ is not on the unit PATH" >&2; exit 1; }
systemctl --user daemon-reload
echo "installed. Next: set up a backend and ~/.config/agent-board/config.json (for Trello also trello.json and env), run 'board setup', then enable the timers (see README)."
