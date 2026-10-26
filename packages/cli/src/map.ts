import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectDeps, normRoute, uiKindOf, type AppMap, type ApiInfo, type Architecture, type ArchLink, type ArchNode, type Counts, type Edge, type EdgeKind, type EdgeView, type GraphNode, type Issue, type JobInfo, type Ref, type ScreenInfo, type ShotInfo, type ShotSpot, type ShotSpots, type Subgraph, type Suggestion, type UiKind, type WireNode, type Wireframe } from "@flowmap/core";
import { builtinPlugins } from "@flowmap/plugins";
import { effectiveAuth } from "@flowmap/rules";
import type { Queries } from "./queries.ts";
import { readShots, type Variant } from "./shots.ts";

const I18N_KEY = /^[\w-]+([.:][\w-]+)+$/;

/** i18n keys read better as words: "profileSetting.header.buyCredits" → "Buy credits" */
const humanize = (label: string) => /^[\w-]+(\.[\w-]+)+$/.test(label)
  ? label.split(".").pop()!.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^\w/, (c) => c.toUpperCase()).replace(/ (\w)/g, (_, c: string) => ` ${c.toLowerCase()}`)
  : label;

interface UiEl { k: UiKind; t?: string; c?: UiEl[]; tag?: string; line: number; act?: { r?: [number, number, number, number][]; fn?: string; submit?: 1 }; rep?: 1; opt?: 1; cols?: number }

const DOWN: EdgeKind[] = ["calls", "renders", "requests", "handles", "triggers", "enqueues"];
const EFFECTS: EdgeKind[] = ["requests", "writes", "calls_external", "enqueues", "reads"];
const EFFECT_RANK: Partial<Record<EdgeKind, number>> = { writes: 0, calls_external: 0, enqueues: 1, requests: 1, reads: 2 };
// packages that usually wrap a network service (vendor names), and client-like class names from packages
const SERVICE_PKG = /aws|amazon|stripe|twilio|sendgrid|mailgun|postmark|resend|nodemailer|slack|firebase|supabase|algolia|segment|mixpanel|amplitude|pusher|ably|openai|anthropic|cohere|cloudinary|kafka|rabbit|amqp|nats|elastic|braintree|paypal|plaid|auth0|clerk|okta|hubspot|salesforce|intercom|zendesk|google|azure|minio|unleash|launchdarkly|growthbook|onesignal|expo-server-sdk|vonage|mailchimp|contentful|sanity|shopify|github|octokit|notion|linear|discord|telegram|zoom|dropbox|box-node|redis|ioredis|bull|meilisearch|typesense|pinecone|qdrant|weaviate|replicate|huggingface|mistral|groq|deepgram|assemblyai|elevenlabs|livekit|agora|daily|mux|vimeo|youtube/i;
const NOT_SERVICE = /^(@nestjs|@apollo|graphql|typeorm|rxjs|class|lodash|date-fns|dayjs|moment|react|vue|svelte|@angular|zod|yup|joi|uuid|crypto|path|fs|util|events|stream|express|fastify|hono|koa|winston|pino|@prisma|prisma|drizzle|sequelize|mongoose|os|sys|json|re|logging|datetime|typing|collections|itertools|functools|asyncio|dataclasses|enum|pathlib|subprocess|time|math|random|uuid|hashlib|base64|decimal|django|fastapi|flask|pydantic|sqlalchemy|celery|starlette)($|[/-])/;

/** Screens, APIs and jobs; condensed screen/API flows; the service map; setup suggestions. */
export class MapQueries {
  q: Queries;
  constructor(q: Queries) {
    this.q = q;
  }

  private get g() {
    return this.q.e.graph;
  }

  private issuesByNode(): Map<string, Issue[]> {
    return this.q.cached("issuesByNode", () => {
      const m = new Map<string, Issue[]>();
      for (const i of this.q.e.issues) {
        const list = m.get(i.nodeId) ?? [];
        list.push(i);
        m.set(i.nodeId, list);
      }
      return m;
    });
  }

  /** Everything a node leads to: UI → APIs → services → queues → consumers. */
  private down(id: string): Set<string> {
    return new Set(this.g.walk(id, (nid) => this.g.outEdges(nid, DOWN).filter((e) => e.dst), 16).keys());
  }

