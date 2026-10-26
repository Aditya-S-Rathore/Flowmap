import type { WireNode, Wireframe, AppMap, Architecture, ChangeSet, Counts, EdgeView, ExplainCard, Issue, IssueSummary, NodeView, Overview, Ref, SearchHit, ServerEvent, Status, Subgraph, Suggestion, TableInfo } from "../types";
import { changedFiles, edges, issues, nodes, repos, rules } from "./data";

const byId = new Map(nodes.map((n) => [n.id, n]));
const SIDE_EFFECTS = new Set<EdgeView["kind"]>(["writes", "calls_external", "enqueues"]);
let indexedAt = new Date().toISOString();

const ref = (n: NodeView, detail?: string): Ref => ({ id: n.id, kind: n.kind, name: n.name, repo: n.repo, file: n.file, line: n.line, ...(detail ? { detail } : {}) });
const out = (id: string) => edges.filter((e) => e.src === id);
const inc = (id: string) => edges.filter((e) => e.dst === id);

/** All nodes reachable from id (excluding id) following edges in one direction. */
function reach(id: string, dir: "down" | "up"): NodeView[] {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of dir === "down" ? out(cur) : inc(cur)) {
      const next = dir === "down" ? e.dst : e.src;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  seen.delete(id);
  return [...seen].map((i) => byId.get(i)!);
}

function status(): Status {
  const byKind: Status["counts"]["byKind"] = {};
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  return {
    workspace: "acme", workspaceDir: "/Users/dev/acme", repos,
    counts: { nodes: nodes.length, edges: edges.length, byKind, unresolved: 3 },
    indexedAt, indexing: false, lastDurationMs: 340,
  };
}

function summary(list: Issue[]): IssueSummary {
  const byRule = rules.flatMap((r) => {
    const of = list.filter((i) => i.rule === r.id);
    return of.length ? [{ rule: r.id, title: r.title, severity: of[0].severity, count: of.length, new: of.filter((i) => i.status === "new").length }] : [];
  });
  return {
    total: list.length,
    new: list.filter((i) => i.status === "new").length,
    baseline: list.filter((i) => i.status === "baseline").length,
    suppressed: 2,
    bySeverity: { error: list.filter((i) => i.severity === "error").length, warn: list.filter((i) => i.severity === "warn").length },
    byRule: byRule.sort((a, b) => b.count - a.count),
  };
}

function overview(): Overview {
  const files = new Map<string, Overview["hotspots"][number]>();
  for (const i of issues) {
    const key = `${i.repo}:${i.file}`;
    const h = files.get(key) ?? { repo: i.repo, file: i.file, issues: 0, errors: 0 };
    h.issues++;
    if (i.severity === "error") h.errors++;
    files.set(key, h);
  }
  return {
    status: status(),
    issues: summary(issues),
    hotspots: [...files.values()].sort((a, b) => b.errors - a.errors || b.issues - a.issues).slice(0, 8),
    largestFunctions: nodes.filter((n) => n.kind === "Function")
      .map((n) => ({ id: n.id, name: n.name, repo: n.repo, file: n.file, line: n.line, loc: n.attrs.loc as number }))
      .sort((a, b) => b.loc - a.loc).slice(0, 6),
  };
}

function search(p: URLSearchParams): SearchHit[] {
  const q = (p.get("q") ?? "").toLowerCase();
  const kinds = p.get("kind")?.split(",").filter(Boolean);
  return nodes
    .filter((n) => n.name.toLowerCase().includes(q) && (!kinds?.length || kinds.includes(n.kind)))
    .slice(0, Number(p.get("limit") ?? 20))
    .map(({ id, kind, name, repo, file, line }) => ({ id, kind, name, repo, file, line }));
}

