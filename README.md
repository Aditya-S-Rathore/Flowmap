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

- **Local only.** No network calls, no telemetry. The index is a SQLite file on your machine. (The optional Agent uses your own Claude Code, see below.)
- **Works across repos and services.** It links frontend and backend, and service to service, through GraphQL operation names, REST paths and queue names, in any mix of languages.
- **Three ways to use it:** a dashboard in the browser (with an Agent you can ask), a CLI for the terminal and CI, and an [MCP server](#mcp-flowmap-inside-your-ai-tool-once-per-machine) for your AI tool.
- **Design before you code:** sketch a new feature on top of the real graph, with Claude or by hand, see what it would break, and export the RFC.
- **Where it helps:** finding what a change affects across screens, APIs, tables and repos, and flagging risky patterns. It maps how code connects; it does not read function logic, so read the key functions too. On a small change in a small repo, your editor's own search is enough.
- **TypeScript, JavaScript and Python**, with a plugin per framework:

| Area | Supported |
|---|---|
| Screens | React Router, Next.js (app + pages), Remix / React Router 7, Vue Router, Nuxt, SvelteKit, Angular, TanStack Router, Expo Router, React Navigation, Astro |
| APIs | NestJS, Express, Fastify, Hono, Koa, Next.js route handlers and server actions, SvelteKit / Nuxt / Astro endpoints, FastAPI, Flask, Django + DRF, GraphQL SDL |
| Data | TypeORM, Prisma, Drizzle, SQLAlchemy, Django ORM, raw SQL |
| Transactions, jobs | typeorm-transactional, Prisma / Drizzle / SQLAlchemy / Django transactions, BullMQ, Celery, cron |
| Clients | Apollo, Redux Toolkit, fetch / axios / ofetch, requests / httpx, Stripe, AWS, mail and other SDKs |

**Contents:** [Quick start](#quick-start) · [Install](#1-install-once-per-machine) · [Set up a repo](#2-set-up-a-repo-once-per-repo) · [Use it](#3-use-it-every-day) · [Design a feature](#design-a-feature-before-building-it) · [MCP](#mcp-flowmap-inside-your-ai-tool-once-per-machine) · [Rules](#rules) · [Troubleshooting](#troubleshooting) · [Limits](#limits)

## Quick start

```bash
git clone <this-repo-url> flowmap && cd flowmap && npm install && npm run build   # once per machine
cd packages/cli && npm link                                                       # adds the `flowmap` command
cd /path/to/your-repo && flowmap init && flowmap dev                              # once per repo, then every day
```

`flowmap dev` opens the dashboard. Optional: add FlowMap to your AI tool ([MCP](#mcp-flowmap-inside-your-ai-tool-once-per-machine)), and ask the **Agent** (top right) about your code. Details below.

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
  flags: [],                   // your feature-flag checks, e.g. [{ call: "useFeatureFlag" }]: code that calls one is marked "behind that flag"
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
| **Reviewing a branch you have not checked out** | `flowmap changes --base main --head feature/x` | The same, for any two branches or tags. Git reads the branch itself, so your files and your current branch stay as they are |
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
- **Changes:** a branch compared with a base (pick any two, nothing is checked out). It starts with the branch you are on against your repo's `base` (set `base: "origin/develop"` in the config; the default is the main branch), and says which is which: a picture of the changed code and what it reaches (each box says whether it is **new** or **changed**; click one to see the lines that changed in it), the changed code with links and the same diff, the screens, APIs and tables affected, new issues, and a *Before you release* box (migrations, feature flags). **Copy review** gives the same as text. The first comparison of a branch indexes a copy of it in `.flowmap/refs/` (the last five are kept); one repo at a time, connected repos are read as they are.
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

1. **New design** → describe the feature to the **Agent**, paste a rough RFC (**Import a draft**), or just start adding things. Claude reads the code, gives a short overview and the decisions to make, then draws the design; what it adds is marked for you to accept or reject. There is nothing to configure or pick: the tabs work from what the design changes.
   - **Changes** is the diagram of the design, about ten nodes: what changes (new, changing, removing), the arrows between them, and what they read, write or send out (tables, queues, outside services). The unchanged code a change merely calls folds behind a **+N** on the node; click it to show them.
   - **Flow** is the real flow of the code you change, drawn like the App map in repo / service boxes: the way from the screens, APIs and jobs down to your changes. Branches that lead nowhere near a change fold behind a **+N**.
   - **Full detail** is the whole flow with every service function, side effect, table and transaction. Repos with no change start folded; click one to open it.
2. **Edit it yourself.** Everything is laid out automatically and re-tidies itself as you add, connect or fold things; drag a node to pin it where you want it (**Tidy** frees them again).
   - **Add** (toolbar, double-click the canvas, or drag from a node's dot onto empty space): a screen, API, function, table, external service, queue or job, connected from where you started. Type its name right away. ⌘K adds existing code.
   - **Free shapes** (Add → Box, Decision, Text) are for anything that isn't code: a step, a question, a marketing or process flow. Give a box **points** (one per line) in the side panel. When the code for it exists, **Link to code…** turns the box into the real node and keeps its arrows. Boxes are left out of the checks and the *What changes* table; the RFC lists them as *Steps in the diagram*.
   - **Tables show their columns** (TypeORM today) on the card, six at a time. Select a table → **Add a column**: the new columns appear in green on the card, and in the RFC under *Data changes*.
   - Drag from one node's dot to another to connect them; double-click a new node (or F2) to rename it; **Delete** removes it from the drawing; ⌘Z / ⇧⌘Z undo and redo; right-click a node for its actions.
   - Click any real node for its full detail, with **Modify it** / **Remove it**: that tells FlowMap what your design does to existing code, so Impact, the RFC and the later check know.
   - Fold a repo box with its arrow; **Focus** hides the side panels; the sidebar and details panel collapse and stay that way.
3. **Impact** updates as you go: issues the design *would introduce* (a warning badge on the node) or resolve, tables it touches and who else uses them, screens that depend on what you change.
4. **RFC** tab: write the **TL;DR** (2–3 lines: what changes, why, the impact, what reviewers must decide), record the decisions, and write only the reasoning (Problem, Goals and non-goals, Proposal, Alternatives considered, Risks and impact, Rollout) from the template or let Claude do it. **Preview** shows the finished document, with the diagram as the picture.
5. **Export** has three groups. **RFC**: *Copy RFC* (paste into Notion or Linear), a `.md` download, or a `.zip` with the RFC and the picture for Notion's Import. **Diagram**: *Copy diagram image* (then ⌘V in Linear, Notion or Slack), or download it as PNG or SVG. The picture is the Changes view on a white background, with a title, a key, plain-words labels and numbers that match the *What changes* table. The RFC itself reads: status, Problem, TL;DR, **At a glance** (changes, tables touched, what reaches them, new issues) and the picture, your reasoning, then **What changes**, **Decisions** and **Impact**, written by FlowMap from the design.
6. After building it: `flowmap check --design <name>`.

**The Agent** (the button at the top right, on every page) is the one place to ask, and it drives the dashboard. Ask how something works and it answers from the real flow *and shows it*: the dashboard jumps to that flow. Ask it to go anywhere ("show the error issues", "compare `feature/x` with `main`", "open the service map"), or to design a feature, and it opens the page and starts drawing on the design canvas. Ask it to *draw* something ("how a nickname is saved, simple, 6 boxes") and it draws that, in your format, as an editable diagram instead of opening the exact flow. It knows which page you are on. It keeps **every conversation**: the clock icon (History) lists them, opens one to carry on where you left off, or deletes it; the plus starts a new one without losing the others. The header has a **model** picker (Default, Opus, Sonnet, Haiku: Claude Code's own names; each reply shows the exact model that answered) and, in browsers that support it, a **mic** for dictation (Chrome sends the audio to Google).

Designs are saved in `.flowmap/designs/` (git-ignored, never committed). Share one with *Export → Download design (.json)* and **Import**. The trash icon on a design in the list deletes it from your computer for good (no trash can). In the Agent, History → *Delete all conversations* does the same for the chat. Copies you exported or pasted elsewhere, and Claude Code's own session logs in its config folder, are not touched.

**The Agent** needs only [Claude Code](https://claude.com/claude-code) installed and signed in (`flowmap doctor` and the Designs page show what's missing). It runs your local `claude` in your repo, so it works like Claude Code in a terminal: your CLAUDE.md, settings, hooks, skills and connectors apply, plus FlowMap's design tools. The panel has a switch:
- **Full access** (default): everything a terminal session can do, including editing files and running commands. A headless run can't ask for approval, so tool use is approved up front; what Claude is doing is listed while it works, and **Stop** ends it. Settings that deny a tool still apply.
- **Design only**: Claude can read code and edit the design, nothing else.

Like any Claude Code session, the messages and the code it reads go to Anthropic.

**Without Claude**, the canvas, impact, RFC and export all work by hand (⌘K adds existing code), or connect another AI tool through [MCP](#mcp-flowmap-inside-your-ai-tool-once-per-machine). Designs are new: feedback is welcome.

## MCP: FlowMap inside your AI tool (once per machine)

With MCP your AI tool asks FlowMap instead of reading files: who calls this, is it reachable from a screen, what would break, what a branch touches. It runs on your machine, over stdio.

**Claude Code:** `flowmap init` offers to add the plugin. Or:

```text
/plugin marketplace add /path/to/flowmap
/plugin install flowmap@flowmap
```

Restart Claude Code and check that `/mcp` shows **flowmap**. The plugin also adds `/flowmap:flowmap` (use the graph instead of reading large files) and `/flowmap:design` (plan a feature), and a Stop hook that asks Claude to fix or explain new error-level issues before it says "done".

**Any other tool that supports MCP** (Cursor, Codex, Gemini CLI…): add this to its MCP settings, with your repo's path. For designs, also paste [the design instructions](claude-plugin/skills/design/SKILL.md) into its rules file. Only Claude Code has been tested.

```json
{ "mcpServers": { "flowmap": { "command": "flowmap", "args": ["mcp", "-w", "/path/to/your-repo"] } } }
```

**Two screens:** keep `flowmap dev` open on one screen and your AI tool on the other. The tools `show_flow`, `go_to`, `open_design` and `draw_diagram` move that dashboard for you ("show me how X works", "compare `feature/x` with `main`", "draw it simpler"). The place to go is passed through `.flowmap/nav.json`, which the running dashboard watches. If it isn't running, nothing moves and the answer still appears in your chat.

**The tools** (every call first syncs the index with your files, usually under a second):

| Tool | Ask it | You get |
|---|---|---|
| `search` | "find the nickname API" | Screens, APIs, functions, tables by name, with file and line |
| `trace` | "what does setNickname do?" / "who uses it?" | The tree down (calls, reads, writes, outside calls, transactions) or up (what depends on it) |
| `explain` | "explain UserService.remove" | One card: screens using it, guards, tables, outside calls, issues |
| `tables` | "who writes `users`?" | Readers, writers and relations of a table |
| `map` | "list all APIs", "which service calls which" | Every screen, API, job, or the service map |
| `impact` | "what breaks if I change this?" | Every screen, API and job that depends on it |
| `reachable` | "can a user reach this? is it behind a flag?" | The paths from screens to it |
| `check` | "any new issues?" | The rules' findings in code you changed |
| `changes` | "what does `feature/x` touch compared to `main`?" | What a branch touches, the screens, APIs and tables it reaches, new issues, migrations, feature flags. Give it `head` and nothing is checked out. By default only the repo you work in is covered (`includeConnected` adds the others) |
| `design_context` | "design: archive users" | The current flow, related code, tables, naming style, what to read first |
| `design_get` / `design_save` / `design_impact` | (the design flow) | Read, save and check a design; it appears live on the dashboard canvas, additions marked for you to accept |
| `draw_diagram` | "draw how X works, simple, 6 boxes" | A picture in your own format (boxes with points, arrows), saved as a new design that opens on your canvas to edit, link to code and export. Not a change to the code |
| `show_flow` / `open_design` / `go_to` | "show me how X works", "open the issues", "compare `feature/x` with `main`" | Moves your dashboard: a flow, a design, or any page (the Agent uses these to drive it) |

Try: *"Who calls `UserService.remove`, and can a user reach it?"* · *"Review `feature/x` against `main`."* · *"Design: let admins archive users."*

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
| `risky-migration` | A migration that can lock a busy table or fail on one with rows: an index without `CONCURRENTLY`, a NOT NULL column with no default, a foreign key that validates under lock, a column type change, or `CONCURRENTLY` inside a transaction (PostgreSQL) |
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
| `/mcp` shows **flowmap** as failed ("Connection closed") | The server stops when it finds no FlowMap config in the folder your AI tool was opened in. Open the tool in the repo, run `flowmap init` there, or put `"-w", "/path/to/repo"` in the MCP args |
| The Agent says Claude is missing | Install [Claude Code](https://claude.com/claude-code) and run `claude` once to sign in; `flowmap doctor` checks it |
| Dashboard asks for the link | Open the full `?token=…` link printed by `flowmap dev` |
| Results look wrong or stale | `flowmap index --full`, then `flowmap doctor` |

## How it works

TypeScript's own parser reads TS/JS files (and the script part of `.vue`, `.svelte`, `.astro` files); tree-sitter (WebAssembly) reads Python. The core and plugins turn them into a graph of screens, APIs, functions, tables and external services; the graph is stored in SQLite and linked across files and repos; rules and queries run on that graph. Only changed files are re-parsed, and the index is rebuilt by itself after a FlowMap update.

Plugins live in `packages/plugins` (see `bullmq.ts` for a short example). A plugin only returns data and has no file-system or network access. Routers are data, not code: a new one is usually an entry in `router-packs.ts` plus a fixture test. Rules work on the graph, so they apply to every stack.

**Working on FlowMap itself:** `npm run dev -- -w ../my-repo` restarts the server whenever FlowMap's code changes and keeps you logged in. Open the printed link once. Dashboard changes need `npm run build` and a browser refresh.

**Security:**
- The dashboard binds to localhost and requires a token cookie, and sends a strict CSP. Its API is read-only except local writes inside `.flowmap/` (git-ignored): capturing a screenshot, saving a design or a chat, and, when you compare branches, a cached copy of each branch (`.flowmap/refs/`, the last five kept). Writes from the dashboard need the same origin and a custom header. Git is run without a shell for branch names (they are checked first and never read as options), and only to read. The Agent runs your local `claude`; in "Full access" mode (the default) it can edit files and run commands in your repos, like a terminal session, and "Design only" limits it to reading code and editing the design.
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

- The MCP tool list costs about 3,000 tokens at the start of each AI session. Answers are small (tens to a few hundred tokens each on a small project), so FlowMap pays off when it saves the AI from reading many files, not on a tiny question.
- TypeScript, JavaScript and Python. Other languages need a tree-sitter adapter plus framework plugins.
- Static analysis: dynamic calls and custom wrappers can hide links. Declare them in `clients` / `externals`.
- It shows what connects to what, not what a function does inside. In side-by-side tests it found far more dependents than plain code reading, but missed logic details (such as a uniqueness check) that reading caught, and it was not cheaper in tokens. Use it for impact, then read the key functions.
- `n-plus-one` also flags small fixed loops. Ignore those with a reason, or relax the rule.
