import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { changesKeep, DIAGRAM_MARKER, isSketch, numberChanges, RFC_TEMPLATE, RFC_TEMPLATE_SHORT, summarize, trim, type Arrow } from "@flowmap/core";
import type { Edge } from "@flowmap/core";
import type {
  ChatSummary, Design, DesignAuthor, DesignChat, DesignEdgeView, DesignFlow, DesignImpact, DesignNode, DesignNodeView, DesignSummary, DesignView, EdgeKind,
  EdgeView, GraphNode, Issue, NodeKind, NodeView, Ref, Workspace,
} from "@flowmap/core";
import { formatIssues, formatTree } from "./format.ts";
import type { MapQueries } from "./map.ts";
import type { Queries } from "./queries.ts";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NEW_ID = /^new:[a-z0-9-]{1,48}$/;
const KINDS = ["Route", "Component", "ClientCall", "Operation", "Schema", "Function", "Guard", "Table", "External", "Job", "Queue", "Box"] as const satisfies readonly NodeKind[];
const EDGE_KINDS = ["renders", "calls", "requests", "handles", "guarded_by", "decorated_by", "reads", "writes", "calls_external", "enqueues", "triggers", "defines", "relates", "navigates"] as const satisfies readonly EdgeKind[];
const HIDDEN: EdgeKind[] = ["guarded_by", "decorated_by", "relates"];
const BOUNDARY: NodeKind[] = ["Route", "Operation", "Job", "Queue", "Table", "External"];

/** Error with the HTTP status the dashboard server answers with. */
export class DesignError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

// ---------- schema ----------

const str = (max: number) => z.string().max(max);
const author = z.enum(["user", "claude"]);
const coord = z.number().min(-1e6).max(1e6);

const DesignSchema = z.object({
  version: z.number().int().min(0),
  title: str(200).trim().min(1),
  status: z.enum(["draft", "review", "approved", "rejected"]).optional(),
  summary: str(5000).default(""),
  rfc: str(100_000).default(""),
  rfcBy: author.optional(),
  nodes: z.array(z.object({
    id: str(500),
    change: z.enum(["existing", "new", "changed", "removed"]),
    kind: z.enum(KINDS),
    name: str(300).min(1),
    repo: str(100).default(""),
    file: str(300).optional(),
    transactional: z.boolean().optional(),
    guards: z.array(str(100)).max(20).optional(),
    note: str(2000).optional(),
    items: z.array(z.object({ text: str(300), new: z.boolean().optional() })).max(100).optional(),
    shape: z.enum(["box", "decision", "text"]).optional(),
    w: z.number().min(40).max(4000).optional(),
    h: z.number().min(24).max(4000).optional(),
    x: coord.optional(),
    y: coord.optional(),
    pinned: z.boolean().optional(),
    keep: z.boolean().optional(),
    author: author.default("user"),
    pending: z.boolean().optional(),
  })).max(500).default([]),
  edges: z.array(z.object({
    id: str(100).min(1),
    src: str(500),
    dst: str(500),
    kind: z.enum(EDGE_KINDS),
    change: z.enum(["new", "removed"]),
    author: author.default("user"),
    pending: z.boolean().optional(),
  })).max(1000).default([]),
  notes: z.array(z.object({ id: str(100).min(1), text: str(2000), x: coord, y: coord, author: author.default("user") })).max(200).default([]),
  decisions: z.array(z.object({ question: str(500), answer: str(2000) })).max(50).default([]),
  updatedAt: str(40).default(""),
}).superRefine((d, ctx) => {
  const ids = new Set<string>();
  d.nodes.forEach((n, i) => {
    if (ids.has(n.id)) ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `duplicate id ${n.id}` });
    ids.add(n.id);
    if ((n.change === "new") !== NEW_ID.test(n.id)) {
      ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `proposed nodes (change "new") use ids "new:<lowercase-key>", real nodes their graph id` });
    }
  });
  d.edges.forEach((e, i) => {
    if (!ids.has(e.src) || !ids.has(e.dst)) ctx.addIssue({ code: "custom", path: ["edges", i], message: `edge ${e.id} connects a node that is not in the design` });
  });
});

/** Validates anything read from disk or received from the dashboard / Claude. */
export function parseDesign(raw: unknown): Design {
  const r = DesignSchema.safeParse(raw);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw new DesignError(`Invalid design: ${i.path.join(".") || "(root)"}: ${i.message}`, 400);
}

// ---------- files (.flowmap/designs/<slug>.json, git-ignored with the rest of .flowmap) ----------

export const designsDir = (ws: Workspace) => join(ws.dir, ".flowmap", "designs");

function designFile(ws: Workspace, slug: string) {
  if (!SLUG.test(slug)) throw new DesignError(`Invalid design name "${slug}": use lowercase letters, digits and dashes.`, 400);
  const dir = designsDir(ws);
  const file = join(dir, `${slug}.json`);
  for (const p of [dir, file]) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new DesignError(`Refusing to follow a symlink: ${p}`, 400);
  return file;
}

export function readDesign(ws: Workspace, slug: string): Design {
  const file = designFile(ws, slug);
  if (!existsSync(file)) throw new DesignError(`No design "${slug}".`, 404);
  return parseDesign(JSON.parse(readFileSync(file, "utf8")));
}