function graph(id: string, p: URLSearchParams): Subgraph {
  const down = p.get("dir") !== "up";
  const depth = Number(p.get("depth") ?? 2);
  const seen = new Set([id]);
  const picked = new Map<number, EdgeView>();
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of down ? out(cur) : inc(cur)) {
        picked.set(e.id, e);
        const other = down ? e.dst : e.src;
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  let list = [...picked.values()];
  if (p.get("sideEffects") === "1") {
    // Keep only edges on a path to a side effect (write / external / enqueue).
    const hasEffect = (n: string) => [n, ...reach(n, "down").map((r) => r.id)].some((x) => out(x).some((e) => SIDE_EFFECTS.has(e.kind)));
    list = list.filter((e) => SIDE_EFFECTS.has(e.kind) || (["calls", "handles", "requests", "renders", "triggers"].includes(e.kind) && hasEffect(e.dst)));
  }
  const ids = new Set([id, ...list.flatMap((e) => [e.src, e.dst])]);
  return { rootId: id, nodes: [...ids].map((i) => byId.get(i)!), edges: list };
}

function explain(id: string): ExplainCard {
  const node = byId.get(id);
  if (!node) throw new Error(`Unknown node ${id}`);
  const up = reach(id, "up");
  const down = reach(id, "down").filter((n) => n.kind !== "Guard" && n.kind !== "Schema");
  const ops = node.kind === "Operation" ? [node] : up.filter((n) => n.kind === "Operation");
  const handler = ops[0];
  const scope = [id, ...down.map((n) => n.id)];
  const effects = edges.filter((e) => scope.includes(e.src));
  const txRoots = up.filter((n) => n.transactional);
  return {
    node,
    screens: up.filter((n) => n.kind === "Route" || n.kind === "Component").map((n) => ref(n)),
    operations: (node.kind === "Operation" ? down.filter((n) => n.kind === "Operation") : ops).map((n) => ref(n)),
    callers: inc(id).filter((e) => e.kind !== "guarded_by").map((e) => ref(byId.get(e.src)!, e.kind)),
    callees: out(id).filter((e) => e.kind !== "guarded_by").map((e) => ref(byId.get(e.dst)!, e.attrs.method ?? e.kind)),
    guards: [...new Set(ops.flatMap((o) => out(o.id).filter((e) => e.kind === "guarded_by").map((e) => byId.get(e.dst)!.name)))],
    permissions: (handler?.attrs.permissions as string[] | undefined) ?? [],
    hasActor: handler ? (handler.attrs.hasActor as boolean | null) : null,
    input: (node.attrs.input as ExplainCard["input"] | undefined) ?? [],
    flags: [node.transactional && "transactional", node.inTx && "runs in transaction"].filter((f): f is string => !!f),
    reads: [...new Set(effects.filter((e) => e.kind === "reads").map((e) => e.dst))].map((t) => ref(byId.get(t)!)),
    writes: [...new Set(effects.filter((e) => e.kind === "writes").map((e) => e.dst))].map((t) => ref(byId.get(t)!)),
    externals: effects.filter((e) => e.kind === "calls_external").map((e) => ({
      ...ref(byId.get(e.dst)!, e.attrs.method), write: !!e.attrs.write, inTx: !!e.attrs.inTx,
    })),
    transaction: { opens: node.transactional, inTx: node.inTx, roots: txRoots.map((n) => ref(n)) },
    issues: issues.filter((i) => i.path.some((s) => s.id === id)),
    schema: (node.attrs.schema as ExplainCard["schema"] | undefined) ?? null,
  };
}

function filterIssues(p: URLSearchParams) {
  const q = (p.get("q") ?? "").toLowerCase();
  const list = issues.filter((i) =>
    (!p.get("rule") || i.rule === p.get("rule")) &&
    (!p.get("severity") || i.severity === p.get("severity")) &&
    (!p.get("status") || i.status === p.get("status")) &&
    (!p.get("repo") || i.repo === p.get("repo")) &&
    (!q || `${i.message} ${i.file} ${i.nodeName} ${i.ruleTitle}`.toLowerCase().includes(q)));
  return { issues: list, summary: summary(list) };
}

function tables(): TableInfo[] {
  return nodes.filter((n) => n.kind === "Table").map((t) => ({
    id: t.id, name: t.name, entity: (t.attrs.entity as string) ?? null, repo: t.repo, file: t.file, line: t.line,
    readers: inc(t.id).filter((e) => e.kind === "reads").map((e) => ref(byId.get(e.src)!)),
    writers: inc(t.id).filter((e) => e.kind === "writes").map((e) => ref(byId.get(e.src)!)),
    relations: (t.attrs.relations as TableInfo["relations"]) ?? [],
    issues: issues.filter((i) => i.nodeId === t.id),
  }));
}

