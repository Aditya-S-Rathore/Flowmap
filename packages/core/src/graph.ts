import type { Store } from "./store.ts";
import type { EdgeKind, FlowMapPlugin, GraphEdge, GraphNode } from "./types.ts";
import type { IndexFact } from "./indexes.ts";

export interface Edge extends GraphEdge {
  id: number;
  dst: string | null;
}

/** Whole graph in memory for traversals (rules, queries). Rebuilt after each index. */
export class Graph {
  nodes = new Map<string, GraphNode>();
  out = new Map<string, Edge[]>();
  in = new Map<string, Edge[]>();
  edges: Edge[] = [];
  fileMeta = new Map<string, any>();     // "repo\0path" -> per-file facts
  txFns = new Set<string>();              // functions that run inside a transaction opened upstream

  static load(store: Store, plugins: FlowMapPlugin[] = []): Graph {
    const g = new Graph();
    for (const r of store.db.prepare("SELECT * FROM nodes").all() as any[]) {
      g.nodes.set(r.id, { id: r.id, kind: r.kind, name: r.name, repo: r.repo, file: r.file, line: r.line, endLine: r.end_line, attrs: JSON.parse(r.attrs), keys: [] });
    }
    for (const r of store.db.prepare("SELECT * FROM edges").all() as any[]) {
      const e: Edge = { id: r.id, src: r.src, dst: r.dst, dstKey: r.dst_key, resolvedKey: r.resolved_key, kind: r.kind, repo: r.repo, file: r.file, line: r.line, confidence: r.confidence, attrs: JSON.parse(r.attrs) };
      g.edges.push(e);
      push(g.out, e.src, e);
      if (e.dst) push(g.in, e.dst, e);
    }
    for (const f of store.allFileMeta()) g.fileMeta.set(`${f.repo}\0${f.path}`, f.meta);
    g.applyHandlerInfo();
    g.applyIndexes();
    for (const p of plugins) p.derive?.(g);
    g.computeTx();
    return g;
  }

  /** Edges added after load (derived links); negative ids so they never clash with stored ones. */
  addEdge(e: Omit<Edge, "id">) {
    const edge = { ...e, id: -(this.edges.length + 1) } as Edge;
    this.edges.push(edge);
    push(this.out, edge.src, edge);
    if (edge.dst) push(this.in, edge.dst, edge);
    return edge;
  }

  /**
   * Route registrations (app.get("/x", auth, handler)) record guards on the API node; the handler may live in another file.
   * Merge them, plus what the handler itself does with the request, into the handler's attrs so rules see one picture.
   */
  private applyHandlerInfo() {
    for (const op of this.nodes.values()) {
      const info = op.attrs.handlerInfo;
      if (op.kind !== "Operation" || !info) continue;
      for (const e of this.outEdges(op.id, ["handles"])) {
        const h = e.dst ? this.nodes.get(e.dst) : undefined;
        if (!h) continue;
        const http = h.attrs.http ?? {};
        const validated = !!(info.validated || http.validates);
        h.attrs.handler = true;
        h.attrs.guards = [...new Set([...(h.attrs.guards ?? []), ...(info.guards ?? []), ...(http.authCalls ?? [])])];
        h.attrs.permissions ??= [];
        h.attrs.hasActor = !!(h.attrs.hasActor || info.hasActor || http.actor);
        h.attrs.idArgs ??= [...new Set([...(info.idArgs ?? []), ...(http.ids ?? [])])];
        h.attrs.inlineArgs ??= http.readsBody && !validated ? ["request body"] : [];
        h.attrs.input ??= http.readsBody ? [{ name: "body", type: "request body", validated }] : [];
      }
    }
  }

  /**
   * Relation columns covered by an index from a migration or SQL file (models only know their own @Index / @@index).
   * Files are read in path order (migrations are named by date), so a later DROP INDEX cancels an earlier CREATE.
   * Only an index whose first column is the relation column helps lookups by it. `indexed: null` = can't tell.
   */
  private applyIndexes() {
    const live = new Map<string, IndexFact>();
    for (const [file, m] of [...this.fileMeta].filter(([, m]) => m.indexes).sort(([a], [b]) => a.localeCompare(b))) {
      for (const [i, f] of (m.indexes as IndexFact[]).entries()) {
        // a name built at runtime ("${INDEX_NAME}") only means the same index within its own file
        const key = !f.name ? `${file}#${i}` : f.name.includes("${") ? `${file}:${f.name}` : f.name.toLowerCase();
        if (f.drop) live.delete(key);
        else live.set(key, f);
      }
    }
    const key = (s: string) => s.toLowerCase().replace(/_/g, "");      // meeting_id = meetingId (naming strategies)
    const covered = new Set<string>(), dynamic = new Set<string>();
    for (const f of live.values()) {
      if (!f.columns[0]) continue;
      if (f.table) covered.add(`${key(f.table)}\0${key(f.columns[0])}`);
      else dynamic.add(key(f.columns[0]));
    }
    for (const t of this.nodes.values()) {
      if (t.kind !== "Table") continue;
      for (const r of t.attrs.relations ?? []) {
        if (r.indexed === false) r.indexed = covered.has(`${key(t.name)}\0${key(r.column)}`) || (dynamic.has(key(r.column)) ? null : false);
      }
    }
  }

  outEdges(id: string, kinds?: EdgeKind[]): Edge[] {
    const list = this.out.get(id) ?? [];
    return kinds ? list.filter((e) => kinds.includes(e.kind)) : list;
  }

  inEdges(id: string, kinds?: EdgeKind[]): Edge[] {
    const list = this.in.get(id) ?? [];
    return kinds ? list.filter((e) => kinds.includes(e.kind)) : list;
  }

  isTxRoot(n: GraphNode | undefined) {
    return !!n?.attrs.transactional;
  }

  /** Edges of `id` that execute while a transaction is open (because the fn opened one, runs inside one, or sits in a tx callback). */
  txEdges(id: string): Edge[] {
    const inTx = this.isTxRoot(this.nodes.get(id)) || this.txFns.has(id);
    return this.outEdges(id).filter((e) => !e.attrs.afterCommit && (inTx || e.attrs.inTx));
  }

  private computeTx() {
    const queue: string[] = [];
    for (const n of this.nodes.values()) if (n.attrs.transactional || this.outEdges(n.id).some((e) => e.attrs.inTx)) queue.push(n.id);
    while (queue.length) {
      const id = queue.pop()!;
      for (const e of this.txEdges(id)) {
        if (e.kind !== "calls" || !e.dst || this.txFns.has(e.dst)) continue;
        this.txFns.add(e.dst);
        queue.push(e.dst);
      }
    }
  }

  /** Breadth-first walk following `next` edges; returns parent pointers for path reconstruction. */
  walk(start: string, next: (id: string) => Edge[], maxDepth = 8): Map<string, Edge | null> {
    const parents = new Map<string, Edge | null>([[start, null]]);
    let frontier = [start];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const nextFrontier: string[] = [];
      for (const id of frontier) {
        for (const e of next(id)) {
          const to = e.src === id ? e.dst : e.src;
          if (!to || parents.has(to)) continue;
          parents.set(to, e);
          nextFrontier.push(to);
        }
      }
      frontier = nextFrontier;
    }
    return parents;
  }

  pathTo(parents: Map<string, Edge | null>, id: string): string[] {
    const path = [id];
    for (let e = parents.get(id); e; e = parents.get(path[0])) path.unshift(e.src === path[0] ? e.dst! : e.src);
    return path;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}