export function listDesigns(ws: Workspace): DesignSummary[] {
  const dir = designsDir(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => SLUG.test(f.slice(0, -5)) && f.endsWith(".json")).flatMap((f) => {
    const slug = f.slice(0, -5);
    try {
      const d = readDesign(ws, slug);
      const pending = d.nodes.filter((n) => n.pending).length + d.edges.filter((e) => e.pending).length;
      return [{ slug, title: d.title, summary: d.summary, version: d.version, updatedAt: d.updatedAt, pending }];
    } catch {
      return [];      // a broken file stays on disk but out of the list
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Writes the next version atomically (temp file + rename), so readers never see half a file. */
export function writeDesign(ws: Workspace, slug: string, d: Design): Design {
  const file = designFile(ws, slug);
  mkdirSync(designsDir(ws), { recursive: true });
  const next = { ...d, version: d.version + 1, updatedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return next;
}

// ---------- conversations with Claude: .flowmap/designs/<slug>.chat.json (next to the design, so saving the design never conflicts with chatting) ----------

export interface Conversation { id: string; title: string; updatedAt: string; session?: string; messages: DesignChat["messages"] }
export interface ChatStore { active: string; conversations: Conversation[] }

/** The chat scope of the agent when no design is open (its history lives in .flowmap/designs/agent-chat.chat.json). */
export const GLOBAL_CHAT = "agent-chat";
export const CONVERSATION_ID = /^c-[a-z0-9]{1,24}$/;
export const MAX_CONVERSATIONS = 20;
export const conversationId = () => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const titleOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";

const chatFile = (ws: Workspace, slug: string) => designFile(ws, slug).replace(/\.json$/, ".chat.json");
const blank = (): ChatStore => ({ active: "c-1", conversations: [{ id: "c-1", title: "", updatedAt: "", messages: [] }] });

const cleanMessages = (list: unknown): Conversation["messages"] => (Array.isArray(list) ? list : [])
  .filter((m: any) => (m?.role === "user" || m?.role === "claude") && typeof m.text === "string")
  .map(({ role, text, tools, model }: any) => ({ role, text, ...(typeof model === "string" ? { model: model.slice(0, 64) } : {}), ...(Array.isArray(tools) ? { tools: tools.filter((t: unknown) => typeof t === "string").slice(0, 100) } : {}) }));

const cleanConversation = (c: any, id: string): Conversation => ({
  id, title: typeof c?.title === "string" ? c.title.slice(0, 80) : "", updatedAt: typeof c?.updatedAt === "string" ? c.updatedAt : "",
  ...(typeof c?.session === "string" && /^[\w-]{1,100}$/.test(c.session) ? { session: c.session } : {}),
  messages: cleanMessages(c?.messages),
});

export function readChats(ws: Workspace, slug: string): ChatStore {
  const file = chatFile(ws, slug);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return blank();
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return blank(); }
  let conversations: Conversation[];
  if (Array.isArray(raw?.conversations)) conversations = raw.conversations.filter((c: any) => CONVERSATION_ID.test(c?.id)).map((c: any) => cleanConversation(c, c.id)).slice(0, MAX_CONVERSATIONS);
  else {                                          // the older format: one conversation, kept as the first entry of the history
    const c = cleanConversation(raw, conversationId());
    c.title = titleOf(c.messages.find((m) => m.role === "user")?.text ?? "Earlier conversation");
    c.updatedAt ||= statSync(file).mtime.toISOString();
    conversations = [c];
  }
  if (!conversations.length) return blank();
  return { active: conversations.some((c) => c.id === raw.active) ? raw.active : conversations[0].id, conversations };
}

export function writeChats(ws: Workspace, slug: string, store: ChatStore) {
  const file = chatFile(ws, slug);
  const conversations = store.conversations.slice(0, MAX_CONVERSATIONS).map((c) => ({ ...c, messages: c.messages.slice(-200) }));
  writeFileSync(`${file}.tmp`, JSON.stringify({ active: store.active, conversations }, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export const activeConversation = (s: ChatStore) => s.conversations.find((c) => c.id === s.active) ?? s.conversations[0];

/** The history, newest first. A conversation with nothing said yet is only listed while it is the open one. */
export function chatSummaries(s: ChatStore): ChatSummary[] {
  return s.conversations.filter((c) => c.messages.length || c.id === s.active)
    .map((c) => ({ id: c.id, title: c.title || "New conversation", updatedAt: c.updatedAt, count: c.messages.length, active: c.id === s.active }))
    .sort((a, b) => (b.updatedAt || "9").localeCompare(a.updatedAt || "9"));
}

/**
 * Saves an edit made from `version` (0 = new design); 409 if someone saved in between.
 * What Claude adds is marked pending for the user to accept, and never moves the user's layout.
 */
export function saveDesign(ws: Workspace, slug: string, raw: unknown, by: DesignAuthor): Design {
  const d = parseDesign(raw);
  const file = designFile(ws, slug);
  const prev = existsSync(file) ? readDesign(ws, slug) : null;
  if (d.version !== (prev?.version ?? 0)) {
    throw new DesignError(prev ? `"${slug}" was changed (now version ${prev.version}, yours ${d.version}). Reload it and apply the change again.` : `No design "${slug}".`, prev ? 409 : 404);
  }
  if (d.rfc !== (prev?.rfc ?? "")) d.rfcBy = by;
  if (by === "claude") {
    const nodes = new Map(prev?.nodes.map((n) => [n.id, n]));
    const edges = new Set(prev?.edges.map((e) => e.id));
    d.nodes = d.nodes.map((n) => {
      const old = nodes.get(n.id);
      return old ? { ...n, x: old.x, y: old.y, ...(old.pinned !== undefined ? { pinned: old.pinned } : {}), ...(old.keep ? { keep: true } : {}), ...(old.w ? { w: old.w, h: old.h } : {}) } : { ...n, author: "claude" as const, pending: n.change !== "existing" || undefined };
    });
    d.edges = d.edges.map((e) => (edges.has(e.id) ? e : { ...e, author: "claude" as const, pending: true }));
    const notes = new Set(prev?.notes.map((n) => n.id));
    d.notes = d.notes.map((n) => (notes.has(n.id) ? n : { ...n, author: "claude" as const }));
  }
  return writeDesign(ws, slug, d);
}

/** Deletes a design and its older per-design chat file for good: nothing goes to a trash. Refuses a symlink, and a name that is not a design. */
export function deleteDesign(ws: Workspace, slug: string): void {
  const file = designFile(ws, slug);
  if (!existsSync(file)) throw new DesignError(`No design "${slug}".`, 404);
  unlinkSync(file);
  const chat = chatFile(ws, slug);
  if (existsSync(chat) && !lstatSync(chat).isSymbolicLink()) unlinkSync(chat);
}

/** Deletes every conversation of a chat scope for good (the agent's history is `GLOBAL_CHAT`). */
export function clearChats(ws: Workspace, slug: string): void {
  const file = chatFile(ws, slug);
  if (existsSync(file) && !lstatSync(file).isSymbolicLink()) unlinkSync(file);
}

/** Adds a shared design file under a free name derived from its title. */
export function importDesign(ws: Workspace, raw: unknown): { slug: string; design: Design } {
  const d = parseDesign(raw);
  const base = d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "design";
  let slug = base;
  for (let i = 2; existsSync(designFile(ws, slug)); i++) slug = `${base}-${i}`;
  return { slug, design: writeDesign(ws, slug, { ...d, version: 0 }) };
}

// ---------- view + impact ----------

const proposedView = (n: DesignNode) => ({
  id: n.id, kind: n.kind, name: n.name, repo: n.repo, file: n.file ?? "", line: 0, transactional: !!n.transactional, inTx: false,
  issueCount: 0, maxSeverity: null, outCount: 0, inCount: 0, attrs: { proposed: true },
  // the box it is drawn in: its repo, like real nodes; outside things by kind
  group: n.repo || (n.kind === "External" ? "External services" : n.kind === "Queue" ? "Queues" : n.kind === "Table" ? "Database" : n.kind === "Box" ? "Sketch" : "Proposed"),
});

export function designView(q: Queries, slug: string, d = readDesign(q.e.ws, slug)): DesignView {
  const g = q.e.graph;
  const stale = d.nodes.filter((n) => n.change !== "new" && !g.nodes.has(n.id)).map((n) => n.id);
  const impact = designImpact(q, d);
  const nodes: DesignNodeView[] = d.nodes.filter((n) => !stale.includes(n.id)).map((n) => {
    const base = n.change === "new" ? proposedView(n) : q.view(g.nodes.get(n.id)!);
    const introduced = impact.introduced.filter((i) => i.nodeId === n.id);
    const issueCount = base.issueCount + introduced.length;
    const maxSeverity = base.maxSeverity === "error" || introduced.some((i) => i.severity === "error") ? "error" : issueCount ? "warn" : null;
    return { ...base, issueCount, maxSeverity, introduced: introduced.length, change: n.change, author: n.author, pending: n.pending, x: n.x, y: n.y, note: n.note, items: n.items, shape: n.shape, w: n.w, h: n.h, keep: n.keep };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges: DesignEdgeView[] = [];
  for (const n of nodes) {
    if (n.change === "new") continue;
    for (const e of g.outEdges(n.id)) {
      const sig = `${e.src}|${e.dst}|${e.kind}`;
      if (!e.dst || !ids.has(e.dst) || HIDDEN.includes(e.kind) || seen.has(sig)) continue;
      seen.add(sig);
      const removed = d.edges.find((x) => x.change === "removed" && `${x.src}|${x.dst}|${x.kind}` === sig);
      edges.push({ ...q.edgeView(e), ...(removed ? { designId: removed.id, change: "removed", pending: removed.pending } : {}) });
    }
  }
  d.edges.filter((e) => e.change === "new" && ids.has(e.src) && ids.has(e.dst)).forEach((e, i) => edges.push({
    id: -(i + 1), src: e.src, dst: e.dst, kind: e.kind, confidence: "exact", file: "", line: 0, attrs: {}, designId: e.id, change: "new", pending: e.pending,
  }));
  return { slug, design: d, nodes, edges, stale, impact };
}

/** Builds the design on a copy of the graph and runs the rules on it: issues it would add or remove, tables and code it touches. */
export function designImpact(q: Queries, d: Design): DesignImpact {
  const shape = JSON.stringify([d.nodes.map((n) => [n.id, n.change, n.kind, n.name, n.repo, n.transactional, n.guards]), d.edges.map((e) => [e.src, e.dst, e.kind, e.change])]);
  return q.cached(`design:${createHash("sha1").update(shape).digest("hex")}`, () => {
    const g = q.e.graph;
    const removed = new Set(d.nodes.filter((n) => n.change === "removed").map((n) => n.id));
    const added = new Map<string, GraphNode>(d.nodes.filter((n) => n.change === "new" && !isSketch(n)).map((n) => [n.id, {
      id: n.id, kind: n.kind, name: n.name, repo: n.repo, file: n.file ?? "", line: 0, endLine: 0, keys: [],
      attrs: { proposed: true, transactional: !!n.transactional, guards: n.guards ?? [], permissions: [] },
    }]));
    // what the design says about a node, on a copy (the loaded graph is shared)
    const patch = (id: string, attrs: Record<string, unknown>) => {
      const n = added.get(id) ?? g.nodes.get(id);
      if (n) added.set(id, { ...n, attrs: { ...n.attrs, ...attrs } });
    };
    for (const n of d.nodes) {
      if (n.change !== "changed") continue;
      patch(n.id, { ...(n.transactional !== undefined ? { transactional: n.transactional } : {}), ...(n.guards ? { guards: n.guards } : {}) });
    }
    const exists = (id: string) => added.has(id) || (g.nodes.has(id) && !removed.has(id));
    const edges = d.edges.filter((e) => e.change === "new" && exists(e.src) && exists(e.dst)).map((e) => ({
      src: e.src, dst: e.dst, dstKey: e.dst, kind: e.kind, repo: (added.get(e.src) ?? g.nodes.get(e.src))!.repo, file: "", line: 0, confidence: "exact" as const, attrs: {},
    }));
    // a new "handles" edge makes its target an API handler, so the auth / transaction rules check it
    for (const e of edges) if (e.kind === "handles") patch(e.dst, { handler: true, guards: (added.get(e.dst) ?? g.nodes.get(e.dst))!.attrs.guards ?? [] });
    const cut = new Set(d.edges.filter((e) => e.change === "removed").map((e) => `${e.src}|${e.dst}|${e.kind}`));
    const overlay = g.overlay({ nodes: [...added.values()], edges }, { nodes: removed, edge: (e) => cut.has(`${e.src}|${e.dst}|${e.kind}`) });

    const after = q.e.runRules(overlay).issues;
    const before = new Set(q.e.issues.map((i) => i.id));
    const next = new Set(after.map((i) => i.id));
    const touched = new Set([...d.nodes.filter((n) => n.kind === "Table").map((n) => n.id), ...edges.filter((e) => e.kind === "reads" || e.kind === "writes").map((e) => e.dst)]);
    return {
      introduced: after.filter((i) => !before.has(i.id)),
      resolved: q.e.issues.filter((i) => !next.has(i.id)),
      tables: q.tables().filter((t) => touched.has(t.id)),
      dependents: d.nodes.filter((n) => (n.change === "changed" || n.change === "removed") && g.nodes.has(n.id)).flatMap((n) => {
        const r = q.impact(n.id);
        const refs = [...r.screens, ...r.operations, ...r.jobs];
        return refs.length ? [{ id: n.id, name: n.name, refs }] : [];
      }),
    };
  });
}

// ---------- flow: the real code around the changes, found without choosing a start point ----------

/** The links a request follows on its way down: screens render components, they call APIs, handlers call services, services touch data. */
const DOWN: EdgeKind[] = ["renders", "calls", "requests", "handles", "triggers", "reads", "writes", "calls_external", "enqueues"];

/**
 * What the Flow and Full detail views draw. A design changes existing code; the entry points (screens, APIs, jobs) that reach that
 * code are where a flow begins, so the few that reach the most changes are the starting points.
 * Flow is the way from each of them down to each change: the steps in between, always connected. (The App map's summarised flows
 * leave out the functions in the middle, so they often do not contain the changed code at all.)
 * Full detail adds everything those entry points do, as in the App map. Code nothing calls (a job, a migration) starts from itself.
 */
export function designFlow(q: Queries, map: MapQueries, d: Design, mode: "compact" | "full", limit = 3): DesignFlow {
  const exists = (id: string) => q.e.graph.nodes.has(id);
  const changing = d.nodes.filter((n) => (n.change === "changed" || n.change === "removed") && exists(n.id)).map((n) => n.id);
  // a design that only adds things still touches existing code: what its new arrows attach to
  const attached = d.edges.filter((e) => e.change === "new").flatMap((e) => [e.src, e.dst]).filter(exists);
  const roots = [...new Set(changing.length ? changing : attached)];

  const reached = new Map<string, { ref: Ref; hits: number }>();
  for (const id of roots) {
    const r = q.impact(id);
    for (const ref of [...r.screens, ...r.operations, ...r.jobs]) {
      const x = reached.get(ref.id) ?? { ref, hits: 0 };
      x.hits++;
      reached.set(ref.id, x);
    }
  }
  const order: Partial<Record<NodeKind, number>> = { Route: 0, Operation: 1, Job: 2 };
  const entries = [...reached.values()]
    .sort((a, b) => b.hits - a.hits || (order[a.ref.kind] ?? 3) - (order[b.ref.kind] ?? 3) || a.ref.name.localeCompare(b.ref.name))
    .slice(0, limit).map((x) => x.ref);

  const g = q.e.graph;
  const nodes = new Map<string, NodeView>();
  const edges = new Map<string, EdgeView>();
  let truncated = false;
  const addNode = (id: string) => { const n = g.nodes.get(id); if (n && !nodes.has(id)) nodes.set(id, q.view(n)); };
  const starts = entries.length ? entries.map((e) => e.id) : roots.slice(0, limit);
  const ways = starts.map((start) => ({ start, parents: g.walk(start, (id) => g.outEdges(id, DOWN).filter((e) => e.dst), 24) }));   // shortest ways down from each
  const stepsTo = (parents: Map<string, Edge | null>, target: string) => { let n = 0; for (let e = parents.get(target); e; e = parents.get(e.src)) n++; return n; };
  const used = new Set<string>();
  for (const target of roots) {
    // each change gets one route down from an entry point (a screen if one gets there, else an API or job; the shortest): one clear path, not every way in
    const rank = (id: string) => order[g.nodes.get(id)?.kind as NodeKind] ?? 3;            // a screen, then an API, then a job
    const best = ways.filter((w) => w.parents.has(target)).sort((a, b) => rank(a.start) - rank(b.start) || stepsTo(a.parents, target) - stepsTo(b.parents, target))[0];
    if (!best) continue;
    used.add(best.start);
    addNode(best.start);
    addNode(target);
    for (let at = target, e = best.parents.get(at); e; at = e.src, e = best.parents.get(at)) {
      addNode(e.src);
      addNode(e.dst!);
      edges.set(edgeKey(e), q.edgeView(e));
    }
  }
  for (const start of starts) {
    if (mode === "full") {
      const f = map.flow(start, "full");
      f.nodes.forEach((n) => nodes.set(n.id, n));
      f.edges.forEach((e) => edges.set(edgeKey(e), e));
      truncated ||= !!f.truncated;
    }
  }
  let synthetic = 0;       // arrows a flow invents ("via …") are numbered per flow: renumber so merged flows never share an id
  const merged = [...edges.values()].map((e) => (e.id < 0 ? { ...e, id: -(++synthetic) } : e));
  const from = entries.filter((e) => used.has(e.id) || mode === "full");
  return { flow: { rootId: from[0]?.id ?? roots[0] ?? "", nodes: [...nodes.values()], edges: merged, ...(truncated ? { truncated } : {}) }, from: from.length ? from : entries, roots: roots.length };
}

const edgeKey = (e: { src: string; dst: string | null; kind: string }) => `${e.src}|${e.dst}|${e.kind}`;

// ---------- export ----------

const TAG: Record<NodeKind, string> = {
  Route: "screen", Component: "component", ClientCall: "client", Operation: "api", Schema: "schema", Function: "fn",
  Guard: "guard", Table: "table", External: "external", Job: "job", Queue: "queue", Box: "box",
};
const LAYER: [string, NodeKind[]][] = [
  ["UI", ["Route", "Component", "ClientCall"]], ["API", ["Operation", "Schema"]], ["Logic", ["Function", "Guard", "Job"]],
  ["Data", ["Table"]], ["External", ["External", "Queue"]],
];
const MARK = { new: "+ new", changed: "~ changed", removed: "− removed", existing: "  existing" } as const;
const where = (n: DesignNodeView) => (n.change === "new" ? (n.file ? ` — suggested \`${n.file}\`` : "") : n.file ? ` — \`${n.repo}/${n.file}:${n.line}\`` : "");
// why it matters is for reviewers; how to fix it (which names the tool's own comments) is for whoever builds it
const issueLines = (list: Issue[]) => list.map((i) => `- **${i.severity}** ${i.ruleTitle}: ${i.message}\n  - Why it matters: ${i.why}`).join("\n");

/** What the Changes view draws: the diagram in the RFC is the same picture. `folded` is how many unchanged nodes were left out. */
function diagramOf(v: DesignView) {
  const arrows: Arrow[] = v.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, change: e.change === "new" || e.change === "removed" ? e.change : undefined }));
  const { nodes, hidden } = trim(v.nodes, arrows, changesKeep(v.nodes, arrows));
  const shown = new Set(nodes.map((n) => n.id));
  return { nodes, edges: v.edges.filter((e) => shown.has(e.src) && shown.has(e.dst)), folded: new Set([...hidden.values()].flat()).size };
}

export function toMermaid(v: DesignView): string {
  const { nodes, edges } = diagramOf(v);
  const id = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const label = (s: string) => s.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\s+/g, " ");
  return [
    "flowchart LR",
    ...nodes.map((n) => `  ${id.get(n.id)}["${label(`[${TAG[n.kind]}] ${n.name}`)}"]${n.change === "existing" ? "" : `:::${n.change}`}`),
    ...edges.map((e) => `  ${id.get(e.src)} ${e.change === "removed" ? "-." : "--"} ${e.kind} ${e.change === "removed" ? ".->" : "-->"} ${id.get(e.dst)}`),
    "  classDef new stroke:#4f46e5,stroke-width:2px,stroke-dasharray:4 3",
    "  classDef changed stroke:#d97706,stroke-width:2px",
    "  classDef removed stroke:#dc2626,stroke-dasharray:2 2,opacity:0.6",
  ].join("\n");
}

// ---- the RFC document: people write the reasoning, FlowMap writes the facts ----

const STATUS = { draft: "Draft", review: "In review", approved: "Approved", rejected: "Rejected" } as const;
const CHANGE_WORD = { new: "New", changed: "Changing", removed: "Removing", existing: "" } as const;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** The sections of the RFC text a person wrote: what comes before the first "##", then each "## Title" with its body. */
function splitRfc(rfc: string): { intro: string; sections: { title: string; body: string }[] } {
  const sections: { title: string; body: string }[] = [];
  const intro: string[] = [];
  let fence = false;
  for (const line of rfc.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) sections.push({ title: h[1], body: "" });
    else if (sections.length) sections.at(-1)!.body += `${line}\n`;
    else if (!/^#\s/.test(line)) intro.push(line);      // a title line ("# …") is FlowMap's job too
  }
  return { intro: intro.join("\n").trim(), sections: sections.map((s) => ({ ...s, body: s.body.trim() })) };
}

/** The numbers a reviewer wants first, from the design: no one has to type them (or keep them up to date). */
function atAGlance(v: DesignView): string {
  const { impact, design: d } = v;
  const reached = new Map<string, Ref>();
  for (const x of impact.dependents) for (const r of x.refs) reached.set(r.id, r);
  const count = (kind: NodeKind, word: string) => {
    const n = [...reached.values()].filter((r) => r.kind === kind).length;
    return n ? `${n} ${word}${n === 1 ? "" : "s"}` : "";
  };
  const examples = [...reached.values()].slice(0, 3).map((r) => `\`${r.name}\``).join(", ");
  const rows: [string, string][] = [
    ["Changes", summarize(d.nodes) || "none yet"],
    ...(impact.tables.length ? [["Touches", impact.tables.slice(0, 6).map((t) => `\`${t.name}\``).join(", ") + (impact.tables.length > 6 ? ` +${impact.tables.length - 6}` : "")] as [string, string]] : []),
    ...(reached.size ? [["Reached from", `${[count("Route", "screen"), count("Operation", "API"), count("Job", "job")].filter(Boolean).join(" · ")}${examples ? ` (for example ${examples})` : ""}`] as [string, string]] : []),
    ["New issues", impact.introduced.length ? `${impact.introduced.length}: ${[...new Set(impact.introduced.map((i) => i.ruleTitle))].join(", ")}` : "None found"],
  ];
  return `| | |\n|---|---|\n${rows.map(([k, val]) => `| **${k}** | ${val} |`).join("\n")}`;
}

function whatChanges(v: DesignView): string {
  const numbers = numberChanges(v.nodes);
  const changed = v.nodes.filter((n) => n.change !== "existing" && !isSketch(n)).sort((a, b) => numbers.get(a.id)! - numbers.get(b.id)!);
  const repos = [...new Set(changed.map((n) => n.repo || "Shared"))];
  const blocks = repos.map((repo) => {
    const rows = changed.filter((n) => (n.repo || "Shared") === repo).map((n) => {
      const where = n.change === "new" ? (n.file ? `\`${n.file}\` (suggested)` : "") : n.file ? `\`${n.file}:${n.line}\`` : "";
      return `| ${numbers.get(n.id)} | ${CHANGE_WORD[n.change]} | \`${cell(n.name)}\` · ${TAG[n.kind]} | ${where} | ${cell(n.note ?? "")} |`;
    });
    return `${repos.length > 1 ? `### ${repo}\n` : ""}| # | Change | What | Where | Note |\n|---|---|---|---|---|\n${rows.join("\n")}`;
  });
  return blocks.length ? `## What changes\n${blocks.join("\n\n")}` : "";
}

/** Columns the design adds, per table. */
function dataChanges(d: Design): string {
  const rows = d.nodes.filter((n) => n.kind === "Table" && n.items?.length).map((n) =>
    `- \`${cell(n.name)}\` (${n.change === "new" ? "new table" : "changing"}): ${n.items!.map((i) => `${n.change === "new" ? "" : "+ "}\`${cell(i.text)}\``).join(", ")}`);
  return rows.length ? `## Data changes\n${rows.join("\n")}` : "";
}

/** The free boxes of the drawing, left to right as drawn: the steps of a flow that is not code. */
function steps(d: Design): string {
  const rows = d.nodes.filter(isSketch).sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0)).filter((n) => n.shape !== "text" || n.items?.length)
    .map((n) => `- **${cell(n.name)}**${n.items?.length ? `: ${n.items.map((i) => cell(i.text)).join("; ")}` : ""}`);
  return rows.length ? `## Steps in the diagram\n${rows.join("\n")}` : "";
}

function impactSection(v: DesignView, notes: string): string {
  const { introduced, resolved, tables, dependents } = v.impact;
  const lines = [
    introduced.length ? `**Would introduce ${introduced.length} issue${introduced.length === 1 ? "" : "s"}**\n${issueLines(introduced)}` : "**Would introduce:** no new issues found.",
    resolved.length ? `**Would resolve:** ${resolved.map((i) => i.ruleTitle).join(", ")}` : "",
    tables.length ? `**Tables touched**\n${tables.map((t) => `- \`${t.name}\`: ${t.readers.length} reader${t.readers.length === 1 ? "" : "s"}, ${t.writers.length} writer${t.writers.length === 1 ? "" : "s"}`).join("\n")}` : "",
    dependents.length ? `**What depends on the changed code**\n${dependents.map((x) => `- \`${x.name}\`: ${x.refs.slice(0, 6).map((r) => r.name).join(", ")}${x.refs.length > 6 ? ` +${x.refs.length - 6} more` : ""}`).join("\n")}` : "",
    notes,
  ].filter(Boolean);
  return `## Impact and risks\n${lines.join("\n\n")}`;
}

/**
 * The RFC as one document, in the order a reviewer reads it: the problem, the TL;DR, the numbers and the picture, then the reasoning.
 * The reasoning is what people (or Claude) wrote in the RFC text; the facts come from the design. A section the text already
 * has for those facts (decisions, impact, diagram) is not repeated, and a one-line pointer in its place is dropped.
 */
export function toMarkdown(v: DesignView): string {
  const d = v.design;
  const parsed = splitRfc(d.rfc);
  const intro = parsed.intro;
  // a section still holding the template's own placeholder text has not been written yet: leave it out
  const untouched = new Map(splitRfc(RFC_TEMPLATE + RFC_TEMPLATE_SHORT).sections.map((s) => [s.title.toLowerCase(), s.body]));
  const sections = parsed.sections.map((s) => (untouched.get(s.title.toLowerCase()) === s.body ? { ...s, body: "" } : s));
  const take = (re: RegExp) => { const i = sections.findIndex((s) => re.test(s.title)); return i < 0 ? undefined : sections.splice(i, 1)[0]; };
  const tldr = d.summary.trim() || take(/^(summary|tl;?dr)\b/i)?.body || "";
  for (const re of [/^(summary|tl;?dr)\b/i, /^decisions?\b/i, /^(diagram|what changes|changes|at a glance|verification)\b/i]) while (take(re));
  const human = (re: RegExp, title: string) => { const s = take(re); return s?.body ? `## ${title}\n${s.body}` : ""; };
  const problem = human(/^(problem|motivation|context|background)\b/i, "Problem");
  const goals = human(/goal/i, "Goals and non-goals");
  const proposal = human(/^(proposal|design|approach|solution|plan)\b/i, "Proposal");
  const alternatives = human(/alternative/i, "Alternatives considered");
  const risks = take(/^(impact|risks?)\b/i)?.body ?? "";
  const rollout = human(/rollout|deploy|release/i, "Rollout");
  const rest = sections.filter((s) => s.body).map((s) => `## ${s.title}\n${s.body}`);

  const { folded } = diagramOf(v);
  const date = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  const decisions = d.decisions.filter((x) => x.question.trim());
  return [
    `# ${d.title}`,
    `> **Status:** ${STATUS[d.status ?? "draft"]}${date ? ` · **Updated:** ${date}` : ""}`,
    problem,
    `## TL;DR\n${tldr || "_Add 2–3 lines: what changes, why, the impact, and what you need from reviewers._"}`,
    `## At a glance\n${atAGlance(v)}\n\n${DIAGRAM_MARKER}${folded ? `\n_Unchanged code the changes only touch in passing (${folded} node${folded === 1 ? "" : "s"}) is left out._` : ""}`,
    intro,
    goals, proposal,
    whatChanges(v), dataChanges(d), steps(d),
    decisions.length ? `## Decisions\n| Decision | Choice |\n|---|---|\n${decisions.map((x) => `| ${cell(x.question)} | ${cell(x.answer)} |`).join("\n")}` : "",
    alternatives,
    impactSection(v, risks.length > 120 ? risks : ""),
    rollout, ...rest,
  ].filter(Boolean).join("\n\n") + "\n";
}

// ---------- check: does the code match the design? ----------

export interface DesignCheck {
  planned: { name: string; kind: NodeKind | "edge"; change: string; status: "done" | "missing" | "unchanged" }[];
  unplanned: Ref[];
  issues: Issue[];
}

export function checkDesign(q: Queries, d: Design, base?: string): DesignCheck {
  const g = q.e.graph;
  const changes = q.changes(base);
  const changedIds = new Set(changes.changed.map((r) => r.id));
  const lower = (s: unknown) => String(s ?? "").toLowerCase();
  // a proposed node is built once the code has one of the same kind and name (tables: or entity) in the same repo
  const built = (n: DesignNode) => [...g.nodes.values()].find((x) => x.kind === n.kind && (!n.repo || x.repo === n.repo) &&
    (lower(x.name) === lower(n.name) || (x.kind === "Table" && lower(x.attrs.entity) === lower(n.name))));
  const real = new Map(d.nodes.map((n) => [n.id, n.change === "new" ? built(n)?.id : g.nodes.has(n.id) ? n.id : undefined]));
  const sketch = new Set(d.nodes.filter(isSketch).map((n) => n.id));      // a free box is not code: nothing to find in it
  const planned: DesignCheck["planned"] = d.nodes.filter((n) => n.change !== "existing" && !sketch.has(n.id)).map((n) => ({
    name: n.name, kind: n.kind, change: n.change,
    status: n.change === "new" ? (real.get(n.id) ? "done" : "missing") : n.change === "removed" ? (g.nodes.has(n.id) ? "missing" : "done") : changedIds.has(n.id) ? "done" : "unchanged",
  }));
  const name = (id: string) => d.nodes.find((n) => n.id === id)?.name ?? id;
  for (const e of d.edges.filter((x) => x.change === "new" && !sketch.has(x.src) && !sketch.has(x.dst))) {
    const [src, dst] = [real.get(e.src), real.get(e.dst)];
    // UI → API in code goes through components and client calls, so "connected" means reachable in a few hops
    const ok = !!src && !!dst && g.walk(src, (id) => g.outEdges(id).filter((x) => x.dst), 4).has(dst);
    planned.push({ name: `${name(e.src)} → ${name(e.dst)}`, kind: "edge", change: e.kind, status: ok ? "done" : "missing" });
  }
  const known = new Set([...real.values()].filter(Boolean));
  return {
    planned,
    unplanned: [...changes.changed, ...changes.affected.tables].filter((r) => BOUNDARY.includes(r.kind) && !known.has(r.id))
      .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i),
    issues: changes.issues,
  };
}

