# FlowMap

See how your code flows, from a screen through the API and services down to database tables and external services, and catch risky patterns before they ship.

```
[screen] /settings/profile
└─ [component] Profile
   └─ [client] setNicknameAction
      └─ [api] mutation setNickname              ⚠ takes userId but never checks the caller
         └─ [fn] UserService.setNickname         ▓ opens a DB transaction
            ├─ writes → [table] users
            └─ customers.update → [external] Stripe   ⚠ called inside the transaction
```

- **Local only.** No network calls, no telemetry. The index is a SQLite file on your machine. (The optional Claude chat in Designs uses your own Claude Code, see below.)
- **Works across repos and services.** It links frontend and backend, and service to service, through GraphQL operation names, REST paths and queue names, in any mix of languages.
- **Three ways to use it:** a dashboard in the browser, a CLI for the terminal and CI, and an MCP server / Claude Code plugin.
- **Design before you code:** sketch a new feature on top of the real graph, with Claude or by hand, see what it would break, and export the RFC.
- **TypeScript, JavaScript and Python**, with a plugin per framework:

| Area | Supported |
|---|---|
| Screens | React Router, Next.js (app + pages), Remix / React Router 7, Vue Router, Nuxt, SvelteKit, Angular, TanStack Router, Expo Router, React Navigation, Astro |
| APIs | NestJS, Express, Fastify, Hono, Koa, Next.js route handlers and server actions, SvelteKit / Nuxt / Astro endpoints, FastAPI, Flask, Django + DRF, GraphQL SDL |
| Data | TypeORM, Prisma, Drizzle, SQLAlchemy, Django ORM, raw SQL |
| Transactions, jobs | typeorm-transactional, Prisma / Drizzle / SQLAlchemy / Django transactions, BullMQ, Celery, cron |
| Clients | Apollo, Redux Toolkit, fetch / axios / ofetch, requests / httpx, Stripe, AWS, mail and other SDKs |

## 1. Install (once per machine)

You need **Node 24 or newer** (check with `node -v`; with nvm: `nvm install 24`).

```bash
git clone <this-repo-url> flowmap
cd flowmap
npm install                  # no install scripts run; exact versions only
npm run build                # builds the dashboard
npm test                     # check: all tests pass
cd packages/cli && npm link  # adds the `flowmap` command
flowmap --help               # check: prints the command list
```

**After updating FlowMap** (`git pull` in the flowmap folder): run `npm install && npm run build` again.

## 2. Set up a repo (once per repo)

Skip this if the repo already has `flowmap.config.mjs` (a teammate set it up). Otherwise, run this in the root of the repo:

```bash
flowmap init
```

This creates `flowmap.config.mjs` (plugins are detected from `package.json`, `requirements.txt` or `pyproject.toml`, including monorepo packages) and adds `.flowmap/` to `.gitignore`. Open the config and review it:

```js
export default {
  name: "my-web",
  plugins: ["react-router", "redux-thunk", "apollo", "http-clients"],
  connect: ["../my-api"],      // repos this one calls; each has its own flowmap.config.mjs
  clients: [],                 // your API wrapper, e.g. [{ call: "api.request", opArg: 1 }]
  externals: {},               // your classes that call outside services, e.g. { PaymentsService: "Stripe" }
  ignore: ["**/*.test.ts"],
  rules: {},                   // e.g. { "n-plus-one": "off" }
  base: "origin/main",         // branch to compare against
};
```

**Connecting repos** (only if your app spans more than one repo, for example a frontend and a backend). Connect them to see one map from screen to database.

1. Keep the repos side by side in the same parent folder:
   ```text
   projects/
   ├─ my-web/    ← the repo you work in (it calls the API)
   └─ my-api/
   ```
2. Set up the other repo once: `cd my-api && flowmap init`
3. Set up your repo and connect it: `cd ../my-web && flowmap init --connect ../my-api`
4. Run `flowmap dev` in `my-web`. The dashboard now shows screen → API → database across both repos.

`--connect` just writes `connect: ["../my-api"]` into the config, a path relative to your repo. Repeat it to connect more repos. The connected repo is only read, never changed. If it's missing, FlowMap warns and skips the cross-repo checks; nothing fails.

- **Many services, no single entry point:** put one config in a separate folder that lists them all, and run FlowMap there:

  ```js
  export default {
    name: "shop",
    repos: [
      { name: "orders", path: "../orders", plugins: ["express", "http-clients"] },
      { name: "billing", path: "../billing", plugins: ["fastapi", "sqlalchemy", "celery"] },
    ],
  };
  ```

## 3. Use it (every day)

```bash
flowmap dev      # start of each session: indexes what changed, opens the dashboard, updates live on save
flowmap check    # before each PR: new issues in your changed lines
```