  private counts(ids: Set<string>): Counts {
    const reads = new Set<string>(), writes = new Set<string>(), externals = new Set<string>();
    let apis = 0, issues = 0;
    let maxSeverity: Counts["maxSeverity"] = null;
    const byNode = this.issuesByNode();
    for (const id of ids) {
      if (this.g.nodes.get(id)?.kind === "Operation") apis++;
      for (const e of this.g.outEdges(id)) {
        if (!e.dst) continue;
        if (e.kind === "reads") reads.add(e.dst);
        else if (e.kind === "writes") writes.add(e.dst);
        else if (e.kind === "calls_external") externals.add(e.dst);
      }
      for (const i of byNode.get(id) ?? []) {
        issues++;
        if (i.severity === "error" || !maxSeverity) maxSeverity = i.severity;
      }
    }
    return { apis, reads: reads.size, writes: writes.size, externals: externals.size, issues, maxSeverity };
  }

  /** Screenshot status is read fresh each time: `flowmap screenshots` runs in another process. */
  appMap(): AppMap {
    const map = this.mapCore();
    const shots = readShots(this.q.e.ws);
    return { ...map, screens: map.screens.map((s) => ({ ...s, shot: shots[s.id]?.desktop?.ok ? shots[s.id]!.desktop!.at : null })) };
  }