// ---------- context for Claude ----------

/** What Claude needs before proposing a design: the current flow, related code, tables, open issues and the repo's naming style. */
/** " · columns: id, email, …" for a table that lists them. */
const columnsOf = (n?: GraphNode) => {
  const cols = Array.isArray(n?.attrs.columns) ? (n!.attrs.columns as { name: string }[]).map((c) => c.name) : [];
  return cols.length ? ` · columns: ${cols.slice(0, 12).join(", ")}${cols.length > 12 ? ", …" : ""}` : "";
};

export function designContext(q: Queries, feature: string, anchor?: string): string {
  const g = q.e.graph;
  const out: string[] = [];
  const focus = new Set<string>();
  const root = anchor ? q.resolve(anchor) : null;
  if (anchor && !root) out.push(`(No node named "${anchor}"; continuing with the description only.)`);
  if (root) {
    const sg = q.subgraph(root.id, "down", 2, false, 60, 8);
    sg.nodes.forEach((n) => focus.add(n.id));
    const screens = q.impact(root.id).screens;
    out.push(`## Current flow from ${root.name} (id ${root.id})\n${formatTree(sg, "down")}`);
    if (screens.length) out.push(`Screens that reach it: ${screens.slice(0, 10).map((s) => s.name).join(", ")}`);
  }
  const words = [...new Set(feature.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].slice(0, 12);
  const hits = new Map(words.flatMap((w) => q.search(w, undefined, 5)).map((h) => [h.id, h]));
  if (hits.size) {
    const list = [...hits.values()];
    out.push(`## Related code (by name)\n${list.slice(0, 15).map((h) => `- [${TAG[h.kind]}] ${h.name}  id=${h.id}  ${h.repo}/${h.file}:${h.line}`).join("\n")}${list.length > 15 ? `\n(+${list.length - 15} more: use search)` : ""}`);
    // the graph says what is connected, not what the code does: these are the functions to read before proposing a change to them
    const read = list.filter((h) => h.kind === "Function" || h.kind === "Operation").slice(0, 5);
    if (read.length) out.push(`## Read these before you propose changes (validation, uniqueness checks, arguments)\n${read.map((h) => `- ${h.name}  ${h.repo}/${h.file}:${h.line}`).join("\n")}`);
    hits.forEach((_, id) => focus.add(id));
  }
  const tables = q.tables().filter((t) => focus.has(t.id) || [...t.readers, ...t.writers].some((r) => focus.has(r.id)));
  if (tables.length) out.push(`## Tables involved\n${tables.slice(0, 15).map((t) => `- ${t.name} (id ${t.id}): ${t.readers.length} reader(s), ${t.writers.length} writer(s)${columnsOf(g.nodes.get(t.id))}`).join("\n")}`);
  const issues = q.e.issues.filter((i) => focus.has(i.nodeId));
  if (issues.length) out.push(`## Open issues on this code\n${formatIssues(issues.slice(0, 15))}`);
  // naming style per repo, so proposed names match what the code already does (and `check --design` can find them later)
  const style = q.e.ws.config.repos.map((r) => {
    const sample = (k: NodeKind) => [...g.nodes.values()].filter((n) => n.kind === k && n.repo === r.name && n.file).slice(0, 4).map((n) => n.name);
    const lines = (["Route", "Operation", "Function", "Table", "Job"] as NodeKind[]).map((k) => [k, sample(k)] as const).filter(([, s]) => s.length);
    const guards = new Map<string, number>();
    for (const n of g.nodes.values()) if (n.repo === r.name && n.attrs.handler) for (const x of n.attrs.guards ?? []) guards.set(x, (guards.get(x) ?? 0) + 1);
    const top = [...guards].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([x]) => x);
    return lines.length ? `- ${r.name}: ${lines.map(([k, s]) => `${TAG[k]}: ${s.join(", ")}`).join(" · ")}${top.length ? ` · guards: ${top.join(", ")}` : ""}` : "";
  }).filter(Boolean);
  if (style.length) out.push(`## Naming in this codebase (use the same style for proposed names)\n${style.join("\n")}`);
  const designs = listDesigns(q.e.ws);
  if (designs.length) out.push(`## Existing designs\n${designs.map((x) => `- ${x.slug}: ${x.title}`).join("\n")}`);
  return out.join("\n\n") || "Nothing related found. Ask the user which screen or API the feature starts from.";
}

