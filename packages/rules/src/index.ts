import { Graph, normRoute, type Edge, type FlowMapConfig, type GraphNode, type Severity } from "@flowmap/core";

export interface Finding {
  nodeId: string;
  message: string;
  detail: string;            // stable part of the fingerprint (no line numbers)
  path?: string[];           // node ids proving the finding
  file?: string;
  line?: number;
  severity?: Severity;       // override (e.g. read vs write)
}

export interface Rule {
  id: string;
  title: string;
  description: string;
  why: string;
  fix: string;
  severity: Severity;
  run(g: Graph, config: FlowMapConfig, baseline: Baseline): Finding[];
}

/** What the committed baselines recorded: "repo\0operation name" of every API at the last `flowmap baseline update`. */
export interface Baseline { apis: Set<string> }

const name = (g: Graph, id: string) => g.nodes.get(id)?.name ?? id;
const ASSET = /\.(svg|png|jpe?g|gif|webp|ico|css|s[ac]ss|less|json|graphql|gql|md|txt|html|riv|lottie|mp4|mp3|wav|woff2?|ttf)$/i;

function handlers(g: Graph): GraphNode[] {
  return [...g.nodes.values()].filter((n) => n.attrs.handler);
}

function opOf(g: Graph, handler: GraphNode): GraphNode | undefined {
  const e = g.inEdges(handler.id, ["handles"])[0];
  return e ? g.nodes.get(e.src) : undefined;
}

/** Guards and permission decorators, including ones wrapped in composite decorators (applyDecorators). */
export function effectiveAuth(g: Graph, handler: GraphNode) {
  const guards = [...(handler.attrs.guards ?? [])];
  const permissions = [...(handler.attrs.permissions ?? [])];
  for (const e of g.outEdges(handler.id, ["decorated_by"])) {
    const c = e.dst ? g.nodes.get(e.dst)?.attrs.composite : null;
    if (c) {
      guards.push(...c.guards);
      permissions.push(...c.permissions, e.attrs.label);
    }
  }
  return { guards, permissions };
}

const reachable = (g: Graph, start: string, kinds: Edge["kind"][], depth = 8) =>
  g.walk(start, (id) => g.outEdges(id, kinds).filter((e) => e.dst), depth);

const READ_ONLY_OP = /^(GET|HEAD|query) /;
const via = (g: Graph, from: string, id: string) => (id !== from ? ` (via ${name(g, id)})` : "");
const repos = (g: Graph, fact: string) => new Set([...g.fileMeta].filter(([, m]) => m[fact]).map(([k]) => k.split("\0")[0]));

