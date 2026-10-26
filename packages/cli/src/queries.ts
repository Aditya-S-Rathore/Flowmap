import { execFileSync } from "node:child_process";
import type {
  ChangeSet, EdgeKind, EdgeView, ExplainCard, GraphNode, Issue, IssueSummary, NodeKind, NodeView, Overview, PathStep,
  Ref, RuleInfo, SearchHit, Status, Subgraph, TableInfo, Edge,
} from "@flowmap/core";
import { gitRoot } from "@flowmap/core";
import { effectiveAuth, rules } from "@flowmap/rules";
import type { Engine } from "./engine.ts";

const DOWN_EXCLUDE: EdgeKind[] = ["guarded_by", "decorated_by", "relates"];
const UP_KINDS: EdgeKind[] = ["calls", "renders", "requests", "handles", "triggers", "reads", "writes", "calls_external", "enqueues", "defines"];
const FLOW_UP: EdgeKind[] = ["calls", "renders", "requests", "handles", "triggers"];
const FLOW_DOWN: EdgeKind[] = ["calls", "renders", "requests", "handles", "triggers"];
const SIDE_EFFECT: EdgeKind[] = ["writes", "calls_external", "enqueues"];
const KIND_RANK: NodeKind[] = ["Operation", "Route", "Component", "ClientCall", "Function", "Table", "External", "Job", "Queue", "Guard", "Schema"];

export class Queries {
  e: Engine;
  constructor(engine: Engine) {
    this.e = engine;
  }

  private get g() {
    return this.e.graph;
  }

  private memo = new WeakMap<object, Map<string, unknown>>();

  /** Per-graph cache: recomputed after each re-index. */
  cached<T>(key: string, fn: () => T): T {
    let m = this.memo.get(this.g);
    if (!m) {
      m = new Map();
      this.memo.set(this.g, m);
    }
    if (!m.has(key)) m.set(key, fn());
    return m.get(key) as T;
  }

  /** The box a node is drawn in: its repo, or repo/package in a monorepo; outside things by kind. */
  groupOf(n: GraphNode): string {
    if (!n.repo) return n.kind === "External" ? "External services" : n.kind === "Table" ? "Database" : n.kind === "Queue" ? "Queues" : "Other";
    const roots = this.cached(`roots:${n.repo}`, () => (JSON.parse(this.e.store.getMeta(`roots:${n.repo}`) ?? "[]") as string[]).filter(Boolean));
    const root = roots.find((r) => n.file.startsWith(r + "/"));
    return root ? `${n.repo}/${root.split("/").pop()}` : n.repo;
  }

  // ---------- views ----------

  view(n: GraphNode): NodeView {
    const issues = this.e.issues.filter((i) => i.nodeId === n.id);
    return {
      id: n.id, kind: n.kind, name: n.name, repo: n.repo, file: n.file, line: n.line,
      transactional: !!n.attrs.transactional,
      inTx: this.g.txFns.has(n.id),
      issueCount: issues.length,
      maxSeverity: issues.some((i) => i.severity === "error") ? "error" : issues.length ? "warn" : null,
      outCount: new Set(this.g.outEdges(n.id).filter((x) => x.dst && !DOWN_EXCLUDE.includes(x.kind)).map((x) => `${x.dst}|${x.kind}`)).size,
      inCount: new Set(this.g.inEdges(n.id, UP_KINDS).map((x) => `${x.src}|${x.kind}`)).size,
      group: this.groupOf(n),
      attrs: n.attrs,
    };
  }

  edgeView(x: Edge): EdgeView {
    return {
      id: x.id, src: x.src, dst: x.dst!, kind: x.kind, confidence: x.confidence ?? "exact", file: x.file, line: x.line,
      attrs: {
        ...(x.attrs.inLoop ? { inLoop: true } : {}),
        ...(x.attrs.inTx || this.g.isTxRoot(this.g.nodes.get(x.src)) || this.g.txFns.has(x.src) ? (x.attrs.afterCommit ? {} : { inTx: true }) : {}),
        ...(x.attrs.afterCommit ? { afterCommit: true } : {}),
        ...(x.attrs.write !== undefined ? { write: x.attrs.write } : {}),
        ...(x.attrs.method ? { method: x.attrs.method } : {}),
        ...(x.attrs.label ? { label: x.attrs.label } : {}),
      },
    };
  }

  ref(id: string, detail?: string): Ref {
    const n = this.g.nodes.get(id)!;
    return { id, kind: n.kind, name: n.name, repo: n.repo, file: n.file, line: n.line, ...(detail ? { detail } : {}) };
  }

  // ---------- lookup ----------