// ---------- a diagram drawn on request: boxes and arrows, not a change to the code ----------

export interface DiagramInput {
  title: string;
  summary?: string;
  steps: { key: string; title: string; points?: string[]; code?: string; shape?: "box" | "decision" | "text" }[];
  arrows: { from: string; to: string }[];
}

/**
 * A simplified or custom picture as a design: every step is a free box (a title, then points that explain it), so the checks and the
 * RFC's change table ignore it. A step may name the real code it stands for; its file and line become the last point, to find it.
 */
export function buildDiagram(q: Queries, input: DiagramInput): Design {
  const keys = new Set(input.steps.map((s) => s.key));
  if (keys.size !== input.steps.length) throw new Error("Each step needs its own key.");
  for (const a of input.arrows) if (!keys.has(a.from) || !keys.has(a.to)) throw new Error(`The arrow ${a.from} → ${a.to} names a step that is not in steps.`);
  return {
    version: 0, title: input.title, summary: input.summary ?? "", rfc: "", decisions: [], notes: [], updatedAt: "",
    nodes: input.steps.map((s) => {
      const node = s.code ? q.resolve(s.code) : null;
      const points = [...(s.points ?? []), ...(node?.file ? [`${node.repo}/${node.file}:${node.line}`] : [])];
      return { id: `new:${s.key}`, change: "new" as const, kind: "Box" as const, name: s.title, repo: "", author: "claude" as const, ...(s.shape ? { shape: s.shape } : {}), ...(points.length ? { items: points.map((text) => ({ text: text.slice(0, 300) })) } : {}) };
    }),
    edges: input.arrows.map((a, i) => ({ id: `e${i + 1}`, src: `new:${a.from}`, dst: `new:${a.to}`, kind: "calls" as const, change: "new" as const, author: "claude" as const })),
  };
}

