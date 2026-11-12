---
name: board-review-pr
description: Runs one PR review for a Trello card in the agent-board queue and reports on the card. Started headless by the agent-board worker as `/board-review-pr <card> <pr-url>`; not for interactive use.
---

# Review a PR for a board card

Arguments: `<card>` (the card's short link) and `<pr-url>`. Nobody is watching, so never ask a question.

## Hard rules

- Never submit a review, approve, request changes, comment on the PR, reply to a thread, resolve a thread, push or merge.
- The only thing written to GitHub is the pending draft review, and only through `pr-review:review-pr --auto`.
- A denied tool is a result, not an obstacle. Do not look for another way around it. Report it on the card.

## Steps

1. `board comment <card> "Review started"`.
2. Run `pr-review:review-pr <pr-url> --auto` with the Skill tool. It reuses cached notes, hands an earlier pass to the reviewer as hints, and stages into the pending draft. After the analysis is in, post `board comment <card> "Analysis done, staging the draft"`, and after staging `board comment <card> "Draft staged"`.
3. Post the findings with `board comment <card> -` and the text on stdin (a quoted heredoc). The text has three parts:
   - **Summary:** the verdict and one short paragraph.
   - **Issues:** by severity, highest first, one line each: `severity path:line first sentence`. Say "none" if there are none. Add how many comments were staged, edited and removed.
   - **Check by hand:** what the review could not settle: things that need running the code, a design call, a story requirement it could not read, any step that was denied or skipped.
4. Append the pass to the brain journal of the PR's head branch, as the global notes-mirror rule says: `brain notes append --branch <headRefName> --title "PR review @<sha7>"`. Skip it if the command is denied.
5. `board move <card> "Needs me"`, then `board notify <card> "<verdict>, <n> issues"`.

If any step fails, post what failed with `board comment`, then still do step 5 so the card does not stay in Running.
