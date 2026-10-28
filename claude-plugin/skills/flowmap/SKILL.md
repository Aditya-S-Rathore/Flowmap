---
name: flowmap
description: Use the FlowMap code graph instead of reading large files when you need to know what a screen, API or function does, who uses it, what it writes, whether it is reachable from the UI, or whether a change introduced risky patterns. Applies to repos that have a FlowMap workspace.
---

# Using FlowMap

FlowMap has indexed this workspace into a graph: screens → client calls → APIs → services → DB tables / external services, with transactions, guards and feature flags. Every answer carries `file:line`.

## When to use which tool

| Question | Tool |
|---|---|
| "What's in this codebase?" / new to the repo | `map` (screens, APIs, jobs, or `services` for which service calls which) |
| "What does X do?" / before editing a function or API | `explain` (one card), then `trace` for the tree |
| "Who uses X?" / "What breaks if I change X?" | `impact`, or `trace` with `direction: "up"` |
| "Is X reachable from the app?" / is a flagged feature really hidden? | `reachable` |
| "Who writes table T?" | `tables` |
| Not sure of the exact name | `search` |
| Before saying a change is done | `check` (default: new issues in changed code) |
| Planning / designing a new feature, writing an RFC | the `design` skill: `design_context` → `design_save` → `design_impact` |

## Rules of thumb

- Prefer `explain`/`trace` over opening files longer than ~300 lines; open the file only at the `file:line` FlowMap points to.
- Use `trace` with `sideEffectsOnly: true` to see only DB writes, external calls and queued jobs.
- Before finishing, run `check`. Fix new **errors** (e.g. external call inside a DB transaction, id argument without caller check, contract drift). For warnings, fix them or say why they are fine.
- A finding that is intentional can be silenced with `// flowmap-ignore <rule>: <reason>` (or `# flowmap-ignore ...` in Python) above the line — only when the user agrees, and always with a reason.
- FlowMap is static analysis: edges marked "inferred" are best guesses; confirm in code before relying on them.
