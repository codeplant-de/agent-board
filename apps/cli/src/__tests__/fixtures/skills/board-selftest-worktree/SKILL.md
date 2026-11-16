---
name: board-selftest-worktree
description: Test skill for agent-board's working directories. Enters a worktree, works through six slow steps and reports where each ran. Started headless as `/board-selftest-worktree <task>`; not for interactive use.
---

# Six slow steps in a worktree

Argument: `<task>`. Run every command on its own. Nobody is watching.

1. Use the EnterWorktree tool to create and enter a worktree named `board-<task>`.
2. For step N from 1 to 6: run `sleep 15` with Bash, run `pwd` with Bash, then `board comment <task> "step N done in <the pwd output>"`.
3. After step 6: `board move <task> needs-me`. Your last message is `finished`.

If you are resumed, do not enter a worktree again. Run `pwd`, then `board show <task>`, and continue after the last step the thread shows as done.
