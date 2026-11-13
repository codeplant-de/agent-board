---
name: board-selftest-ask
description: Test skill for agent-board's ask-and-resume loop. Asks one question on its task and stops; on resume, posts the answer back. Started headless as `/board-selftest-ask <task>`; not for interactive use.
---

# Ask once, then report the answer

Argument: `<task>`. Run every command on its own. Nobody is watching.

## First run

1. Write this file with the Write tool to `/tmp/pr-selftest-<task>.json`:

   ```json
   {"questions":[{"header":"Color","question":"Which color should the selftest report?","multiSelect":false,"options":[{"label":"Blue","description":"The default","recommended":true},{"label":"Green","description":"The other one"}]}]}
   ```

2. Run `board ask <task> --file /tmp/pr-selftest-<task>.json`.
3. Stop. Your last message is `asked`.

## Resumed run

The prompt carries the user's answer. Run `board comment <task> "Selftest got: <the chosen color, and any text the user added>"`, then `board move <task> needs-me`. Your last message is `reported`.
