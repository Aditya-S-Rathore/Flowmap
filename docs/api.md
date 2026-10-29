# FlowMap local server API

Served by `flowmap dev` on `http://127.0.0.1:4400`. Types live in `packages/core/src/api-types.ts`.

Auth: the browser opens `/?token=<t>`; the server sets an `HttpOnly; SameSite=Strict` cookie and all `/api/*`
calls are same-origin (cookie sent automatically). No CORS. Requests with a foreign `Host` header are rejected.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/status` | `Status` |
| GET | `/api/overview` | `Overview` |
| GET | `/api/search?q=&kind=&limit=20` | `SearchHit[]` (kind optional, comma list) |
| GET | `/api/graph/:id?dir=down\|up&depth=2&limit=40&sideEffects=0` | `Subgraph` (neighbourhood for the flow explorer; `limit` = max children per node, most important first; expand a node by calling again with its id and merging) |
| GET | `/api/explain/:id` | `ExplainCard` |
| GET | `/api/issues?rule=&severity=&status=&repo=&q=` | `{ issues: Issue[]; summary: IssueSummary }` |
| GET | `/api/rules` | `RuleInfo[]` |
| GET | `/api/tables` | `TableInfo[]` |
| GET | `/api/changes?base=<git ref>&head=<git ref>` | `ChangeSet` (`head` omitted: your working folder; given: that branch, nothing checked out). `changed[].change` is `new` (the branch added all of it) or `changed` (it was there and was touched); `diffs` maps a node id to its changed lines |
| GET | `/api/branches` | `{ branches, current, base }`: branch and tag names of the repo you work in, the one checked out, and the default base |
| GET | `/api/claude/commands` | `{ name, description }[]`: the commands Claude Code itself reports it accepts (skills, plugin skills, built-ins that work headless), for the agent's `/` menu |
| GET | `/api/events` | Server-Sent Events stream of `ServerEvent` JSON (`data:` lines) |
| GET | `/api/designs` | `DesignSummary[]` |
| GET | `/api/designs/:slug` | `DesignView` (design + nodes / edges as on the canvas, impact, chat) |
| GET | `/api/designs/:slug/flow?mode=compact\|full` | `DesignFlow`: the real flow around the code the design changes, found automatically (the flows of the entry points that reach it, merged) |
| GET | `/api/designs/:slug/export` | The RFC as Markdown. The diagram is a marker line (the dashboard draws the picture); its Mermaid source is the last section |
| GET | `/api/claude` | `ClaudeStatus` (installed, signed in, plugin added; local checks) |
| POST | `/api/designs/:slug` | Save a `Design` (`version` = the one you read, 0 to create) → `{ slug, version }` |
| POST | `/api/designs` | Import a shared `Design` under a free name → `{ slug, version }` |
| GET | `/api/chat/:scope` | `{ chat, conversations }`: the agent's open conversation and its history (`scope`: `agent-chat`, or a design slug for older per-design chats) |
| POST | `/api/designs/:slug/delete` | `{ confirm: true }` → `{}`: deletes the design file (and an older per-design chat file) for good; 404 if there is none |
| POST | `/api/agent/chat` | the dashboard's agent: the body below plus `page?` (what the user is looking at); its `show_flow` / `open_design` tool calls arrive as `{ type: "ui", action: "flow" \| "design", id }` events |
| POST | `/api/designs/:slug/chat` | `{ text, mode? }` → `{}` (`mode`: `"full"` = everything a terminal Claude Code session can do, `"design"` = read code + edit the design only; default `"design"`). Claude's reply and what it is doing stream as `chat` events (`text`, `tool`, `done`, `error`). Also: `{ cancel: true }` stops the current answer → `{ stopped }`; `{ new: true }` opens a blank conversation; `{ open: id }` / `{ remove: id }` open or delete one (`GET /api/chat/:scope` lists them); `{ clear: true }` deletes the whole history for good. Kept in `<scope>.chat.json` |

**Writes** (the POSTs above and `POST /api/capture/:id`) need `Origin: http://<host>` and `x-flowmap: 1`; design POSTs also `Content-Type: application/json`, body ≤ 512 KB.
Errors: 400 invalid name / design, 403 wrong origin or header, 404 unknown design, 409 the design changed since your `version` (read it again), 413 body too large, 415 not JSON.
Nodes may carry `x` / `y` with `pinned: true` (placed by hand; without `pinned` the layout decides). Designs live in `.flowmap/designs/<slug>.json` (slug: `[a-z0-9][a-z0-9-]{0,63}`); proposed nodes use ids `new:<key>`, real nodes their graph id. Every save emits a `design` event.

Node ids contain `:`, `/`, `#` — always `encodeURIComponent` them in paths.

Editor links: `vscode://file/<repo.path>/<file>:<line>` (or `cursor://file/...`), where `repo.path` comes from `Status.repos`.