export const rules: Rule[] = [
  {
    id: "tx-external-call",
    title: "External call inside a DB transaction",
    description: "A network call (Stripe, S3, mail, HTTP, queue) runs while a database transaction is open.",
    why: "The transaction holds a DB connection and row locks while waiting on the network. If the DB later rolls back, the external change (charge, email, upload) has already happened and cannot be undone.",
    fix: "Make the call after the transaction commits (an after-commit hook such as runOnTransactionCommit / transaction.on_commit, or after the transactional function returns). For reads, fetch the data before opening the transaction.",
    severity: "error",
    run(g) {
      const out: Finding[] = [];
      const roots = [...g.nodes.values()].filter((n) => n.attrs.transactional || g.outEdges(n.id).some((e) => e.attrs.inTx));
      for (const root of roots) {
        const parents = g.walk(root.id, (id) => g.txEdges(id).filter((e) => e.kind === "calls" && e.dst && (id === root.id || !g.isTxRoot(g.nodes.get(e.dst)))), 8);
        const byLabel = new Map<string, { edge: Edge; via: string; write: boolean }>();
        for (const id of parents.keys()) {
          if (id !== root.id && g.isTxRoot(g.nodes.get(id))) continue;
          for (const e of g.txEdges(id)) {
            if (e.kind !== "calls_external" && e.kind !== "enqueues") continue;
            const label = e.kind === "enqueues" ? `queue ${name(g, e.dst ?? "")}` : e.attrs.label ?? name(g, e.dst ?? "");
            const write = e.kind === "enqueues" || !!e.attrs.write;
            const prev = byLabel.get(label);
            if (!prev || (write && !prev.write)) byLabel.set(label, { edge: e, via: id, write });
          }
        }
        for (const [label, { edge, via, write }] of byLabel) {
          const path = [...g.pathTo(parents, via), ...(edge.dst ? [edge.dst] : [])];
          const what = edge.attrs.method ? `${label} (${edge.attrs.method})` : label;
          out.push({
            nodeId: root.id,
            detail: label,
            message: `${root.name} ${write ? "changes" : "reads"} ${what} while a DB transaction is open${via !== root.id ? ` (via ${name(g, via)})` : ""}.`,
            path, file: edge.file, line: edge.line,
            severity: write ? "error" : "warn",
          });
        }
      }
      return out;
    },
  },
  {
    id: "tx-no-write",
    title: "Transaction with no DB writes",
    description: "A method opens a transaction but never writes to the database.",
    why: "Opening a transaction takes a connection and locks for nothing. Combined with network calls it only adds risk.",
    fix: "Remove the transaction (decorator or wrapper). Keep it only if you need a consistent snapshot across several reads.",
    severity: "warn",
    run(g) {
      const out: Finding[] = [];
      for (const root of g.nodes.values()) {
        if (root.attrs.transactional !== "decorator") continue;
        const parents = reachable(g, root.id, ["calls"]);
        let writes = false, unknown = false, reads = false;
        for (const id of parents.keys()) {
          for (const e of g.outEdges(id)) {
            if (e.kind === "writes" || e.kind === "enqueues") writes = true;
            if (e.kind === "reads") reads = true;
            if (e.kind === "calls" && !e.dst) unknown = true;
          }
        }
        if (writes || unknown) continue;
        out.push({ nodeId: root.id, detail: "", message: `${root.name} opens a transaction but ${reads ? "only reads" : "never touches the database"}.`, file: root.file, line: root.line });
      }
      return out;
    },
  },
  {
    id: "n-plus-one",
    title: "Query inside a loop (N+1)",
    description: "A database query runs once per item in a loop.",
    why: "One round-trip per item: fine with 5 rows, slow with 500, and it multiplies under load.",
    fix: "Load everything in one query (an IN list, a join, a batch insert/update) before the loop. A small fixed loop or deliberate chunking is fine: `// flowmap-ignore n-plus-one: <reason>`.",
    severity: "warn",
    run(g) {
      const out: Finding[] = [];
      const seen = new Set<string>();
      for (const e of g.edges) {
        if (!e.attrs.inLoop || !e.dst) continue;
        let table: string | null = null;
        if (e.kind === "reads" || e.kind === "writes") table = e.dst;
        else if (e.kind === "calls") table = g.outEdges(e.dst, ["reads", "writes"]).find((x) => x.dst)?.dst ?? null;
        if (!table) continue;
        const key = `${e.src}|${e.dst}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const via = e.kind === "calls" ? ` via ${name(g, e.dst)}` : "";
        out.push({
          nodeId: e.src, detail: `${name(g, e.dst)}`,
          message: `${name(g, e.src)} ${e.kind === "writes" ? "writes" : "queries"} ${name(g, table)} inside a loop${via}.`,
          path: e.kind === "calls" ? [e.src, e.dst, table] : [e.src, table], file: e.file, line: e.line,
        });
      }
      return out;
    },
  },
  {
    id: "id-without-actor",
    title: "ID argument without caller check",
    description: "An API takes an id from the client but never looks at who is calling.",
    why: "Any logged-in user can pass someone else's id and read or change their data (IDOR).",
    fix: "Use the authenticated user's id instead of the client's, or check that the caller owns the record / has permission (a permission guard or decorator) before acting.",
    severity: "warn",
    run(g, config) {
      const authz = new RegExp(config.authzGuards, "i");
      const pub = new RegExp(config.publicOperations, "i");
      return handlers(g).flatMap((h) => {
        const op = opOf(g, h);
        const { guards, permissions } = effectiveAuth(g, h);
        if (!h.attrs.idArgs?.length || h.attrs.hasActor || permissions.length || guards.some((x) => authz.test(x)) || pub.test(op?.name ?? h.name)) return [];
        const parents = reachable(g, h.id, ["calls"], 4);
        const ids = [...parents.keys()];
        if (ids.some((id) => g.nodes.get(id)?.attrs.actor)) return [];          // the service looks at the current user
        const writes = ids.some((id) => g.outEdges(id, ["writes"]).length);
        return [{ nodeId: h.id, detail: h.attrs.idArgs.join(","), message: `${op?.name ?? h.name} takes ${h.attrs.idArgs.join(", ")} from the client but never checks who is calling.`, path: op ? [op.id, h.id] : [h.id], file: h.file, line: h.line, ...(writes ? { severity: "error" as const } : {}) }];
      });
    },
  },
  {
    id: "raw-error-in-handler",
    title: "Plain Error reachable from an API",
    description: "Code reachable from an API throws a plain Error, and the app has no catch-all error handler that maps it.",
    why: "Plain Errors become 500 Internal Server Error with no useful message for the client, and add noise to error tracking.",
    fix: "Throw your framework's HTTP error (400 / 403 / 404 with a message code), or add one catch-all error handler that maps errors to responses.",
    severity: "warn",
    run(g) {
      const out: Finding[] = [];
      const done = new Set<string>();
      const mapped = repos(g, "errorHandler");
      for (const h of handlers(g)) {
        if (mapped.has(h.repo)) continue;
        const parents = reachable(g, h.id, ["calls"], 4);
        for (const id of parents.keys()) {
          const n = g.nodes.get(id)!;
          if (!n.attrs.rawThrows || done.has(id)) continue;
          done.add(id);
          const op = opOf(g, h);
          out.push({ nodeId: id, detail: "", message: `${n.name} throws a plain Error (${n.attrs.rawThrows.length}×), reachable from ${op?.name ?? h.name}.`, path: [...(op ? [op.id] : []), ...g.pathTo(parents, id)], file: n.file, line: n.attrs.rawThrows[0] });
        }
      }
      return out;
    },
  },
  {
    id: "unvalidated-input",
    title: "Input without a validated DTO",
    description: "An API takes input that no validation (DTO, schema, pipe) checks before use.",
    why: "Whatever shape the client sends reaches the service: missing fields, wrong types, extra properties.",
    fix: "Validate the input: a DTO class with validation decorators, a schema (Zod, Joi, Pydantic, marshmallow), or a validation pipe/middleware.",
    severity: "warn",
    run(g) {
      return handlers(g).filter((h) => h.attrs.inlineArgs?.length).map((h) => ({
        nodeId: h.id, detail: h.attrs.inlineArgs.join(","), message: `${opOf(g, h)?.name ?? h.name} accepts ${h.attrs.inlineArgs.join(", ")} without validation.`, file: h.file, line: h.line,
      }));
    },
  },
  {
    id: "unguarded-operation",
    title: "API without a guard",
    description: "No authentication guard runs before this handler.",
    why: "Anyone who can reach the server can call it.",
    fix: "Add your auth guard or middleware to this API. If it is public on purpose, add `// flowmap-ignore unguarded-operation: <reason>`.",
    severity: "warn",
    run(g, config) {
      const pub = new RegExp(config.publicOperations, "i");
      const globalGuard = repos(g, "globalGuard");
      return handlers(g).flatMap((h) => {
        const op = opOf(g, h);
        if (globalGuard.has(h.repo) || effectiveAuth(g, h).guards.length || pub.test(`${op?.name ?? ""} ${h.name} ${h.file}`)) return [];
        return [{ nodeId: h.id, detail: "", message: `${op?.name ?? h.name} has no guard.`, path: op ? [op.id, h.id] : [h.id], file: h.file, line: h.line }];
      });
    },
  },
  {
    id: "dead-reference",
    title: "Import points to missing code",
    description: "An internal import does not resolve, or imports a name the target file does not export.",
    why: "Usually left behind by a revert or cherry-pick. It breaks the build or fails at runtime.",
    fix: "Remove the import or restore the missing file/export.",
    severity: "error",
    run(g) {
      const out: Finding[] = [];
      for (const [key, meta] of g.fileMeta) {
        const [repo, file] = key.split("\0");
        for (const imp of meta.imports ?? []) {
          if (ASSET.test(imp.spec)) continue;
          const nodeId = `${repo}:${file}`;
          if (!imp.resolved) {
            out.push({ nodeId, detail: imp.spec, message: `${file} imports "${imp.spec}", which does not exist.`, file, line: imp.line });
            continue;
          }
          const target = g.fileMeta.get(`${repo}\0${imp.resolved}`);
          if (!target || target.exportStar) continue;
          for (const n of imp.names) {
            if (!target.exports.includes(n)) out.push({ nodeId, detail: `${imp.spec}#${n}`, message: `${file} imports ${n === "default" ? "a default export" : `"${n}"`} from "${imp.spec}", which does not export it.`, file, line: imp.line });
          }
        }
      }
      return out;
    },
  },
  {
    id: "contract-drift",
    title: "Frontend and backend disagree",
    description: "A client calls an API the backend does not serve, or the schema declares one nobody implements.",
    why: "The call fails at runtime, or the schema advertises something that does not exist.",
    fix: "Restore/rename the backend operation, or remove the dead call or schema entry.",
    severity: "error",
    run(g) {
      const out: Finding[] = [];
      const serverRepos = new Set([...g.nodes.values()].filter((n) => n.kind === "Operation").map((n) => n.repo));
      if (!serverRepos.size) return out;
      for (const e of g.edges) {
        if (e.dst || !e.resolvedKey) continue;
        if (e.kind === "requests" && (e.resolvedKey.startsWith("op:graphql:") || !serverRepos.has(e.repo))) {
          const op = e.resolvedKey.replace(/^op:(graphql|rest):/, "");
          out.push({ nodeId: e.src, detail: e.resolvedKey, message: `${name(g, e.src)} calls ${op}, but no backend operation serves it.`, file: e.file, line: e.line });
        }
        if (e.kind === "defines") {
          out.push({ nodeId: e.src, detail: e.resolvedKey, message: `Schema declares ${name(g, e.src)} but no resolver implements it.`, file: e.file, line: e.line, severity: "warn" });
        }
      }
      return out;
    },
  },

  {
    id: "missing-fk-index",
    title: "Foreign key without an index",
    description: "A column that points to another table has no index, in the model or in any migration.",
    why: "Finding rows by this column (joins, \"all X of this Y\") and deleting the parent row both scan the whole table. PostgreSQL, SQLite and SQL Server don't index foreign keys on their own (MySQL does, so it is skipped there).",
    fix: "Add an index on the column, in the model or a migration. A small lookup table can skip it: `// flowmap-ignore missing-fk-index: <reason>`.",
    severity: "warn",
    run(g, config) {
      const auto = new Set(config.repos.filter((r) => /mysql|mariadb/i.test(r.database ?? "")).map((r) => r.name));
      return [...g.nodes.values()].filter((t) => t.kind === "Table" && !auto.has(t.repo)).flatMap((t) =>
        (t.attrs.relations ?? []).filter((r: any) => r.indexed === false).map((r: any) => ({
          nodeId: t.id, detail: r.column, message: `${t.name}.${r.column}${r.to === "?" ? "" : ` (→ ${r.to})`} has no index.`, file: t.file, line: t.line,
        })));
    },
  },
  {
    id: "risky-migration",
    title: "Migration that can lock a table or fail",
    description: "A migration builds an index without CONCURRENTLY, adds a NOT NULL column with no default, adds a foreign key that validates under lock, rewrites a table by changing a column type, or uses CONCURRENTLY inside a transaction. (PostgreSQL.)",
    why: "On a table with rows, each of these either blocks writes while it runs (a plain index build, a validating foreign key, a type change), fails outright (NOT NULL with no default), or fails the whole deploy (CONCURRENTLY cannot run in a transaction). It is usually fine on an empty dev database and only shows up in production.",
    fix: "Build indexes with CONCURRENTLY and set `transaction = false` on that migration; add NOT NULL columns with a default (or in steps); add foreign keys NOT VALID, then VALIDATE CONSTRAINT; change a column type with a new column and a backfill. A small table can skip it: `// flowmap-ignore risky-migration: <reason>`.",
    severity: "warn",
    run(g, config) {
      const say = {
        "index-locks": (t: string | null) => `The index on ${t} is built without CONCURRENTLY: writes to the table wait until it finishes.`,
        "not-null-no-default": (t: string | null) => `A NOT NULL column is added to ${t} with no default: this fails when the table has rows.`,
        "fk-validates": (t: string | null) => `The foreign key on ${t} is validated while the table is locked. Add it NOT VALID, then VALIDATE CONSTRAINT.`,
        "type-rewrite": (t: string | null) => `Changing a column type on ${t} rewrites the whole table under a lock.`,
        "concurrent-in-tx": () => "CREATE INDEX CONCURRENTLY cannot run inside a transaction, and this migration runs in one (set `transaction = false`).",
      };
      const found: Finding[] = [];
      for (const [key, meta] of g.fileMeta) {
        const [repo, file] = key.split("\0");
        if (!meta.risks || (config.repos.find((r) => r.name === repo)?.database && !/postgres/i.test(config.repos.find((r) => r.name === repo)!.database!))) continue;
        for (const risk of meta.risks as { rule: keyof typeof say; table: string | null; line: number }[]) {
          const table = risk.table && [...g.nodes.values()].find((n) => n.kind === "Table" && n.repo === repo && n.name === risk.table);
          found.push({
            nodeId: table ? table.id : `${repo}:table:${risk.table ?? file}`, detail: `${risk.rule}|${file}|${risk.table ?? ""}`,
            message: say[risk.rule](risk.table), file, line: risk.line, ...(risk.rule === "concurrent-in-tx" ? { severity: "error" as const } : {}),
          });
        }
      }
      return found;
    },
  },
  {
    id: "breaking-change",
    title: "API removed",
    description: "An API recorded in the committed baseline no longer exists.",
    why: "Clients that still call it fail: other apps, mobile versions already installed, partners, scripts.",
    fix: "Keep it until clients have moved (mark it deprecated). If removing it is intended, run `flowmap baseline update` to record the new API list.",
    severity: "error",
    run(g, _config, baseline) {
      const now = new Set([...g.nodes.values()].filter((n) => n.kind === "Operation").map((n) => `${n.repo}\0${n.name}`));
      return [...baseline.apis].filter((a) => !now.has(a)).map((a) => {
        const [repo, op] = a.split("\0");
        return { nodeId: `${repo}:api:${op}`, detail: op, message: `${op} was removed (it is in the baseline).` };
      });
    },
  },
  {
    id: "write-on-get",
    title: "Read-only API writes data",
    description: "A GET endpoint or a GraphQL query changes the database.",
    why: "Browsers, caches, crawlers and retry logic treat GET and queries as safe to repeat or prefetch, so each repeat can change data nobody meant to change.",
    fix: "Move the write to a POST / PUT / DELETE endpoint or a mutation. A deliberate side effect (audit log, view counter) can be kept: `// flowmap-ignore write-on-get: <reason>`.",
    severity: "warn",
    run(g) {
      return handlers(g).flatMap((h) => {
        const op = opOf(g, h);
        if (!op || !READ_ONLY_OP.test(op.name)) return [];
        const parents = reachable(g, h.id, ["calls"], 6);
        for (const id of parents.keys()) {
          const w = g.outEdges(id, ["writes"]).find((e) => e.dst);
          if (w) return [{ nodeId: h.id, detail: name(g, w.dst!), message: `${op.name} writes ${name(g, w.dst!)}${via(g, h.id, id)}.`, path: [op.id, ...g.pathTo(parents, id), w.dst!], file: w.file, line: w.line }];
        }
        return [];
      });
    },
  },
  {
    id: "multi-write-no-tx",
    title: "Several tables written without a transaction",
    description: "One API writes two or more tables and none of those writes run in a transaction.",
    why: "If a later write fails, the earlier ones stay: an order with no payment, a user with no profile.",
    fix: "Wrap the writes in one transaction (a transactional decorator, the ORM's transaction(...) callback, or atomic()).",
    severity: "warn",
    run(g) {
      return handlers(g).flatMap((h) => {
        const tables = new Map<string, Edge>();
        for (const id of reachable(g, h.id, ["calls"], 6).keys()) {
          const inTx = new Set(g.txEdges(id));
          for (const e of g.outEdges(id, ["writes"])) if (e.dst && !inTx.has(e) && !tables.has(e.dst)) tables.set(e.dst, e);
        }
        if (tables.size < 2) return [];
        const list = [...tables.keys()].map((t) => name(g, t));
        const first = [...tables.values()][0];
        return [{ nodeId: h.id, detail: [...list].sort().join(","), message: `${opOf(g, h)?.name ?? h.name} writes ${list.join(", ")} outside a transaction.`, file: first.file, line: first.line }];
      });
    },
  },
  {
    id: "unbounded-query",
    title: "List query without a limit",
    description: "An API loads every matching row: no limit, page or fixed set of ids.",
    why: "Fast with today's data, then slow and memory-hungry as the table grows; one big account can take the API down.",
    fix: "Add a limit or pagination (take/limit, a cursor, a page size). If the set is small by design, keep it: `// flowmap-ignore unbounded-query: <reason>`.",
    severity: "warn",
    run(g) {
      const out: Finding[] = [];
      const seen = new Set<string>();
      for (const h of handlers(g)) {
        const parents = reachable(g, h.id, ["calls"], 6);
        const op = opOf(g, h);
        for (const id of parents.keys()) {
          for (const e of g.outEdges(id, ["reads"])) {
            if (!e.dst || !e.attrs.unbounded || seen.has(`${id}|${e.dst}`)) continue;
            seen.add(`${id}|${e.dst}`);
            out.push({ nodeId: id, detail: name(g, e.dst), message: `${name(g, id)} loads every row of ${name(g, e.dst)} with no limit (reachable from ${op?.name ?? h.name}).`, path: [...(op ? [op.id] : []), ...g.pathTo(parents, id), e.dst], file: e.file, line: e.line });
          }
        }
      }
      return out;
    },
  },
  {
    id: "orphan-api",
    title: "API no client calls",
    description: "A backend API that no connected frontend calls. Checked only for API families a client in the workspace uses (GraphQL, server actions, a REST prefix such as /api/v1): a partner-only API isn't reported.",
    why: "Either dead code that still has to be secured and maintained, or a feature whose screen is missing.",
    fix: "Remove it, or connect the client that uses it. If it is used outside this workspace (mobile app, partner, script), keep it: `// flowmap-ignore orphan-api: <reason>`.",
    severity: "warn",
    run(g, config) {
      const pub = new RegExp(config.publicOperations, "i");
      const family = (op: GraphNode) => {
        const kind = /^(query|mutation|subscription|action) /.exec(op.name)?.[1];
        if (kind) return `${op.repo}|${kind === "action" ? "action" : "graphql"}`;
        const [a = "", b = ""] = (op.name.split(" ")[1] ?? "").split("/").filter(Boolean);
        return `${op.repo}|/${a}${/^v\d+$/.test(b) ? `/${b}` : ""}`;
      };
      // a client: another repo, or a screen/component (a backend calling itself is internal)
      const fromClient = (e: Edge) => e.repo !== g.nodes.get(e.dst!)!.repo || /^(Component|Route)$/.test(g.nodes.get(e.src)?.kind ?? "");
      const consumed = new Set(g.edges.filter((e) => e.kind === "requests" && e.dst && g.nodes.get(e.dst)?.kind === "Operation" && fromClient(e)).map((e) => family(g.nodes.get(e.dst!)!)));
      return [...g.nodes.values()]
        .filter((n) => n.kind === "Operation" && consumed.has(family(n)) && !g.inEdges(n.id, ["requests"]).length && !pub.test(n.name))
        .map((n) => ({ nodeId: n.id, detail: "", message: `${n.name} is not called by any connected frontend.` }));
    },
  },
  {
    id: "unreachable-screen",
    title: "Screen nothing links to",
    description: "A screen no link, button or redirect in the app leads to (checked only in apps whose links FlowMap reads).",
    why: "Usually a leftover page that still ships and must be maintained, or a missing menu entry.",
    fix: "Link it from where users should find it, or remove it. Pages opened from outside (emails, ads, invites) can be kept: `// flowmap-ignore unreachable-screen: <reason>`.",
    severity: "warn",
    run(g, config) {
      const entry = new RegExp(`^/$|\\*|404|not-?found|error|invite|share|embed|${config.publicOperations}`, "i");
      const routes = [...g.nodes.values()].filter((n) => n.kind === "Route");
      const navRepos = new Set(g.edges.filter((e) => e.kind === "navigates").map((e) => e.repo));
      const shownIn = new Map<string, Set<string>>();       // component/function → screens it is part of
      for (const r of routes) for (const id of reachable(g, r.id, ["renders", "calls"], 6).keys()) (shownIn.get(id) ?? shownIn.set(id, new Set()).get(id)!).add(r.id);
      // a link counts unless it only comes from the screen itself
      const linked = routes.filter((r) => g.inEdges(r.id, ["navigates"]).some((e) => !shownIn.has(e.src) || [...shownIn.get(e.src)!].some((x) => x !== r.id))).map((r) => normRoute(r.name));
      return routes.filter((r) => {
        const path = normRoute(r.name);
        // named mobile screens are reached by name; a layout route (/admin) whenever one of its children (/admin/users) is
        return navRepos.has(r.repo) && path.startsWith("/") && !r.name.includes("{") && !entry.test(r.name) && !linked.some((p) => p === path || p.startsWith(`${path}/`));
      }).map((r) => ({ nodeId: r.id, detail: "", message: `Nothing in the app links to ${r.name}.` }));
    },
  },
  {
    id: "queue-no-consumer",
    title: "Message nobody handles",
    description: "Code sends a job, task or event that no worker or listener in the workspace handles.",
    why: "The work is silently lost: queued forever, or the event fires and nothing happens.",
    fix: "Add the worker/listener, fix the name, or connect the repo that handles it.",
    severity: "warn",
    run(g) {
      const out = new Map<string, Finding>();
      for (const e of g.edges) {
        // a queue with a worker triggers it; one nobody consumes is only a placeholder
        if (e.kind !== "enqueues" || !e.dst || g.outEdges(e.dst, ["triggers"]).length) continue;
        out.set(`${e.src}|${e.dst}`, { nodeId: e.src, detail: e.dst, message: `${name(g, e.src)} sends "${e.dst.replace(/^queue:(task:|event:)?/, "")}", but nothing handles it.`, file: e.file, line: e.line });
      }
      return [...out.values()];
    },
  },
  {
    id: "webhook-unverified",
    title: "Webhook without a signature check",
    description: "A webhook endpoint never verifies the sender's signature.",
    why: "Anyone who finds the URL can send fake events: a fake \"payment succeeded\", a fake sign-up.",
    fix: "Verify the signature header with the provider's SDK (e.g. Stripe constructEvent) or an HMAC compare before trusting the body.",
    severity: "warn",
    run(g) {
      return handlers(g).flatMap((h) => {
        const op = opOf(g, h);
        if (!op || !/\/(?:webhooks?|hooks?)(?:\/|$)/i.test(op.name) || /^GET /.test(op.name)) return [];        // /webhooks/stripe, not /webhook-endpoints
        if (effectiveAuth(g, h).guards.some((x) => /sign|hmac|verif|webhook/i.test(x))) return [];
        if ([...reachable(g, h.id, ["calls"], 4).keys()].some((id) => g.nodes.get(id)?.attrs.verifies)) return [];
        return [{ nodeId: h.id, detail: "", message: `${op.name} accepts events without checking their signature.`, path: [op.id, h.id], file: h.file, line: h.line }];
      });
    },
  },
];

export const ruleById = new Map(rules.map((r) => [r.id, r]));