function changes(base: string): ChangeSet {
  const empty = base === "HEAD";
  const files = (repo: string) => (empty ? [] : changedFiles[repo] ?? []);
  const changed = empty ? [] : nodes.filter((n) => (changedFiles[n.repo] ?? []).includes(n.file) && n.kind !== "Table");
  const affected = new Map<string, NodeView>();
  for (const n of changed) for (const a of [...reach(n.id, "up"), ...reach(n.id, "down"), n]) affected.set(a.id, a);
  const of = (k: NodeView["kind"][]) => [...affected.values()].filter((n) => k.includes(n.kind)).map((n) => ref(n));
  return {
    base,
    repos: repos.map((r) => ({ name: r.name, branch: r.branch, base, files: files(r.name) })),
    changed: changed.map((n) => ref(n)),
    affected: { operations: of(["Operation"]), screens: of(["Route"]), tables: of(["Table"]), externals: of(["External"]) },
    issues: issues.filter((i) => i.status === "new" && changed.some((n) => n.file === i.file && n.repo === i.repo)),
  };
}

function counts(ids: Set<string>): Counts {
  const of = (k: EdgeView["kind"]) => new Set(edges.filter((e) => ids.has(e.src) && e.kind === k).map((e) => e.dst)).size;
  const list = issues.filter((i) => ids.has(i.nodeId) || i.path.some((p) => ids.has(p.id)));
  return {
    apis: [...ids].filter((id) => byId.get(id)?.kind === "Operation").length,
    reads: of("reads"), writes: of("writes"), externals: of("calls_external"),
    issues: list.length, maxSeverity: list.some((i) => i.severity === "error") ? "error" : list.length ? "warn" : null,
  };
}

const downIds = (id: string) => new Set([id, ...reach(id, "down").map((n) => n.id)]);

function appMap(): AppMap {
  const screens = nodes.filter((n) => n.kind === "Route").map((r) => ({
    id: r.id, name: r.name, repo: r.repo, group: r.group, file: r.file, line: r.line,
    component: out(r.id).filter((e) => e.kind === "renders").map((e) => ref(byId.get(e.dst)!))[0] ?? null,
    auth: r.attrs.auth ? true : null, flag: (r.attrs.flag as string) ?? null,
    linksIn: 1, linksOut: [], unlinked: false, shot: null, apiIds: [...downIds(r.id)].filter((id) => byId.get(id)?.kind === "Operation"), ...counts(downIds(r.id)),
  }));
  const apis = nodes.filter((n) => n.kind === "Operation").map((o) => {
    const h = out(o.id).find((e) => e.kind === "handles");
    return {
      id: o.id, name: o.name, repo: o.repo, group: o.group, file: o.file, line: o.line, protocol: "graphql",
      handler: h ? ref(byId.get(h.dst)!) : null, guards: ["JwtAuthGuard"], guarded: true,
      screens: screens.filter((s) => downIds(s.id).has(o.id)).length, ...counts(downIds(o.id)),
    };
  });
  const jobs = nodes.filter((n) => (n.kind === "Job" || n.kind === "Queue") && n.file).map((j) => ({
    id: j.id, kind: j.kind, name: j.name, repo: j.repo, group: j.group, file: j.file, line: j.line,
    handler: out(j.id).filter((e) => e.kind === "triggers").map((e) => ref(byId.get(e.dst)!))[0] ?? null, ...counts(downIds(j.id)),
  }));
  return { groups: [...new Set(nodes.filter((n) => n.repo).map((n) => n.group))], hasNavigation: true, screens, apis, jobs };
}