  private mapCore(): AppMap {
    return this.q.cached("appMap", () => {
      const g = this.g;
      const nodes = [...g.nodes.values()];
      const opScreens = new Map<string, number>();

      const routes = nodes.filter((n) => n.kind === "Route");
      const downOf = new Map(routes.map((r) => [r.id, this.down(r.id)]));
      const screensOf = new Map<string, Set<string>>();       // node → screens it belongs to
      for (const [rid, down] of downOf) for (const id of down) (screensOf.get(id) ?? screensOf.set(id, new Set()).get(id)!).add(rid);

      const screens: ScreenInfo[] = routes.map((r) => {
        const down = downOf.get(r.id)!;
        for (const id of down) if (g.nodes.get(id)?.kind === "Operation") opScreens.set(id, (opScreens.get(id) ?? 0) + 1);
        // a link counts unless it only comes from this screen's own components
        const linksIn = new Set(g.inEdges(r.id, ["navigates"]).map((e) => e.src).filter((s) => [...(screensOf.get(s) ?? [])].some((x) => x !== r.id) || !screensOf.has(s))).size;
        const linksOut = new Map<string, ReturnType<Queries["ref"]>>();
        for (const id of down) for (const e of g.outEdges(id, ["navigates"])) if (e.dst && e.dst !== r.id && !linksOut.has(e.dst)) linksOut.set(e.dst, this.q.ref(e.dst));
        const comp = g.outEdges(r.id, ["renders"]).find((e) => e.dst);
        return {
          id: r.id, name: r.name, repo: r.repo, group: this.q.groupOf(r), file: r.file, line: r.line,
          component: comp ? this.q.ref(comp.dst!) : null,
          auth: r.attrs.auth ? true : null,
          flag: r.attrs.flag ? String(r.attrs.flag) : null,
          linksIn, linksOut: [...linksOut.values()].slice(0, 30),
          apiIds: [...down].filter((id) => g.nodes.get(id)?.kind === "Operation"),
          shot: null,
          unlinked: this.q.e.issues.some((i) => i.rule === "unreachable-screen" && i.nodeId === r.id),
          ...this.counts(down),
        };
      }).sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));

      const globalGuard = new Set([...g.fileMeta.entries()].filter(([, m]) => m.globalGuard).map(([k]) => k.split("\0")[0]));
      const apis: ApiInfo[] = nodes.filter((n) => n.kind === "Operation").map((op) => {
        const h = g.outEdges(op.id, ["handles"]).map((e) => e.dst && g.nodes.get(e.dst)).find(Boolean) || undefined;
        const guards = h ? [...new Set(effectiveAuth(g, h).guards)] : [];
        return {
          id: op.id, name: op.name, repo: op.repo, group: this.q.groupOf(op), file: op.file, line: op.line,
          protocol: String(op.attrs.protocol ?? "rest"),
          handler: h ? this.q.ref(h.id) : null,
          guards, guarded: guards.length > 0 || globalGuard.has(op.repo),
          screens: opScreens.get(op.id) ?? 0,
          ...this.counts(this.down(op.id)),
        };
      }).sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));

      const jobs: JobInfo[] = nodes.filter((n) => (n.kind === "Job" || n.kind === "Queue") && n.file).map((j) => {
        const h = g.outEdges(j.id, ["triggers"]).find((e) => e.dst);
        return {
          id: j.id, kind: j.kind, name: j.name, repo: j.repo, group: this.q.groupOf(j), file: j.file, line: j.line,
          handler: h ? this.q.ref(h.dst!) : null, ...this.counts(this.down(j.id)),
        };
      }).sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));

      const groups = [...new Set([...screens, ...apis, ...jobs].map((x) => x.group))].sort();
      return { groups, hasNavigation: g.edges.some((e) => e.kind === "navigates"), screens, apis, jobs };
    });
  }

  /**
   * A readable flow for a screen, API, job or handler: the parts of the screen that call APIs, each API's handler,
   * the service functions with side effects (plain helpers in between are collapsed into "via ..."), and what they touch.
   * Crosses into other services through REST/GraphQL requests and queues.
   */
  flow(rootId: string, mode: "compact" | "full" = "full"): Subgraph {
    const g = this.g;
    const root = g.nodes.get(rootId);
    if (!root) throw new Error(`Unknown node ${rootId}`);
    const compact = mode === "compact";
    const nodes = new Set<string>([rootId]);
    const edges = new Map<string, EdgeView>();
    let synth = 0;
    let truncated = false;

    const real = (e: Edge) => {
      nodes.add(e.src);
      nodes.add(e.dst!);
      const k = `${e.src}|${e.dst}|${e.kind}`;
      if (!edges.has(k)) edges.set(k, this.q.edgeView(e));
    };
    const via = (src: string, dst: string, kind: EdgeKind, path: string[]) => {
      if (src === dst) return;
      nodes.add(src);
      nodes.add(dst);
      const k = `${src}|${dst}|${kind}`;
      if (edges.has(k)) return;
      const mids = path.slice(1, -1).map((id) => g.nodes.get(id)?.name ?? id);
      edges.set(k, {
        id: -(++synth), src, dst, kind, confidence: "exact", file: "", line: 0,
        attrs: mids.length ? { label: mids.length === 1 ? `via ${mids[0]}` : `via ${mids.length} calls` } : {},
      });
    };
    const doneApi = new Set<string>(), doneFn = new Set<string>();
    const summaries = new Map<string, string>();

    const effects = (from: string, depth: number) => {
      const list = g.outEdges(from, EFFECTS).filter((e) => e.dst);
      const unique = [...new Map(list.map((e) => [`${e.dst}|${e.kind}`, e])).values()].sort((a, b) => (EFFECT_RANK[a.kind] ?? 3) - (EFFECT_RANK[b.kind] ?? 3));
      if (unique.length > 8) truncated = true;
      for (const e of unique.slice(0, 8)) {
        real(e);
        if (e.kind === "requests") (compact ? summary : api)(e.dst!, depth + 1);
        if (e.kind === "enqueues" && !compact) for (const t of g.outEdges(e.dst!, ["triggers"])) if (t.dst) { real(t); handler(t.dst, depth + 1); }
      }
    };
    // compact: an API points straight at what it changes (tables, outside services, queues, other services), helpers collapsed
    const summary = (op: string, depth: number) => {
      if (doneApi.has(op)) return;
      if (depth > 3) { truncated = true; return; }
      doneApi.add(op);
      nodes.add(op);
      const h = g.outEdges(op, ["handles"]).find((e) => e.dst)?.dst;
      if (!h) return;
      const repo = g.nodes.get(h)?.repo;
      const parents = g.walk(h, (id) => g.outEdges(id, ["calls"]).filter((e) => e.dst && g.nodes.get(e.dst)?.repo === repo), 8);
      const best = new Map<string, EdgeView>();
      const written = new Set<string>(), read = new Set<string>();
      for (const id of parents.keys()) {
        for (const e of g.outEdges(id, ["writes", "reads", "calls_external", "enqueues", "requests"])) {
          if (!e.dst) continue;
          // tables are summarized on the API card; its own page draws them
          if (e.kind === "writes" || e.kind === "reads") { (e.kind === "writes" ? written : read).add(e.dst); continue; }
          const view = this.q.edgeView(e);
          const k = `${e.dst}|${e.kind}`;
          const prev = best.get(k);
          if (!prev || (view.attrs.inTx && !prev.attrs.inTx) || (view.attrs.write && !prev.attrs.write)) best.set(k, view);
        }
      }
      summaries.set(op, [written.size && `writes ${written.size} table${written.size > 1 ? "s" : ""}`, read.size && `reads ${read.size}`].filter(Boolean).join(" · ") || "no table access");
      for (const view of best.values()) {
        nodes.add(view.dst);
        // no labels here: a screen overview stays quiet; the API's own page shows methods and where they're called
        edges.set(`${op}|${view.dst}|${view.kind}`, { ...view, id: -(++synth), src: op, attrs: { ...view.attrs, method: undefined, label: undefined } });
        if (view.kind === "requests") summary(view.dst, depth + 1);
      }
    };
    const handler = (h: string, depth: number) => {
      if (doneFn.has(h)) return;
      doneFn.add(h);
      const repo = g.nodes.get(h)?.repo;
      const parents = g.walk(h, (id) => g.outEdges(id, ["calls"]).filter((e) => e.dst && g.nodes.get(e.dst)?.repo === repo), 8);
      const rank = (id: string) => Math.min(...g.outEdges(id, EFFECTS).filter((e) => e.dst).map((e) => EFFECT_RANK[e.kind] ?? 3), 9);
      const effectful = [...parents.keys()].filter((id) => rank(id) < 9).sort((a, b) => rank(a) - rank(b));
      if (effectful.length > 10) truncated = true;
      for (const f of effectful.slice(0, 10)) {
        if (f !== h) via(h, f, "calls", g.pathTo(parents, f));
        effects(f, depth);
      }
    };
    const api = (op: string, depth: number) => {
      if (doneApi.has(op)) return;
      if (depth > 3) { truncated = true; return; }
      doneApi.add(op);
      nodes.add(op);
      for (const e of g.outEdges(op, ["handles"])) if (e.dst) { real(e); handler(e.dst, depth); }
    };
    // what an API changes, for ranking a screen's calls: writes and outside services first, then issues
    const weight = (e: Edge) => {
      if (e.kind === "writes" || e.kind === "calls_external") return 6;
      if (e.kind === "enqueues") return 4;
      if (e.kind === "reads") return 1;
      const c = this.counts(this.down(e.dst!));
      return 2 + (c.writes ? 4 : 0) + (c.externals ? 4 : 0) + Math.min(c.issues, 3);
    };
    let omitted = 0;
    const ui = (start: string) => {
      const pages = root.kind === "Route" ? g.outEdges(start, ["renders", "calls"]).filter((e) => e.dst) : [];
      pages.forEach(real);
      const calls = new Map<string, { id: string; page: string; path: string[]; e: Edge; score: number }>();
      for (const page of pages.length ? pages.map((e) => e.dst!) : [start]) {
        const repo = g.nodes.get(page)?.repo;
        const parents = g.walk(page, (id) => g.outEdges(id, ["renders", "calls"]).filter((e) => e.dst && g.nodes.get(e.dst)?.repo === repo && !g.nodes.get(e.dst)?.attrs.handler), 10);
        for (const id of parents.keys()) {
          for (const e of g.outEdges(id, EFFECTS)) {
            if (!e.dst || (compact && e.kind === "reads")) continue;
            const k = `${e.dst}|${e.kind}`;
            if (!calls.has(k)) calls.set(k, { id, page, path: g.pathTo(parents, id), e, score: weight(e) });
          }
        }
      }
      // a big screen calls dozens of APIs: show the ones that matter most, the rest are listed in the APIs tab
      const ranked = [...calls.values()].sort((a, b) => b.score - a.score);
      const limit = compact ? 16 : 24;
      omitted = Math.max(0, ranked.filter((c) => c.e.kind === "requests").length - ranked.slice(0, limit).filter((c) => c.e.kind === "requests").length);
      if (ranked.length > limit) truncated = true;
      for (const { id, page, path, e } of ranked.slice(0, limit)) {
        // the part of the screen that triggers it: nearest component above the call
        const owner = [...path].reverse().find((p) => g.nodes.get(p)?.kind === "Component") ?? page;
        if (owner !== page) via(page, owner, "renders", path.slice(0, path.indexOf(owner) + 1));
        if (id !== owner) via(owner, id, "calls", path.slice(path.indexOf(owner)));
        real(e);
        if (e.kind === "requests") (compact ? summary : api)(e.dst!, 1);
        if (e.kind === "enqueues" && !compact) for (const t of g.outEdges(e.dst!, ["triggers"])) if (t.dst) { real(t); handler(t.dst, 1); }
      }
    };

    if (root.kind === "Route" || root.kind === "Component" || root.kind === "ClientCall") ui(rootId);
    else if (root.kind === "Operation") api(rootId, 0);
    else if (root.kind === "Job" || root.kind === "Queue") for (const e of g.outEdges(rootId, ["triggers"])) { if (e.dst) { real(e); handler(e.dst, 0); } }
    else if (root.kind === "Function") {
      const op = g.inEdges(rootId, ["handles"])[0];
      if (op) { real(op); api(op.src, 0); } else handler(rootId, 0);
    } else return this.q.subgraph(rootId, "down", 2);

    const views = [...nodes].map((id) => {
      const v = this.q.view(g.nodes.get(id)!);
      return summaries.has(id) ? { ...v, attrs: { ...v.attrs, summary: summaries.get(id) } } : v;
    });
    return { rootId, nodes: views, edges: [...edges.values()], truncated, ...(omitted ? { omitted } : {}) };
  }

  /**
   * A screen's rough wireframe: its page component's elements, child components expanded in place, and for each
   * button / form / link the APIs it calls or the screen it opens. `depth` limits how deep child components expand.
   */
  wireframe(routeId: string, depth = 6): Wireframe {
    const g = this.g;
    const route = g.nodes.get(routeId);
    if (!route) throw new Error(`Unknown node ${routeId}`);
    let budget = depth > 3 ? 600 : 160;
    const fileNodes = this.q.cached("nodesByFile", () => {
      const m = new Map<string, GraphNode[]>();
      for (const n of g.nodes.values()) {
        const k = `${n.repo}\0${n.file}`;
        (m.get(k) ?? m.set(k, []).get(k)!).push(n);
      }
      return m;
    });

    // what a handler leads to: the APIs it calls (through client calls / thunks / helpers) and the screen it opens
    const action = (owner: GraphNode, act: NonNullable<UiEl["act"]>) => {
      const sources: Edge[] = [];
      // by position when the edge has one (exact), else by line
      for (const [l0, l1, p0, p1] of act.r ?? []) sources.push(...g.outEdges(owner.id).filter((e) => e.dst && (typeof e.attrs.pos === "number" ? e.attrs.pos >= p0 && e.attrs.pos < p1 : e.line >= l0 && e.line <= l1)));
      if (act.fn) {
        const named = (fileNodes.get(`${owner.repo}\0${owner.file}`) ?? []).find((n) => n.id !== owner.id && (n.name === act.fn || n.name.endsWith(`.${act.fn}`)));
        if (named) sources.push(...g.outEdges(named.id).filter((e) => e.dst));
        sources.push(...g.outEdges(owner.id).filter((e) => e.dst && g.nodes.get(e.dst)?.name.split(".").pop() === act.fn));
      }
      const apis = new Map<string, Ref>();
      let to: Ref | undefined;
      for (const e of sources) {
        if (e.kind === "navigates") { to ??= this.q.ref(e.dst!); continue; }
        if (e.kind === "requests") { apis.set(e.dst!, this.q.ref(e.dst!)); continue; }
        if (e.kind !== "calls") continue;
        for (const id of g.walk(e.dst!, (n) => g.nodes.get(n)?.kind === "Operation" ? [] : g.outEdges(n, ["calls", "requests"]).filter((x) => x.dst), 6).keys()) {
          if (g.nodes.get(id)?.kind === "Operation" && apis.size < 4) apis.set(id, this.q.ref(id));
        }
      }
      return { apis: [...apis.values()], to };
    };

    // formApis: the API of the form-like wrapper around (Formik onSubmit, <form action>…), run by its buttons that have no handler of their own
    const convert = (el: UiEl, owner: GraphNode, level: number, seen: Set<string>, formApis?: Ref[]): WireNode => {
      budget--;
      const w: WireNode = {
        kind: el.k, repo: owner.repo, file: owner.file, line: el.line,
        ...(el.t ? { label: humanize(el.t) } : {}), ...(el.t && I18N_KEY.test(el.t) ? { key: el.t } : {}), ...(el.rep ? { repeat: true } : {}), ...(el.opt ? { optional: true } : {}), ...(el.cols ? { cols: el.cols } : {}),
      };
      const kids: WireNode[] = [];
      if (el.k === "component") {
        const renders = g.outEdges(owner.id, ["renders"]).filter((e) => e.dst);
        const e = renders.find((x) => x.line === el.line) ?? renders.find((x) => g.nodes.get(x.dst!)?.name.split(/[./]/).pop() === el.tag);
        if (e) {
          w.component = this.q.ref(e.dst!);
          // a design-system Button / Input / Select shows as that element, not as its internals
          const as = uiKindOf(el.tag ?? "");
          const leaf = ["button", "link", "input", "select", "checkbox", "image", "icon", "heading", "text"].includes(as);
          if (as !== "component" && as !== "box") w.kind = as;
          if (!leaf || !w.label) w.label ??= el.tag;
          const tree = !leaf && !seen.has(e.dst!) && level < depth && budget > 0 ? this.q.e.store.ui(e.dst!) as UiEl | null : null;
          const child = g.nodes.get(e.dst!);
          if (tree && child) kids.push(convert(tree, child, level + 1, new Set([...seen, e.dst!]), formApis));
        } else w.label ??= el.tag;
      }
      if (el.act) {
        const { apis, to } = action(owner, el.act);
        if (apis.length) w.apis = apis;
        if (to) w.to = to;
        if (el.act.submit) w.submits = true;
      } else if (w.kind === "button" && formApis) w.apis = formApis;
      if (!w.to && (el.k === "link" || el.k === "button")) {
        const nav = g.outEdges(owner.id, ["navigates"]).find((e) => e.dst && e.line === el.line);
        if (nav) w.to = this.q.ref(nav.dst!);
      }
      const inner = (w.kind === "form" || w.submits) && w.apis ? w.apis : formApis;
      for (const c of el.c ?? []) if (budget > 0) kids.push(convert(c, owner, level, seen, inner));
      if (kids.length) w.children = kids;
      return w;
    };

    const page = g.outEdges(routeId, ["renders"]).find((e) => e.dst)?.dst;
    const tree = page ? this.q.e.store.ui(page) as UiEl | null : null;
    const pageNode = page ? g.nodes.get(page) : undefined;
    return {
      screen: this.q.ref(routeId),
      root: tree && pageNode ? { kind: "component", component: this.q.ref(pageNode.id), label: pageNode.name, repo: pageNode.repo, file: pageNode.file, line: pageNode.line, children: [convert(tree, pageNode, 1, new Set([pageNode.id]))] } : null,
      capturable: !!this.q.e.ws.config.repos.find((r) => r.name === route.repo)?.screenshots?.baseUrl,
      shots: Object.entries(readShots(this.q.e.ws)[routeId] ?? {}).map(([variant, e]): ShotInfo => ({
        variant: variant as ShotInfo["variant"], at: e!.at, ok: e!.ok, width: e!.width, height: e!.height,
        ...(e!.note ? { note: e!.note } : {}), ...(e!.blocked ? { blocked: e!.blocked } : {}),
      })),
    };
  }

  /** i18n key → texts in every language, from locale JSON files in the repos (locales/ja/common.json, i18n/en.json, …). */
  private translations(): Map<string, string[]> {
    return this.q.cached("i18n", () => {
      const out = new Map<string, string[]>();
      const add = (k: string, v: string) => (out.get(k) ?? out.set(k, []).get(k)!).push(v);
      const flatten = (o: unknown, prefix: string, ns: string) => {
        if (typeof o === "string") { add(prefix, o); if (ns) { add(`${ns}.${prefix}`, o); add(`${ns}:${prefix}`, o); } return; }
        if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, ns);
      };
      let files = 0;
      const walk = (dir: string, depth: number, inLocales: boolean) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (files > 300) return;
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            if (depth < 7 && !/^(node_modules|\.git|dist|build|\.next|\.nuxt|coverage|\.flowmap)$/.test(e.name)) walk(p, depth + 1, inLocales || /^(locales?|i18n|lang|langs|translations?|messages)$/i.test(e.name));
          } else if (inLocales && e.name.endsWith(".json") && statSync(p).size < 2_000_000) {
            files++;
            try { flatten(JSON.parse(readFileSync(p, "utf8")), "", e.name.replace(/\.json$/, "")); } catch { /* not JSON */ }
          }
        }
      };
      for (const r of this.q.e.ws.config.repos) walk(r.path, 0, false);
      return out;
    });
  }

  /** Clickable areas of a screenshot: each button / link / input on the page matched to the sketch element behind it. */
  shotSpots(routeId: string, variant: Variant = "desktop"): ShotSpots {
    const entry = readShots(this.q.e.ws)[routeId]?.[variant];
    if (!entry?.ok || !entry.spots) return { width: entry?.width ?? 0, height: entry?.height ?? 0, spots: [] };
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const tr = this.translations();
    // sketch elements that do something
    const els: (WireNode & { texts: string[] })[] = [];
    const visit = (w: WireNode) => {
      if (w.label || w.to || w.apis) els.push({ ...w, texts: [w.label ?? "", ...(w.key ? tr.get(w.key) ?? [] : [])].map(norm).filter(Boolean) });
      for (const c of w.children ?? []) visit(c);
    };
    const sketch = this.wireframe(routeId);
    if (sketch.root) visit(sketch.root);
    const routes = [...this.g.nodes.values()].filter((n) => n.kind === "Route" && n.name.startsWith("/"));
    const routeFor = (href: string) => {
      let path: string;
      try { path = new URL(href, entry.url).pathname; } catch { return undefined; }
      const want = normRoute(path).split("/").filter(Boolean);
      return routes.find((r) => {
        const have = normRoute(r.name).split("/").filter(Boolean);
        return have.length === want.length && have.every((h, i) => h === want[i] || h.startsWith(":p"));
      });
    };
    const compatible = (spot: string, kind: UiKind) =>
      spot === kind || ((spot === "link" || spot === "button") && (kind === "link" || kind === "button" || kind === "component")) || (spot === "input" && kind === "select") || (spot === "select" && kind === "input");

    const used = new Map<WireNode, number>();
    const spots: ShotSpot[] = [];
    for (const s of entry.spots) {
      const text = norm(s.text);
      const target = s.href && !/^(https?:)?\/\//.test(s.href.replace(new URL(entry.url).origin, "")) ? routeFor(s.href) : undefined;
      let best: (typeof els)[number] | undefined;
      let bestScore = 1;
      for (const w of els) {
        if (!compatible(s.kind, w.kind)) continue;
        let score = 0;
        if (target && w.to?.id === target.id) score += 5;
        if (text && w.texts.includes(text)) score += 4;
        else if (text.length >= 3 && w.texts.some((t) => t.length >= 3 && (t.includes(text) || text.includes(t)))) score += 2;
        score -= (used.get(w) ?? 0) && !w.repeat ? 1 : 0;      // prefer elements not matched yet, unless they repeat
        if (score > bestScore) { best = w; bestScore = score; }
      }
      if (best) used.set(best, (used.get(best) ?? 0) + 1);
      const to = best?.to ?? (target ? this.q.ref(target.id) : undefined);
      if (!best && !to) continue;
      spots.push({
        x: s.x, y: s.y, w: s.w, h: s.h, kind: (best?.kind ?? s.kind) as UiKind, label: s.text || best?.label || "",
        ...(best?.apis ? { apis: best.apis } : {}), ...(to ? { to } : {}), ...(best?.component ? { component: best.component } : {}),
        repo: best?.repo ?? "", file: best?.file ?? "", line: best?.line ?? 0,
      });
    }
    return { width: entry.width, height: entry.height, spots };
  }

  /** Services (repos / monorepo packages), outside services and queues, with the calls between them. */
  architecture(): Architecture {
    return this.q.cached("architecture", () => {
      const g = this.g;
      const byId = new Map<string, ArchNode>();
      const nodeFor = (n: NonNullable<ReturnType<typeof g.nodes.get>>): ArchNode | null => {
        const kind = !n.repo ? (n.kind === "External" ? "external" : n.kind === "Queue" ? "queue" : null) : "service";
        if (!kind) return null;
        const id = kind === "service" ? `svc:${this.q.groupOf(n)}` : n.id;
        let a = byId.get(id);
        if (!a) {
          a = { id, label: kind === "service" ? this.q.groupOf(n) : n.name, kind, screens: 0, apis: 0, tables: 0, jobs: 0, issues: 0 };
          byId.set(id, a);
        }
        return a;
      };
      for (const n of g.nodes.values()) {
        if (!n.repo) continue;
        const a = nodeFor(n)!;
        if (n.kind === "Route") a.screens++;
        else if (n.kind === "Operation") a.apis++;
        else if (n.kind === "Table") a.tables++;
        else if (n.kind === "Job" || n.kind === "Queue") a.jobs++;
      }
      for (const i of this.q.e.issues) {
        const n = g.nodes.get(i.nodeId);
        if (n) { const a = nodeFor(n); if (a) a.issues++; }
      }
      const links = new Map<string, ArchLink>();
      for (const e of g.edges) {
        if (!e.dst || !(e.kind === "requests" || e.kind === "enqueues" || e.kind === "calls_external")) continue;
        const s = g.nodes.get(e.src), d = g.nodes.get(e.dst);
        if (!s || !d) continue;
        const a = nodeFor(s), b = nodeFor(d);
        if (!a || !b || a.id === b.id) continue;
        const k = `${a.id}|${b.id}|${e.kind}`;
        const l = links.get(k) ?? { src: a.id, dst: b.id, kind: e.kind as ArchLink["kind"], count: 0, samples: [] };
        l.count++;
        if (l.samples.length < 5 && !l.samples.some((x) => x.id === s.id)) l.samples.push(this.q.ref(s.id, d.name));
        links.set(k, l);
      }
      return { nodes: [...byId.values()].sort((x, y) => x.kind.localeCompare(y.kind) || x.label.localeCompare(y.label)), links: [...links.values()] };
    });
  }

  /** What to add to the config: plugins for detected frameworks, outside services FlowMap can't see, unused entries. */
  suggestions(): Suggestion[] {
    return this.q.cached("suggestions", () => {
      const out: Suggestion[] = [];
      const { config } = this.q.e.ws;
      for (const repo of config.repos) {
        const deps = detectDeps(repo.path);
        const missing = builtinPlugins.filter((p) => p.detect?.(deps) && !repo.plugins.includes(p.id)).map((p) => p.id);
        if (deps.python && !repo.plugins.some((id) => builtinPlugins.find((p) => p.id === id)?.extractPy)) missing.push("python");
        if (missing.length) {
          out.push({
            kind: "plugin", repo: repo.name,
            title: `Turn on ${missing.join(", ")}`,
            detail: `${repo.name} uses ${missing.length > 1 ? "these frameworks" : "this framework"}, but the plugin${missing.length > 1 ? "s are" : " is"} off, so its screens, APIs or tables are missing from the graph.`,
            config: `plugins: ${JSON.stringify([...repo.plugins, ...missing])},`,
          });
        }
        const unknown = new Map<string, number>();
        for (const [k, meta] of this.g.fileMeta) {
          if (!k.startsWith(repo.name + "\0")) continue;
          for (const [pkg, n] of Object.entries(meta.unknownCalls ?? {})) unknown.set(pkg, (unknown.get(pkg) ?? 0) + (n as number));
        }
        const services = [...unknown.entries()]
          .filter(([key]) => {
            const [spec, name] = key.split("#");
            return !NOT_SERVICE.test(spec) && (SERVICE_PKG.test(spec) || /(Client|Gateway|Sdk|SDK)$/.test(name));
          })
          .sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (const [key, n] of services) {
          const [spec, name] = key.split("#");
          const label = (SERVICE_PKG.exec(spec)?.[0] ?? name).replace(/^\w/, (c) => c.toUpperCase());
          out.push({
            kind: "external", repo: repo.name,
            title: `Is ${name} (${spec}) an outside service?`,
            detail: `${repo.name} calls ${name} from ${spec} ${n} time(s), but FlowMap doesn't treat it as an outside service. If it makes network calls, list it so the transaction and side-effect rules see them.`,
            config: `externals: { ${JSON.stringify(name)}: ${JSON.stringify(label)} },`,
          });
        }
      }
      const labels = new Set(this.g.edges.filter((e) => e.kind === "calls_external").map((e) => String(e.attrs.label ?? "")));
      for (const [cls, label] of Object.entries(config.externals)) {
        if (!labels.has(label)) out.push({ kind: "unused", repo: config.repos[0]?.name ?? "", title: `externals.${cls} is never used`, detail: `No call to ${cls} was found. Remove it, or check the class name.` });
      }
      const unresolvedRequests = this.g.edges.filter((e) => e.kind === "requests" && !e.dst).length;
      if (config.repos.length === 1 && unresolvedRequests > 0) {
        out.push({
          kind: "info", repo: config.repos[0].name,
          title: "Connect the services it calls",
          detail: `${unresolvedRequests} API call(s) go to services that aren't in this workspace. Add those repos to connect so flows continue into them.`,
          config: `connect: ["../other-service"],`,
        });
      }
      return out;
    });
  }
}
