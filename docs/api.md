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
| GET | `/api/changes?base=<git ref>` | `ChangeSet` |
| GET | `/api/events` | Server-Sent Events stream of `ServerEvent` JSON (`data:` lines) |

Node ids contain `:`, `/`, `#` — always `encodeURIComponent` them in paths.

Editor links: `vscode://file/<repo.path>/<file>:<line>` (or `cursor://file/...`), where `repo.path` comes from `Status.repos`.
