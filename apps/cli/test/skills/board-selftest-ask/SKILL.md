---
name: board-selftest-ask
description: Test skill for agent-board's question bridge. Asks one question with AskUserQuestion and reports the answer after the resume. Started headless through the board as `/board-selftest-ask`; not for interactive use.
---

# Ask once, then report the answer

1. Ask with AskUserQuestion: header "Color", question "Which color should the selftest report?", single choice, options "Blue (Recommended)" (The default) and "Green" (The other one).
2. When you are resumed with the answer, report it with `board comment <task> "Selftest got: <the chosen color, and any text the user added>"`, then `board move <task> needs-me`. The board's rules name your task id.