The first run parses the whole repo; after that only changed files are parsed. Edits to `flowmap.config.mjs` or `flowmap.baseline.json` also apply live, no restart needed.

| When | Run | You get |
|---|---|---|
| **Each session** | `flowmap dev` | Dashboard, kept up to date as you save |
| **Before each PR** | `flowmap check` | New issues in your changed lines (exit code 1 on errors) |
| **Reviewing a branch** | `flowmap changes` | APIs, screens and tables your branch affects |
| **After a big `git pull`** (dashboard not running) | `flowmap index` | Index brought up to date |
| **When needed** | `flowmap explain <name>` / `trace <name>` | What something does |
| **When needed** | `flowmap impact <name>` | Who depends on it |
| **When needed** | `flowmap reachable <name>` | Whether the UI can reach it |
| **When needed** | `flowmap map [screens\|apis\|jobs\|services]` | Every screen / API / job, or which service calls which |
| **When needed** | `flowmap search <text>` / `doctor` | Find things / check index health and setup suggestions |
| **After building a design** | `flowmap check --design <name>` | What's done, what's missing, what changed outside the plan, new issues |
| **Optional** | `flowmap screenshots` | Real screenshots of each screen from your running app, read-only (see below) |

`<name>` can be an API (`setNickname`), a function (`UserService.remove`), a screen path (`/settings/profile`), a component or a table.