/** Mock sketch: components as boxes, client calls as buttons that call their API. */
function wireframe(id: string): Wireframe {
  const at = (n: NodeView) => ({ repo: n.repo, file: n.file, line: n.line });
  const build = (n: NodeView, depth: number): WireNode => {
    const kids = out(n.id).map((e) => byId.get(e.dst)!).filter(Boolean);
    const children: WireNode[] = [{ kind: "heading", label: n.name.replace(/([a-z])([A-Z])/g, "$1 $2"), ...at(n) }];
    for (const k of kids) {
      if (k.kind === "Component" && depth < 4) children.push(build(k, depth + 1));
      if (k.kind === "ClientCall") {
        const op = out(k.id).find((e) => e.kind === "requests");
        children.push({ kind: "button", label: k.name.replace(/Action$/, "").replace(/([a-z])([A-Z])/g, "$1 $2"), apis: op ? [ref(byId.get(op.dst)!)] : undefined, ...at(k) });
      }
    }
    return { kind: "component", component: ref(n), label: n.name, children: [{ kind: "col", children, ...at(n) }], ...at(n) };
  };
  const page = out(id).find((e) => e.kind === "renders");
  return { screen: ref(byId.get(id)!), root: page ? build(byId.get(page.dst)!, 1) : null, shots: [], capturable: false };
}

function flow(id: string): Subgraph {
  const ids = downIds(id);
  return { rootId: id, nodes: nodes.filter((n) => ids.has(n.id)), edges: edges.filter((e) => ids.has(e.src) && ids.has(e.dst)) };
}

function architecture(): Architecture {
  const svc = (n: NodeView) => (n.repo ? `svc:${n.group}` : n.id);
  const archNodes = new Map<string, Architecture["nodes"][number]>();
  for (const n of nodes) {
    const id = svc(n);
    if (!n.repo && n.kind !== "External") continue;
    const a = archNodes.get(id) ?? { id, label: n.repo ? n.group : n.name, kind: n.repo ? "service" as const : "external" as const, screens: 0, apis: 0, tables: 0, jobs: 0, issues: 0 };
    if (n.kind === "Route") a.screens++;
    if (n.kind === "Operation") a.apis++;
    if (n.kind === "Table") a.tables++;
    if (n.kind === "Job") a.jobs++;
    archNodes.set(id, a);
  }
  const links = new Map<string, Architecture["links"][number]>();
  for (const e of edges.filter((x) => x.kind === "requests" || x.kind === "calls_external")) {
    const s = byId.get(e.src)!, d = byId.get(e.dst)!;
    const k = `${svc(s)}|${svc(d)}|${e.kind}`;
    const l = links.get(k) ?? { src: svc(s), dst: svc(d), kind: e.kind as "requests", count: 0, samples: [] as Ref[] };
    l.count++;
    if (l.samples.length < 3) l.samples.push(ref(s));
    links.set(k, l);
  }
  return { nodes: [...archNodes.values()], links: [...links.values()].filter((l) => l.src !== l.dst) };
}

const suggestions: Suggestion[] = [
  { kind: "external", repo: "backend", title: "Is HubspotClient (@hubspot/api-client) an outside service?", detail: "backend calls HubspotClient 14 time(s), but FlowMap doesn't treat it as an outside service.", config: 'externals: { "HubspotClient": "Hubspot" },' },
];

export async function mockGet(url: string): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
  const { pathname, searchParams: p } = new URL(url, location.origin);
  const [, , route, ...rest] = pathname.split("/");
  const id = decodeURIComponent(rest.join("/"));
  switch (route) {
    case "status": return status();
    case "overview": return overview();
    case "search": return search(p);
    case "graph": return graph(id, p);
    case "explain": return explain(id);
    case "issues": return filterIssues(p);
    case "rules": return rules.map((r) => {
      const of = issues.filter((i) => i.rule === r.id);
      return { ...r, count: of.length, new: of.filter((i) => i.status === "new").length };
    });
    case "tables": return tables();
    case "map": return appMap();
    case "flow": return flow(id);
    case "wireframe": return wireframe(id);
    case "architecture": return architecture();
    case "suggestions": return suggestions;
    case "changes": return changes(p.get("base") || "origin/main");
  }
  throw new Error(`Mock: no handler for ${pathname}`);
}

/** Simulates the server's live re-index events every 45 s. */
export function mockEvents(onEvent: (e: ServerEvent) => void): () => void {
  const timer = setInterval(() => {
    onEvent({ type: "indexing", phase: "parse" });
    setTimeout(() => {
      indexedAt = new Date().toISOString();
      onEvent({ type: "updated", files: 12, durationMs: 340 });
    }, 800);
  }, 45_000);
  return () => clearInterval(timer);
}