/** Saves a drawn diagram as a new design (never over an existing one, which may hold your edits) and returns its name. */
export function saveDiagram(q: Queries, input: DiagramInput): string {
  const base = `diagram-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 44).replace(/-+$/, "") || "flow"}`;
  let slug = base;
  for (let i = 2; existsSync(designFile(q.e.ws, slug)); i++) slug = `${base}-${i}`;
  saveDesign(q.e.ws, slug, buildDiagram(q, input), "user");
  return slug;
}

export const designUsage = `Design JSON: { version, title, status?, summary (the TL;DR, 2–3 lines), rfc (Markdown: only Problem, Goals and non-goals, Proposal, Alternatives considered, Risks and impact, Rollout), decisions: [{question, answer}], nodes, edges, notes }.
- FlowMap writes the TL;DR numbers, diagram, What changes table, Decisions table and impact itself when the RFC is exported: do not write those sections, and give each changed or new node a one-line "note".
- Real node: { id: <graph id>, change: "existing" | "changed" | "removed", kind, name, repo }
- Proposed node: { id: "new:<lowercase-key>", change: "new", kind, name, repo, file?: suggested path, transactional?, guards?: [..], note? }
- Points inside any node: items: [{ text }]. On a Table, items: [{ text: "ai_job_id uuid", new: true }] are the columns this design adds (a real table's current columns are in the graph).
- Free element, not code (a step, a decision, a text): { id: "new:<key>", change: "new", kind: "Box", name, shape?: "box" | "decision" | "text", items? }. It is left out of checks and the What changes table. To tie it to code, replace it by the real node (same arrows, move its items over).
- Edge (only proposed ones): { id, src, dst, kind: calls|renders|requests|handles|reads|writes|calls_external|enqueues|triggers|navigates, change: "new" | "removed" }
- Model an API as Operation --handles--> Function so the auth / transaction checks apply; a screen as Route --renders--> Component --requests--> Operation.`;

