---
name: board-selftest-slow
description: Test skill for agent-board's lanes and pausing. Works through eight slow steps and reports each on its task. Started headless as `/board-selftest-slow <task>`; not for interactive use.
---

# Eight slow steps

Argument: `<task>`. Run every command on its own. Nobody is watching.

For step N from 1 to 8: run `sleep 15` with Bash, then `board comment <task> "step N done"`.

After step 8: `board move <task> needs-me`. Your last message is `finished`.

If you are resumed, run `board show <task>` first and continue after the last step the thread shows as done.
