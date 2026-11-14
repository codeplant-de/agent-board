#!/bin/sh
# Links the board command and a real Node 24+ for the checkout, then lets `board setup` install the systemd units.
# Enables nothing and starts nothing (board setup --enable does). The CLI talks to the board over HTTPS (web.json).
set -eu
root=$(dirname "$(readlink -f "$0")")
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/bin/board" "$HOME/.local/bin/board"
# Link a real Node 24+ binary for bin/_node: $NODE, else the node on PATH, else the newest mise install.
node_bin=${NODE:-$(node -e 'console.log(process.execPath)' 2>/dev/null || true)}
[ -n "$node_bin" ] || node_bin=$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -n "$node_bin" ] && "$node_bin" --version | grep -q '^v2[4-9]\|^v[3-9]' \
  || { echo "no Node 24+ found; run NODE=/path/to/node ./install.sh" >&2; exit 1; }
ln -sfn "$node_bin" "$root/bin/.node"
"$root/bin/board" setup "$@"
echo "installed. Next: board init (web.json, env, config.json), then board doctor."