**The dashboard** has eight pages:
- **Overview:** counts, the worst files, and setup suggestions (a framework plugin that's off, an SDK that may be an outside service).
- **App map:** every screen, API and background job, with what each one touches, plus a map of which service calls which. Open a screen to see its screenshot (if captured) next to an **outline** of what's on it and what each button calls, or its **flow** across repos with each repo or service in its own dashed box.
- **Explorer:** ⌘K to search, then follow the flow. Transactions are amber, external services red, tables blue; "+N" expands more.
- **Issues:** each one with why it matters and how to fix it.
- **Rules:** what every rule checks, its severity and how many issues it has.
- **Changes:** your branch compared with the base.
- **Tables:** who reads and writes each table.
- **Designs:** plan a new feature on the real graph (see below).

It runs on `127.0.0.1` behind a one-time token printed in the terminal.

### Screenshots (optional, once per frontend repo)

Every screen already shows an **outline** of what's on it (sections, buttons, links, inputs) and what each part calls. To also see the real look, start your app (`npm start`; add the backend for real data), add its URL to the frontend's config, and capture:

```js
screenshots: { baseUrl: "http://localhost:3000" },   // the URL you open in the browser (https and host name included)
```

```bash
flowmap screenshots --login   # once: a FlowMap browser window opens on your app; sign in yourself, then close it
flowmap screenshots           # captures every screen, signed in; re-run with --changed after UI changes
```

- **Read-only:** FlowMap only opens pages, never clicks or types. Anything that could change data is blocked while capturing (POST/PUT/PATCH/DELETE, GraphQL mutations, beacons); page loads, GETs and GraphQL queries go through. If your app refreshes the session on load, allow just that request, by URL part or GraphQL operation name: `allow: ["/api/auth/refresh"]` or `allow: ["refreshToken"]`. After each run FlowMap lists what it blocked most, and suggests the entry when pages keep going to sign-in. Sign-out pages are skipped so they can't end the session.
- **Sign-in, for any app:** you sign in yourself, in a separate FlowMap browser (email/password, SSO, MFA all work). FlowMap keeps that browser's sign-in, including cookies that would vanish when the window closes and `sessionStorage`, in `.flowmap/browser` (readable only by you, never committed), puts it back before each capture and saves the newest one after (for apps that rotate tokens). When it expires, FlowMap says so; run `--login` again. Use a test account.
- **Sample ids** for screens like `/projects/:id` come from links on captured pages; set them yourself with `params: { id: "1" }` if needed.
- **Clickable:** click a button on a screenshot (or a row in the outline) to see the API it calls or the screen it opens. The **Capture screenshot** button on a screen refreshes just that one.
- **Several frontends:** each frontend repo has its own `screenshots.baseUrl`.
- **Local only** by default (a host name pointing to your machine counts); a staging URL needs `allowRemote: true`. `--mobile`, `--dark`, `--only <text>` for more.
- Uses your installed Chrome, Edge or Chromium. Pages that need sign-in, error, or have no sample id fall back to the outline.

### Design a feature before building it

**Designs** (in the dashboard) is the same flow view as the App map, with your change drawn on top and editable:

1. **New design** → describe the feature to **Claude** in the chat, or just start adding things. Claude reads the code, gives a short overview and the decisions to make, then draws the design; what it adds is marked for you to accept or reject. There is nothing to configure or pick: the tabs work from what the design changes.
   - **Changes** is the diagram of the design, about ten nodes: what changes (new, changing, removing), the arrows between them, and what they read, write or send out (tables, queues, outside services). The unchanged code a change merely calls folds behind a **+N** on the node; click it to show them.
   - **Flow** is the real flow of the code you change, drawn like the App map in repo / service boxes: the way from the screens, APIs and jobs down to your changes. Branches that lead nowhere near a change fold behind a **+N**.
   - **Full detail** is the whole flow with every service function, side effect, table and transaction. Repos with no change start folded; click one to open it.
2. **Edit it yourself.** Everything is laid out automatically and re-tidies itself as you add, connect or fold things; drag a node to pin it where you want it (**Tidy** frees them again).
   - **Add** (toolbar, double-click the canvas, or drag from a node's dot onto empty space): a screen, API, function, table, external service, queue or job, connected from where you started. Type its name right away. ⌘K adds existing code.
   - Drag from one node's dot to another to connect them; double-click a new node (or F2) to rename it; **Delete** removes it from the drawing; ⌘Z / ⇧⌘Z undo and redo; right-click a node for its actions.
   - Click any real node for its full detail, with **Modify it** / **Remove it**: that tells FlowMap what your design does to existing code, so Impact, the RFC and the later check know.
   - Fold a repo box with its arrow; **Focus** hides the side panels; the sidebar, chat and details panel all collapse and stay that way.
3. **Impact** updates as you go: issues the design *would introduce* (a warning badge on the node) or resolve, tables it touches and who else uses them, screens that depend on what you change.
4. **RFC** tab: write the **TL;DR** (2–3 lines: what changes, why, the impact, what reviewers must decide), record the decisions, and write only the reasoning (Problem, Goals and non-goals, Proposal, Alternatives considered, Risks and impact, Rollout) from the template or let Claude do it. **Preview** shows the finished document, with the diagram as the picture.
5. **Export** has three groups. **RFC**: *Copy RFC* (paste into Notion or Linear), a `.md` download, or a `.zip` with the RFC and the picture for Notion's Import. **Diagram**: *Copy diagram image* (then ⌘V in Linear, Notion or Slack), or download it as PNG or SVG. The picture is the Changes view on a white background, with a title, a key, plain-words labels and numbers that match the *What changes* table. The RFC itself reads: status, Problem, TL;DR, **At a glance** (changes, tables touched, what reaches them, new issues) and the picture, your reasoning, then **What changes**, **Decisions** and **Impact**, written by FlowMap from the design.
6. After building it: `flowmap check --design <name>`.

The chat keeps **every conversation** about a design: the clock icon (History) lists them, opens one to carry on where you left off, or deletes it; the plus starts a new one without losing the others.

Designs are saved in `.flowmap/designs/` (git-ignored, never committed). Share one with *Export → Download design (.json)* and **Import**.

**Claude in the dashboard** needs only [Claude Code](https://claude.com/claude-code) installed and signed in (`flowmap doctor` and the Designs page show what's missing). The chat runs your local `claude` in your repo, so it works like Claude Code in a terminal: your CLAUDE.md, settings, hooks, skills and connectors apply, plus FlowMap's design tools. The chat panel has a switch:
- **Full access** (default): everything a terminal session can do, including editing files and running commands. A headless run can't ask for approval, so tool use is approved up front; what Claude is doing is listed while it works, and **Stop** ends it. Settings that deny a tool still apply.
- **Design only**: Claude can read code and edit the design, nothing else.

Like any Claude Code session, the messages and the code it reads go to Anthropic. Without Claude, everything else in Designs works.

### With Claude Code (once per machine)

`flowmap init` offers to add the plugin. Or in Claude Code:

```text
/plugin marketplace add /path/to/flowmap
/plugin install flowmap@flowmap
```

Restart Claude Code, then check that `/mcp` shows **flowmap**. `/flowmap:design` plans a feature from the terminal, on the same canvas. Claude can now trace flows, check impact and run `check` instead of reading large files. If its changes add new error-level issues, a Stop hook asks it to fix or explain them.

## 4. First run on an existing codebase (once per codebase)

An older codebase will show many issues. Go through them once:

| If an issue is… | Do this |
|---|---|
| A real problem | Keep it, and fix it later in its own PR |
| Wrong because FlowMap missed your wrapper or service class | Add it to `clients` / `externals` and run `flowmap index` |
| Intentional | Add `// flowmap-ignore <rule>: <reason>` above the line |
| From a rule too noisy for your team | `rules: { "<rule>": "warn" }` or `"off"` |

Then accept what's left. Run this in each repo (only the first time, or when the team agrees to accept a new set of issues):

```bash
flowmap baseline update      # writes flowmap.baseline.json (accepted issues + the API list); from now on only new issues are reported
```

**What to commit (once):** `flowmap.config.mjs`, `flowmap.baseline.json` and the `.gitignore` line. Never `.flowmap/`, which is the local index. Teammates then only need sections 1 and 3.

## Rules

| Rule | Catches |
|---|---|
| `tx-external-call` | Stripe, S3, mail, HTTP or queue calls while a DB transaction is open (unless deferred with `runOnTransactionCommit` / `on_commit`) |
| `tx-no-write` | A transaction that never writes |
| `n-plus-one` | A database query inside a loop |
| `id-without-actor` | An API takes an id from the client but never checks the caller (IDOR) |
| `raw-error-in-handler` | `throw new Error` / `raise Exception` reachable from an API (becomes a 500) |
| `unvalidated-input` | API input that no DTO or schema validates |
| `unguarded-operation` | An API without an auth guard |
| `dead-reference` | Imports of missing files or exports |
| `contract-drift` | The frontend calls an API the backend doesn't have, or a schema field has no resolver |
| `missing-fk-index` | A foreign-key column with no index in the model or any migration (skipped on MySQL, which adds them itself) |
| `breaking-change` | An API recorded in the baseline was removed |
| `write-on-get` | A GET endpoint or GraphQL query writes to the database |
| `multi-write-no-tx` | One API writes several tables without a transaction |
| `unbounded-query` | An API loads every matching row (no limit, page or id list) |
| `orphan-api` | No connected frontend calls this API (only for API families a client in the workspace uses) |
| `unreachable-screen` | Nothing in the app links to this screen |
| `queue-no-consumer` | A job, task or event that no worker or listener handles |
| `webhook-unverified` | A webhook endpoint that never checks the sender's signature or token |

Rules are educated guesses from the code, so most are warnings. Turn one off with `rules: { "<rule>": "off" }`, or keep a deliberate case with `// flowmap-ignore <rule>: <reason>` on the line above. `id-without-actor` is an error only when the API also writes data.

Indexes are read from models (`@Index`, `@@index`, `index=True`) and from migrations: SQL (`CREATE INDEX`, constraints in `CREATE TABLE`, `DROP INDEX`, in `.sql` files or strings), TypeORM, Knex, Sequelize and Alembic helpers. Rollback code is ignored, and only an index whose first column is the foreign key counts. The database is detected from driver dependencies; set `database: "postgres"` in the config if there are several.

## Troubleshooting

| Problem | Fix |
|---|---|
| `FlowMap needs Node 24+` | `nvm use 24` |
| `flowmap: command not found` | Run `npm link` in `packages/cli` (section 1) |
| `No FlowMap config found` | Run inside a repo with `flowmap.config.mjs`, or run `flowmap init` |
| `Dashboard is not built` | Run `npm run build` in the flowmap folder |
| `EADDRINUSE` | Another dashboard is running; use `flowmap dev --port 4401` |
| Dashboard asks for the link | Open the full `?token=…` link printed by `flowmap dev` |
| Results look wrong or stale | `flowmap index --full`, then `flowmap doctor` |

## How it works

TypeScript's own parser reads TS/JS files (and the script part of `.vue`, `.svelte`, `.astro` files); tree-sitter (WebAssembly) reads Python. The core and plugins turn them into a graph of screens, APIs, functions, tables and external services; the graph is stored in SQLite and linked across files and repos; rules and queries run on that graph. Only changed files are re-parsed, and the index is rebuilt by itself after a FlowMap update.

Plugins live in `packages/plugins` (see `bullmq.ts` for a short example). A plugin only returns data and has no file-system or network access. Routers are data, not code: a new one is usually an entry in `router-packs.ts` plus a fixture test. Rules work on the graph, so they apply to every stack.

**Working on FlowMap itself:** `npm run dev -- -w ../my-repo` restarts the server whenever FlowMap's code changes and keeps you logged in. Open the printed link once. Dashboard changes need `npm run build` and a browser refresh.

**Security:**
- The dashboard binds to localhost and requires a token cookie, and sends a strict CSP. Its API is read-only except two local writes, both inside `.flowmap/` and only from the dashboard itself (same origin + a custom header): capturing a screenshot and saving a design. The design chat runs your local `claude`; in "Full access" mode (the default) it can edit files and run commands in your repos, like a terminal session, and "Design only" limits it to reading code and editing the design.
- FlowMap never edits source files or reads `.env`/key files.
- Dependencies are few and pinned.

```
packages/core       graph, store, indexer, linker, config
packages/plugins    framework plugins
packages/rules      rules
packages/cli        CLI, dashboard server, MCP server
packages/dashboard  React dashboard
claude-plugin/      Claude Code plugin
fixtures/           sample repos used by the tests
```

## Limits

- TypeScript, JavaScript and Python. Other languages need a tree-sitter adapter plus framework plugins.
- Static analysis: dynamic calls and custom wrappers can hide links. Declare them in `clients` / `externals`.
- `n-plus-one` also flags small fixed loops. Ignore those with a reason, or relax the rule.
