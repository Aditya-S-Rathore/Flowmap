---
name: review
description: Review a branch or PR without checking it out — what it changes, what that reaches, whether it is reachable, and what is wrong in the code that changed. Use when the user asks to review a branch, a PR or their own changes, in a repo with a FlowMap workspace.
---

# Reviewing a branch with FlowMap

FlowMap shows what a change touches and who is affected; it does not read what the code does. A good review needs both: the graph for reach, your own reading for logic. Review only what the diff changes. Never edit files, and never comment on a PR or push anything unless the user asks.

## Steps

1. **Scope.** The branch to review (`head`) and what to compare against (`base`). If the user gave only a branch, leave `base` out: FlowMap uses the repo's base branch. Nothing is checked out.
2. **Overview.** Call `changes` with `head` (and `base`). It lists the changed code (new or changed), the screens, APIs and tables that reach, new issues, migrations and feature flags. Then call `go_to` with `page: "changes"` and the same `base` / `head`, so the user sees the picture on their dashboard while you work.
3. **Reach.** For each changed API, screen or shared function: `reachable` (can a user get to it? is it behind a flag?) and `impact` (who depends on it). Do not report a user-facing problem you cannot reach from a real screen or API call; report it as cleanup instead.
4. **Read the changed code.** `git diff <base>...<head>` for the lines, and `git show <head>:<path>` for a whole file. Read the few functions that matter most: validation, auth, transactions, uniqueness checks, migrations. Check every claim against the code you read; never name a symbol, file or line that you did not see.
5. **Write the review** in this order, leaving out empty sections:

   **Flow summary:** before → after, in a few lines: what happened before, what happens now, what triggered the change, which modules it touches.

   Then, by importance:
   - 🔴 **Critical** — must fix before production
   - 🟠 **Important** — should fix
   - 🟡 **Minor** — worth fixing, not blocking

   For each finding:
   - `path/to/file.ts:123` (a link the user can click) and the few lines
   - **When you'll see it** — numbered steps of the real user or ops path
   - **What's wrong** — one clear explanation
   - **Reachable?** — yes / no, through which screen or API (one line)
   - **Fix before production?** — yes / no, and why (one line)
   - **Fix** — only when yes

6. **Hand over.** Say in one line if there are no Critical or Important findings. No padding, no "looks good overall".

## Rules of thumb

- A change that matches what the PR says it intends is not a finding. Check the commit messages first.
- Style and naming are not findings unless they cause real confusion.
- A migration deserves a look at locking and rollback: see the `risky-migration` issues in `changes`.
- Keep it short enough to read in one sitting.
