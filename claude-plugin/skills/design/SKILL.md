---
name: design
description: Design a new feature on the FlowMap canvas before writing code — read the current flow, agree the key decisions with the user, draw the proposed screens / APIs / functions / tables on top of the real graph, check what it would break, and draft the RFC. Use when the user wants to plan, design or scope a feature, or write an RFC, in a repo with a FlowMap workspace.
---

# Designing a feature with FlowMap

A design is a drawing on top of the real code graph: real nodes (existing code) plus proposed ones (`new:<key>`), and the edges between them. The user sees it live on the dashboard (`flowmap dev` → Designs) and edits it there too. You never write source code in this workflow — only the design file, through `design_save`.

## Steps

1. **Understand.** Call `design_context` with the feature in the user's words and, if known, the screen / API it starts from (use `search` to find it).
2. **A draft first?** If the user pastes a draft RFC, skip the overview. Map it onto the real graph (`search`, `design_context`), tell the user briefly where it doesn't match the code, ask only about what it leaves open, then draw (step 3) and finish the RFC (step 5), keeping the draft's wording where it still holds.
   **Otherwise, overview first.** Reply with a brief overview: the current flow in about 5 lines (what screen, which API, what it writes, which outside services), then **2–4 decisions** the user must make. Typical ones: where the data lives (new table / column / existing table), sync vs background job, who may call it (auth, roles), what happens on failure, what changes for existing users. Ask, don't assume. Stop and wait for answers.
3. **Draw.** Save a design with `design_save` (new design: `version: 0`; a short lowercase slug):
   - Start from the real nodes the feature touches (`change: "existing"`, or `"changed"` / `"removed"`), using their ids from `design_context`.
   - Add proposed nodes with `id: "new:<key>"`, `change: "new"`, a suggested `file`, and names in the **same style as the codebase** (see "Naming" in the context) — `flowmap check --design` later finds the built code by kind + name.
   - Model an API as Operation —handles→ Function, and a screen as Route —renders→ Component —requests→ Operation, so the auth and transaction checks apply. Set `guards` and `transactional` on proposed handlers / services as decided.
   - Record the answers in `decisions`. Give every changed or new node a one-line `note` saying what changes (it appears on the canvas and in the RFC's What changes table).
4. **Check.** Call `design_impact`. For each issue it would introduce: change the design (add the guard, wrap in a transaction, add the client), or explain to the user why it is acceptable.
5. **RFC.** Two places, kept short (the whole RFC should fit on two pages):
   - `summary` is the **TL;DR**: 2–3 lines. What changes, why, the impact, and what you need from the reviewers. Numbers, not adjectives.
   - `rfc` (Markdown) is the reasoning only, with these `##` sections and nothing else: **Problem** (2–4 bullets, with numbers) · **Goals and non-goals** · **Proposal** (numbered steps, one per change, naming the node it touches) · **Alternatives considered** (each with why not) · **Risks and impact** (only risks the numbers don't show) · **Rollout** (order, flags, migrations, how to roll back). An RFC is the final proposal: settle questions with the user first and record the answers in `decisions`, so there is no open-questions section.
   - Do **not** write a Summary, Decisions, Diagram, What changes or Impact section, and never a pointer like "see the decisions list": FlowMap adds the At a glance numbers, the diagram, a What changes table, the Decisions table (from `decisions`) and the impact when the RFC is exported. Put the answers in `decisions` and what each node changes in its `note`.
   - If the user already edited the RFC (`rfcBy: "user"`), keep their text and edit only what was asked.
6. **Iterate.** The user may edit the canvas between your turns. Always `design_get` before saving and send back the version you read; if the save reports a conflict, read again and re-apply your change. What you add appears as suggestions the user accepts or rejects.
7. **Hand over.** When the user is happy: `design_get` with `format: "markdown"` is the RFC + plan for review (Notion, Linear, a PR). After the feature is built, `flowmap check --design <slug>` shows what's done, missing, or changed outside the plan.

## Rules of thumb

- Brief and clear: overview before detail, questions before drawing.
- Only include what the feature touches; a design is not a map of the whole app.
- Reuse existing code where the graph shows it fits; say so in the node `note`.
- Never edit source files while designing.