  search(q: string, kinds?: NodeKind[], limit = 20): SearchHit[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const scored: [number, GraphNode][] = [];
    for (const n of this.g.nodes.values()) {
      if (kinds?.length && !kinds.includes(n.kind)) continue;
      const name = n.name.toLowerCase();
      const short = name.split(/[.\s/]/).pop() ?? name;
      let score = name === needle || short === needle ? 0 : short.startsWith(needle) ? 1 : name.startsWith(needle) ? 2 : name.includes(needle) ? 3 : n.file.toLowerCase().includes(needle) ? 5 : -1;
      if (score < 0) continue;
      score = score * 20 + KIND_RANK.indexOf(n.kind);
      scored.push([score, n]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length).slice(0, limit)
      .map(([, n]) => ({ id: n.id, kind: n.kind, name: n.name, repo: n.repo, file: n.file, line: n.line }));
  }

  /** Accepts a node id or a name ("setNickname", "UserService.remove", "/settings/billing"). */
  resolve(nameOrId: string): GraphNode | null {
    if (this.g.nodes.has(nameOrId)) return this.g.nodes.get(nameOrId)!;
    const hit = this.search(nameOrId, undefined, 1)[0];
    return hit ? this.g.nodes.get(hit.id)! : null;
  }

  // ---------- graph ----------

  /** Lower = more important: side effects and problem paths first, plain helpers last. */
  private edgeRank(x: Edge, dir: "down" | "up"): number {
    if (dir === "up") return x.kind === "handles" || x.kind === "requests" ? 0 : x.kind === "renders" ? 1 : 2;
    if (x.kind === "writes" || x.kind === "calls_external" || x.kind === "enqueues") return 0;
    if (x.kind === "handles" || x.kind === "requests") return 1;
    const target = x.dst ? this.g.nodes.get(x.dst) : undefined;
    const hasIssue = this.e.issues.some((i) => i.nodeId === x.dst);
    const effects = x.dst ? this.g.outEdges(x.dst).some((o) => o.kind === "writes" || o.kind === "calls_external" || o.kind === "enqueues") : false;
    if (hasIssue || effects || target?.attrs.transactional) return 2;
    if (x.kind === "reads") return 3;
    return x.kind === "renders" ? 4 : 5;
  }

  subgraph(id: string, dir: "down" | "up" = "down", depth = 2, sideEffects = false, maxNodes = 150, perNode = 40): Subgraph {
    const root = this.g.nodes.get(id);
    if (!root) throw new Error(`Unknown node ${id}`);
    const next = (nid: string) => dir === "down"
      ? this.g.outEdges(nid).filter((x) => x.dst && (!DOWN_EXCLUDE.includes(x.kind) || (x.kind === "relates" && nid === id)))
      : this.g.inEdges(nid, UP_KINDS);
    const nodes = new Set([id]);
    const edges = new Map<number, Edge>();
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length && nodes.size < maxNodes; d++) {
      const nf: string[] = [];
      for (const nid of frontier) {
        const seenEdge = new Set<string>();
        const ranked = next(nid).map((x) => [this.edgeRank(x, dir), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
        for (const x of ranked) {
          const sig = `${x.src}|${x.dst}|${x.kind}`;
          if (seenEdge.has(sig) || seenEdge.size >= perNode) continue;   // one edge per target, most important first
          seenEdge.add(sig);
          const other = dir === "down" ? x.dst! : x.src;
          edges.set(x.id, x);
          if (!nodes.has(other) && nodes.size < maxNodes) {
            nodes.add(other);
            nf.push(other);
          }
        }
      }
      frontier = nf;
    }
    let keep = nodes;
    if (sideEffects && dir === "down") {
      // keep only nodes on a path to a write / external call / enqueue
      const memo = new Map<string, boolean>();
      const has = (nid: string, seen: Set<string>): boolean => {
        if (memo.has(nid)) return memo.get(nid)!;
        if (seen.has(nid)) return false;
        seen.add(nid);
        const n = this.g.nodes.get(nid);
        const own = n?.kind === "Table" || n?.kind === "External" || n?.kind === "Queue";
        const res = own || [...edges.values()].some((x) => x.src === nid && (SIDE_EFFECT.includes(x.kind) || ((x.kind !== "reads") && x.dst !== nid && has(x.dst!, seen))));
        memo.set(nid, res);
        return res;
      };
      keep = new Set([...nodes].filter((nid) => nid === id || has(nid, new Set())));
      for (const n of nodes) {
        const node = this.g.nodes.get(n);
        if (node?.kind === "Table" && ![...edges.values()].some((x) => x.dst === n && x.kind === "writes")) keep.delete(n);
      }
    }
    return {
      rootId: id,
      nodes: [...keep].map((nid) => this.view(this.g.nodes.get(nid)!)),
      edges: [...edges.values()].filter((x) => keep.has(x.src) && keep.has(x.dst!)).map((x) => this.edgeView(x)),
    };
  }

  /** Upstream walk to UI entry points; returns screens (routes, else top components). */
  private upstream(id: string, maxDepth = 14) {
    return this.g.walk(id, (nid) => this.g.inEdges(nid, FLOW_UP), maxDepth);
  }

  private downstream(id: string, maxDepth = 10) {
    return this.g.walk(id, (nid) => this.g.outEdges(nid, FLOW_DOWN).filter((x) => x.dst), maxDepth);
  }

  explain(id: string): ExplainCard {
    const g = this.g;
    const n = g.nodes.get(id);
    if (!n) throw new Error(`Unknown node ${id}`);
    const up = this.upstream(id);
    const down = this.downstream(id);
    const ups = [...up.keys()].map((x) => g.nodes.get(x)!).filter(Boolean);
    let screens = ups.filter((x) => x.kind === "Route");
    if (!screens.length) screens = ups.filter((x) => x.kind === "Component" && !g.inEdges(x.id, ["renders"]).length);

    const handler = n.attrs.handler ? n : n.kind === "Operation" ? g.nodes.get(g.outEdges(id, ["handles"])[0]?.dst ?? "") : undefined;
    const ops = n.kind === "Operation" ? [n] : [...ups, ...[...down.keys()].map((x) => g.nodes.get(x)!)].filter((x) => x?.kind === "Operation");
    const auth = handler ? effectiveAuth(g, handler) : { guards: [], permissions: [] };

    const tables = (kind: "reads" | "writes") => {
      const out = new Map<string, Ref>();
      for (const fid of down.keys()) for (const x of g.outEdges(fid, [kind])) if (x.dst && !out.has(x.dst)) out.set(x.dst, this.ref(x.dst, g.nodes.get(fid)!.name));
      return [...out.values()];
    };
    const externals = new Map<string, Ref & { write: boolean; inTx: boolean }>();
    for (const fid of down.keys()) {
      for (const x of g.outEdges(fid, ["calls_external", "enqueues"])) {
        if (!x.dst) continue;
        const inTx = !x.attrs.afterCommit && (x.attrs.inTx || g.isTxRoot(g.nodes.get(fid)) || g.txFns.has(fid));
        const key = `${x.dst}|${x.attrs.method ?? ""}`;
        const prev = externals.get(key);
        if (!prev || (inTx && !prev.inTx)) externals.set(key, { ...this.ref(x.dst, `${x.attrs.method ?? ""}${fid !== id ? ` · in ${g.nodes.get(fid)!.name}` : ""}`), write: x.kind === "enqueues" || !!x.attrs.write, inTx: !!inTx });
      }
    }
    const txRoots = g.txFns.has(id) ? [...up.keys()].filter((x) => g.isTxRoot(g.nodes.get(x))).map((x) => this.ref(x)) : [];
    const schemaEdge = n.kind === "Operation" ? g.inEdges(id, ["defines"])[0] : undefined;
    const schemaNode = schemaEdge ? g.nodes.get(schemaEdge.src) : undefined;
    const related = new Set([id, handler?.id].filter(Boolean));

    return {
      node: this.view(n),
      screens: screens.slice(0, 20).map((x) => this.ref(x.id)),
      operations: dedupe(ops).slice(0, 20).map((x) => this.ref(x.id)),
      callers: g.inEdges(id, FLOW_UP).slice(0, 30).map((x) => this.ref(x.src, x.kind)),
      callees: g.outEdges(id, FLOW_DOWN).filter((x) => x.dst).slice(0, 30).map((x) => this.ref(x.dst!, x.kind)),
      guards: [...new Set(auth.guards)],
      permissions: [...new Set(auth.permissions)],
      hasActor: handler ? !!handler.attrs.hasActor : null,
      input: handler?.attrs.input ?? [],
      flags: [...new Set(screens.map((x) => x.attrs.flag).filter(Boolean))],
      reads: tables("reads"),
      writes: tables("writes"),
      externals: [...externals.values()],
      transaction: { opens: !!n.attrs.transactional, inTx: g.txFns.has(id), roots: txRoots },
      issues: this.e.issues.filter((i) => related.has(i.nodeId) || down.has(i.nodeId) || i.path.some((p) => p.id === id)).slice(0, 50),
      schema: schemaNode ? { args: schemaNode.attrs.args, returns: schemaNode.attrs.returns } : null,
    };
  }

  /** Paths from UI routes down to the target (for "is X reachable from the app?"). */
  reachable(id: string, limit = 10): { reachable: boolean; paths: PathStep[][] } {
    const parents = this.upstream(id, 20);
    const routes = [...parents.keys()].filter((x) => this.g.nodes.get(x)?.kind === "Route");
    const paths = routes.slice(0, limit).map((r) => this.g.pathTo(parents, r).reverse().map((pid) => this.step(pid)));
    return { reachable: routes.length > 0, paths };
  }

  impact(id: string) {
    const parents = this.upstream(id, 20);
    const by = (k: NodeKind) => [...parents.keys()].filter((x) => x !== id && this.g.nodes.get(x)?.kind === k).map((x) => this.ref(x));
    return { operations: by("Operation"), screens: by("Route"), components: by("Component"), clientCalls: by("ClientCall"), functions: by("Function").slice(0, 50), jobs: by("Job") };
  }

  step(id: string): PathStep {
    const n = this.g.nodes.get(id)!;
    return { id, kind: n.kind, name: n.name, repo: n.repo, file: n.file, line: n.line };
  }

  tables(): TableInfo[] {
    return [...this.g.nodes.values()].filter((n) => n.kind === "Table" && n.file).map((t) => ({
      id: t.id, name: t.name, entity: t.attrs.entity ?? null, repo: t.repo, file: t.file, line: t.line,
      readers: dedupe(this.g.inEdges(t.id, ["reads"]).map((x) => this.g.nodes.get(x.src)!)).map((x) => this.ref(x.id)),
      writers: dedupe(this.g.inEdges(t.id, ["writes"]).map((x) => this.g.nodes.get(x.src)!)).map((x) => this.ref(x.id)),
      relations: (t.attrs.relations ?? []).map((r: any) => ({ to: r.to, column: r.column, indexed: r.indexed })),
      issues: this.e.issues.filter((i) => i.nodeId === t.id),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- issues ----------

  issues(f: { rule?: string; severity?: string; status?: string; repo?: string; q?: string; files?: Set<string> } = {}): Issue[] {
    const q = f.q?.toLowerCase();
    return this.e.issues.filter((i) =>
      (!f.rule || i.rule === f.rule) && (!f.severity || i.severity === f.severity) && (!f.status || i.status === f.status) &&
      (!f.repo || i.repo === f.repo) && (!f.files || f.files.has(`${i.repo}:${i.file}`)) &&
      (!q || `${i.message} ${i.file} ${i.nodeName}`.toLowerCase().includes(q)));
  }

  summary(list = this.e.issues): IssueSummary {
    const byRule = rules.map((r) => {
      const of = list.filter((i) => i.rule === r.id);
      return { rule: r.id, title: r.title, severity: r.severity, count: of.length, new: of.filter((i) => i.status === "new").length };
    }).filter((r) => r.count);
    return {
      total: list.length,
      new: list.filter((i) => i.status === "new").length,
      baseline: list.filter((i) => i.status === "baseline").length,
      suppressed: this.e.suppressed,
      bySeverity: { error: list.filter((i) => i.severity === "error").length, warn: list.filter((i) => i.severity === "warn").length },
      byRule: byRule.sort((a, b) => b.count - a.count),
    };
  }

  rules(): RuleInfo[] {
    return rules.map((r) => {
      const of = this.e.issues.filter((i) => i.rule === r.id);
      return {
        id: r.id, title: r.title, description: r.description, why: r.why, fix: r.fix,
        severity: this.e.ws.config.rules[r.id] ?? r.severity, count: of.length, new: of.filter((i) => i.status === "new").length,
      };
    });
  }

  // ---------- status ----------

  status(indexing = false): Status {
    const byKind: Partial<Record<NodeKind, number>> = {};
    for (const n of this.g.nodes.values()) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    return {
      workspace: this.e.ws.config.name,
      workspaceDir: this.e.ws.dir,
      repos: this.e.ws.config.repos.map((r) => ({ name: r.name, path: r.path, branch: branch(r.path), files: this.e.store.files(r.name).size, plugins: r.plugins })),
      counts: { nodes: this.g.nodes.size, edges: this.g.edges.length, byKind, unresolved: this.g.edges.filter((x) => !x.dst && !x.attrs.optional).length },
      indexedAt: this.e.store.getMeta("indexedAt"),
      indexing,
      lastDurationMs: Number(this.e.store.getMeta("lastDurationMs")) || null,
    };
  }

  overview(indexing = false): Overview {
    const files = new Map<string, { repo: string; file: string; issues: number; errors: number }>();
    for (const i of this.e.issues) {
      const k = `${i.repo}:${i.file}`;
      const f = files.get(k) ?? { repo: i.repo, file: i.file, issues: 0, errors: 0 };
      f.issues++;
      if (i.severity === "error") f.errors++;
      files.set(k, f);
    }
    return {
      status: this.status(indexing),
      issues: this.summary(),
      hotspots: [...files.values()].sort((a, b) => b.errors - a.errors || b.issues - a.issues).slice(0, 10),
      largestFunctions: [...this.g.nodes.values()].filter((n) => n.attrs.loc && (n.kind === "Function" || n.kind === "Component"))
        .sort((a, b) => b.attrs.loc - a.attrs.loc).slice(0, 10)
        .map((n) => ({ id: n.id, name: n.name, repo: n.repo, file: n.file, line: n.line, loc: n.attrs.loc })),
    };
  }

  // ---------- changes ----------

  /** What the current branch (plus uncommitted work) touches compared with `base`. */
  changes(base?: string): ChangeSet {
    const changedLines = new Map<string, Set<number> | "all">();   // "repo:file" -> lines
    const repos = this.e.ws.config.repos.map((r) => {
      const ref = base ?? r.base ?? defaultBase(r.path);
      try {
        const files = gitChanges(r.path, ref);
        for (const [file, lines] of files) changedLines.set(`${r.name}:${file}`, lines);
        return { name: r.name, branch: branch(r.path), base: ref, files: [...files.keys()] };
      } catch (err: any) {
        return { name: r.name, branch: branch(r.path), base: ref, files: [], error: String(err.message ?? err).split("\n")[0] };
      }
    });
    const changed = [...this.g.nodes.values()].filter((n) => {
      const lines = changedLines.get(`${n.repo}:${n.file}`);
      if (!lines || !n.file) return false;
      if (lines === "all") return true;
      for (let l = n.line; l <= n.endLine; l++) if (lines.has(l)) return true;
      return false;
    });

    const affected = { operations: new Map<string, Ref>(), screens: new Map<string, Ref>(), tables: new Map<string, Ref>(), externals: new Map<string, Ref>() };
    for (const n of changed) {
      for (const id of this.upstream(n.id).keys()) {
        const k = this.g.nodes.get(id)!.kind;
        if (k === "Operation") affected.operations.set(id, this.ref(id));
        if (k === "Route") affected.screens.set(id, this.ref(id));
      }
      for (const id of this.downstream(n.id, 4).keys()) {
        for (const x of this.g.outEdges(id, ["writes", "reads", "calls_external"])) {
          if (!x.dst) continue;
          (x.kind === "calls_external" ? affected.externals : affected.tables).set(x.dst, this.ref(x.dst, x.kind));
        }
      }
    }
    const changedIds = new Set(changed.map((n) => n.id));
    return {
      base: base ?? repos[0]?.base ?? "",
      repos,
      changed: changed.slice(0, 200).map((n) => this.ref(n.id)),
      affected: {
        operations: [...affected.operations.values()],
        screens: [...affected.screens.values()],
        tables: [...affected.tables.values()],
        externals: [...affected.externals.values()],
      },
      issues: this.e.issues.filter((i) => {
        if (i.status !== "new") return false;
        if (changedIds.has(i.nodeId) || !i.file) return true;      // not tied to a file (a removed API): always in scope
        const lines = changedLines.get(`${i.repo}:${i.file}`);
        return lines === "all" || !!lines?.has(i.line);
      }),
    };
  }
}

function dedupe<T extends { id: string }>(list: T[]): T[] {
  return [...new Map(list.filter(Boolean).map((x) => [x.id, x])).values()];
}

function git(dir: string, args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

export function branch(dir: string): string | null {
  try {
    return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function defaultBase(dir: string) {
  try {
    return git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
  } catch {
    return "main";
  }
}

/** Changed files → changed new-side line numbers, for committed (base...HEAD), staged, unstaged and untracked work. */
export function gitChanges(dir: string, base: string): Map<string, Set<number> | "all"> {
  if (!gitRoot(dir)) throw new Error("not a git repository");
  const out = new Map<string, Set<number> | "all">();
  const mergeBase = git(dir, ["merge-base", base, "HEAD"]).trim();
  const diff = git(dir, ["diff", "-U0", "--no-color", "--relative", mergeBase]);
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : null;
      if (file && !out.has(file)) out.set(file, new Set());
    } else if (file && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const set = out.get(file) as Set<number>;
      for (let l = start; l < start + Math.max(count, 1); l++) set.add(l);
    }
  }
  for (const f of git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) out.set(f, "all");
  return out;
}
