import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import type { Engine } from "./engine.ts";
import { formatArchitecture, formatChanges, formatExplain, formatIssues, formatMap, formatPaths, formatRefs, formatTree, setColor } from "./format.ts";
import { MapQueries } from "./map.ts";
import { Queries } from "./queries.ts";
import { pageNav, sendNav } from "./nav.ts";
import { changesBetween } from "./refs.ts";
import { designContext, designUsage, designView, readDesign, saveDesign, saveDiagram, toMarkdown, toMermaid } from "./designs.ts";

const SLUG = z.string().describe("Design name: lowercase letters, digits and dashes (e.g. archive-users).");
const TARGET = z.string().describe("Name or id: an API (setNickname), a function (UserService.remove), a screen path (/settings/billing), a component or a table (users).");

/** MCP server over stdio. Every call first syncs the index with the files on disk (incremental, usually < 1s). */
export async function serveMcp(engine: Engine) {
  setColor(false);
  const q = new Queries(engine);
  const m = new MapQueries(q);
  engine.refresh();
  const server = new McpServer({ name: "flowmap", version: "0.1.0" });

  const text = (t: string, structured?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: t }],
    ...(structured ? { structuredContent: structured } : {}),
  });
  const fresh = () => engine.refresh();
  const find = (target: string) => {
    const n = q.resolve(target);
    if (!n) throw new Error(`Nothing named "${target}" in the index. Try the search tool.`);
    return n;
  };

  server.registerTool("search", {
    title: "Search the code graph",
    description: "Find screens, APIs, functions, components and tables by name. Use before other tools when unsure of the exact name.",
    inputSchema: z.object({ query: z.string(), kind: z.string().optional().describe("Optional comma list: Route,Component,ClientCall,Operation,Function,Table,External,Job,Queue") }),
    annotations: { readOnlyHint: true },
  }, async ({ query, kind }) => {
    fresh();
    const hits = q.search(query, kind?.split(",") as any, 20);
    return text(hits.map((h) => `[${h.kind}] ${h.name}  ${h.repo}/${h.file}:${h.line}`).join("\n") || "No matches.", { hits });
  });

  // for the dashboard's agent: the chat runner turns these calls into "show this" events; here they only confirm
  server.registerTool("show_flow", {
    title: "Show a flow on the dashboard",
    description: "Put the flow diagram of a screen, API, function or table on the user's FlowMap dashboard. Use it when the user asks to see or trace something.",
    inputSchema: z.object({ target: TARGET }),
    annotations: { readOnlyHint: true },
  }, async ({ target }) => {
    const node = find(target);
    sendNav(engine, { type: "ui", action: "flow", id: node.id });
    return text(`Showing ${node.name} on the dashboard (it moves if \`flowmap dev\` is running).`);
  });

  server.registerTool("go_to", {
    title: "Take the dashboard to a page",
    description: "Move the user's dashboard to a page when they ask to see or go somewhere: overview · map (screens, APIs, jobs, services) · explore (a flow: give `target`) · issues (optionally `rule`, `severity`, `search`) · rules · changes (optionally `base` and `head`: two branches) · tables · designs (optionally `slug`).",
    inputSchema: z.object({
      page: z.enum(["overview", "map", "explore", "issues", "rules", "changes", "tables", "designs"]),
      target: z.string().optional().describe("explore: the screen, API, function or table to show."),
      slug: z.string().optional().describe("designs: which design."),
      base: z.string().optional().describe("changes: what to compare against."),
      head: z.string().optional().describe("changes: the branch to review."),
      rule: z.string().optional().describe("issues: a rule id."),
      severity: z.enum(["error", "warn"]).optional(),
      search: z.string().optional().describe("issues: text to search for."),
    }),
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const nav = pageNav(engine, args);
    if (!nav) throw new Error("Not a page of the dashboard.");
    sendNav(engine, nav);
    return text(`Opened ${args.page} on the dashboard (it moves if \`flowmap dev\` is running).`);
  });

  server.registerTool("draw_diagram", {
    title: "Draw a diagram on the dashboard",
    description: "Draw something in the user's own format as an editable diagram (boxes with points, and arrows), saved as a new design that opens on their canvas: a simpler view of a flow with fewer steps, a process, a comparison, before and after. Not for changes to the code (use design_save for those). Keep it small: at most 8 steps, one to three short points each. A step can name the real code it stands for.",
    inputSchema: z.object({
      title: z.string().min(1).max(80).describe("What the diagram shows."),
      summary: z.string().max(500).optional().describe("One or two lines: what to take from it."),
      steps: z.array(z.object({
        key: z.string().regex(/^[a-z0-9-]{1,40}$/).describe("A short id, used by the arrows."),
        title: z.string().min(1).max(80),
        points: z.array(z.string().max(200)).max(5).optional().describe("Short lines explaining the step."),
        code: z.string().optional().describe("A screen, API, function or table this step stands for; its file and line are added."),
        shape: z.enum(["box", "decision", "text"]).optional().describe("decision: a question with branches."),
      })).min(1).max(15),
      arrows: z.array(z.object({ from: z.string(), to: z.string() })).max(30),
    }),
  }, async (input) => {
    fresh();
    const slug = saveDiagram(q, input);
    sendNav(engine, { type: "ui", action: "design", id: slug });
    return text(`Drew "${input.title}" as design ${slug}. It opens on the user's dashboard for them to edit (if \`flowmap dev\` is running); change it later with design_get and design_save.`, { slug });
  });

  server.registerTool("open_design", {
    title: "Open a design on the dashboard",
    description: "Open a saved design (after design_save) on the user's dashboard.",
    inputSchema: z.object({ slug: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ slug }) => {
    readDesign(engine.ws, slug);                                     // must exist
    sendNav(engine, { type: "ui", action: "design", id: slug });
    return text(`Opened design ${slug} on the dashboard (it moves if \`flowmap dev\` is running).`);
  });

  server.registerTool("trace", {
    title: "Trace a flow",
    description: "Tree of what a screen/API/function does (down: calls, DB reads/writes, external calls, transactions) or who uses it (up). Prefer this over reading large files.",
    inputSchema: z.object({
      target: TARGET,
      direction: z.enum(["down", "up"]).default("down"),
      depth: z.number().int().min(1).max(8).default(3),
      sideEffectsOnly: z.boolean().default(false).describe("Only keep branches that write to the DB, call external services or enqueue jobs."),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ target, direction, depth, sideEffectsOnly }) => {
    fresh();
    const sg = q.subgraph(find(target).id, direction, depth, sideEffectsOnly, 120);
    return text(formatTree(sg, direction), { nodes: sg.nodes.length, edges: sg.edges.length });
  });

  server.registerTool("explain", {
    title: "Explain a node",
    description: "One card: screens that use it, guards/permissions, caller check, input, tables read/written, external calls (and whether inside a transaction), issues.",
    inputSchema: z.object({ target: TARGET }),
    annotations: { readOnlyHint: true },
  }, async ({ target }) => {
    fresh();
    return text(formatExplain(q.explain(find(target).id)));
  });

  server.registerTool("impact", {
    title: "Impact of changing something",
    description: "Everything upstream that depends on the target: APIs, screens, components, jobs. Use before changing shared code.",
    inputSchema: z.object({ target: TARGET }),
    annotations: { readOnlyHint: true },
  }, async ({ target }) => {
    fresh();
    const r = q.impact(find(target).id);
    return text(formatRefs({ APIs: r.operations, Screens: r.screens, Components: r.components, "Client calls": r.clientCalls, Jobs: r.jobs, Functions: r.functions }));
  });

  server.registerTool("reachable", {
    title: "Is it reachable from the UI?",
    description: "Whether the target can be reached from any app screen, with the paths (screen → … → target). Use for feature-flag / dead-code questions.",
    inputSchema: z.object({ target: TARGET }),
    annotations: { readOnlyHint: true },
  }, async ({ target }) => {
    fresh();
    const r = q.reachable(find(target).id);
    return text(r.reachable ? `Reachable from ${r.paths.length} screen path(s):\n${formatPaths(r.paths)}` : "Not reachable from any routed screen (it may still be called by jobs, webhooks or other clients).", r);
  });

  server.registerTool("tables", {
    title: "Who reads and writes a table",
    description: "For a table/entity: functions that read it, functions that write it, and its relations.",
    inputSchema: z.object({ name: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ name }) => {
    fresh();
    const t = q.tables().find((x) => x.name === name || x.entity === name) ?? q.tables().find((x) => x.name.includes(name));
    if (!t) return text(`No table "${name}".`);
    return text(formatRefs({ [`Writers of ${t.name}`]: t.writers, [`Readers of ${t.name}`]: t.readers }) + (t.relations.length ? `\n\nRelations: ${t.relations.map((r) => `${r.column} → ${r.to}${r.indexed ? "" : " (no index)"}`).join(", ")}` : ""));
  });

  server.registerTool("map", {
    title: "Screens, APIs, jobs and services",
    description: "Overview lists: every screen (with the APIs, tables and outside services it reaches), every API (guarded or not, which screens use it), jobs/queues, or the service map (which service calls which). Use to orient in an unfamiliar codebase.",
    inputSchema: z.object({
      view: z.enum(["screens", "apis", "jobs", "services"]).default("screens"),
      filter: z.string().optional().describe("Only items whose repo or name contains this text"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ view, filter }) => {
    fresh();
    return text(view === "services" ? formatArchitecture(m.architecture()) : formatMap(m.appMap(), view, filter));
  });

  server.registerTool("changes", {
    title: "What a branch touches",
    description: "For a review or before a release: the code a branch changed, the screens, APIs and tables that reach, new issues, migrations and feature flags. Pass `head` to review a branch without checking it out (and without touching your working folder).",
    inputSchema: z.object({
      base: z.string().optional().describe("What to compare against (default: the repo's base branch)."),
      head: z.string().optional().describe("Branch, tag or commit to review. Omitted: your working folder."),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ base, head }) => {
    fresh();
    const cs = head ? await changesBetween(engine, base, head) : q.changes(base);
    return text(formatChanges(cs), { changed: cs.changed.length, migrations: cs.migrations, flags: cs.flags });
  });

  server.registerTool("check", {
    title: "Check for issues",
    description: "Run FlowMap rules (transactions around external calls, N+1, missing caller checks, unguarded APIs, contract drift…). By default only NEW issues in code changed vs the base branch. Run before saying a change is done.",
    inputSchema: z.object({
      scope: z.enum(["changed", "new", "all"]).default("changed").describe("changed = new issues in changed code; new = all issues not in baseline; all = everything"),
      base: z.string().optional().describe("Git ref to compare with (default: repo's configured base)"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ scope, base }) => {
    fresh();
    const list = scope === "changed" ? q.changes(base).issues : scope === "new" ? q.issues({ status: "new" }) : q.issues();
    return text(`${list.length} issue(s)\n${formatIssues(list.slice(0, 40), { why: true })}${list.length > 40 ? `\n… ${list.length - 40} more` : ""}`, { count: list.length });
  });

  server.registerTool("design_context", {
    title: "Context for designing a feature",
    description: "Before designing a feature: the current flow from a screen / API / function to look at first, related code by name, tables involved, open issues, the codebase's naming style and existing designs.",
    inputSchema: z.object({ feature: z.string().describe("What the feature should do, in the user's words"), anchor: z.string().optional().describe("A screen, API or function to look at first") }),
    annotations: { readOnlyHint: true },
  }, async ({ feature, anchor }) => {
    fresh();
    return text(`${designContext(q, feature, anchor)}\n\n${designUsage}`);
  });

  server.registerTool("design_get", {
    title: "Read a design",
    description: "A design as JSON (to edit and save back, keep its version), as the Markdown RFC + plan, or as a Mermaid diagram.",
    inputSchema: z.object({ slug: SLUG, format: z.enum(["json", "markdown", "mermaid"]).default("json") }),
    annotations: { readOnlyHint: true },
  }, async ({ slug, format }) => {
    fresh();
    if (format === "json") return text(JSON.stringify(readDesign(engine.ws, slug), null, 2));
    const v = designView(q, slug);
    return text(format === "markdown" ? toMarkdown(v) : toMermaid(v));
  });

  server.registerTool("design_save", {
    title: "Save a design",
    description: `Create (version 0) or update a design; the user sees it live on the dashboard canvas, with your additions marked for them to accept. Pass the version you read: if the user edited it since, read it again and re-apply your change. Writes only .flowmap/designs/<slug>.json, never source code.\n${designUsage}`,
    inputSchema: z.object({ slug: SLUG, design: z.record(z.string(), z.unknown()).describe("The full design JSON") }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ slug, design }) => {
    fresh();
    const d = saveDesign(engine.ws, slug, design, "claude");
    return text(`Saved ${slug} (version ${d.version}). Open the dashboard at #/designs/${slug} to review.`);
  });

  server.registerTool("design_impact", {
    title: "Impact of a design",
    description: "What building the design would change: issues it would introduce or resolve, tables it touches and who else uses them, screens / APIs depending on changed or removed code.",
    inputSchema: z.object({ slug: SLUG }),
    annotations: { readOnlyHint: true },
  }, async ({ slug }) => {
    fresh();
    const { impact, stale } = designView(q, slug);
    return text([
      `Would introduce ${impact.introduced.length} issue(s)\n${formatIssues(impact.introduced, { why: true })}`,
      impact.resolved.length ? `Would resolve: ${impact.resolved.map((i) => `${i.ruleTitle} (${i.nodeName})`).join(", ")}` : "",
      impact.tables.length ? `Tables: ${impact.tables.map((t) => `${t.name} (${t.readers.length} readers, ${t.writers.length} writers)`).join(", ")}` : "",
      impact.dependents.length ? formatRefs(Object.fromEntries(impact.dependents.map((x) => [`Depends on ${x.name}`, x.refs]))) : "",
      stale.length ? `No longer in the code: ${stale.join(", ")}` : "",
    ].filter(Boolean).join("\n\n"));
  });

  await server.connect(new StdioServerTransport());
}
