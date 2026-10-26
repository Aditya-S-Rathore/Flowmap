import { flags, pyStr, type FlowMapPlugin, type PyFileContext, type PyFn, type PyNode } from "@flowmap/core";
import { operation } from "./routes.ts";

const AUTH = /user|auth|token|login|current|admin|permission|verify|session|jwt|role|staff|superuser/i;
const ID_PARAM = /^(id|pk)$|_id$|Id$/;
const INLINE_TYPES = /^(dict|Dict(\[.*\])?|Any|object|)$/;
const VALIDATES = /\.(load|validate|model_validate|parse_obj)\(|Schema\(|BaseModel/;     // marshmallow, pydantic

/** "'/users'" | '"/users"' | "r'^users/$'" → /users */
const lit = (raw: string | undefined) => raw ? /^[rRbBuUfF]*(["'])(.*)\1$/s.exec(raw.trim())?.[2] ?? null : null;
const names = (raw: string | undefined) => [...(raw ?? "").matchAll(/(?:Depends|Security)\(\s*([\w.]+)/g)].map((m) => m[1]);
const last = (s: string) => s.split(".").pop()!;
/** The whole chain a call sits in: `session.query(User).filter(...).all()` for the `query(...)` call. */
const chainOf = (n: PyNode) => { while (n.parent && /^(attribute|call|subscript)$/.test(n.parent.type)) n = n.parent; return n.text; };
const PY_BOUNDED = /\.(?:limit|first|one|one_or_none|scalar|get|count|exists|paginate|slice|aggregate|latest|earliest|update|delete)\(|\[[^\]]*:/;
const DJ_MANY = new Set(["all", "filter", "exclude", "values", "values_list", "order_by", "select_related", "prefetch_related", "distinct", "only", "defer", "iterator", "annotate"]);

function mark(fn: PyFn, info: { guards: string[]; hasActor: boolean; idArgs: string[]; inline: string[]; input?: { name: string; type: string; validated: boolean }[] }) {
  Object.assign(fn.node.attrs, {
    handler: true,
    guards: [...new Set([...(fn.node.attrs.guards ?? []), ...info.guards])],
    permissions: fn.node.attrs.permissions ?? [],
    hasActor: !!(fn.node.attrs.hasActor || info.hasActor),
    idArgs: info.idArgs,
    inlineArgs: info.inline,
    input: info.input ?? [],
  });
}

/** Module-level `x = Factory(prefix=...)`: the URL prefix and router-level auth of each router/app in this file. */
function routers(ctx: PyFileContext, factory: RegExp, prefixKw: string) {
  const out = new Map<string, { prefix: string; guards: string[] }>();
  for (const [name, v] of ctx.assigns) {
    if (v.type !== "call" || !factory.test(last(v.childForFieldName("function")!.text))) continue;
    const kw = (k: string) => v.childForFieldName("arguments")?.namedChildren.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")!.text === k)?.childForFieldName("value");
    out.set(name, { prefix: pyStr(kw(prefixKw)) ?? "", guards: names(kw("dependencies")?.text).filter((g) => AUTH.test(g)) });
  }
  return out;
}

export const fastapi: FlowMapPlugin = {
  id: "fastapi",
  detect: (pkg) => !!pkg.dependencies?.fastapi,
  extractPy(ctx) {
    const apps = routers(ctx, /^(APIRouter|FastAPI)$/, "prefix");
    for (const [name, r] of apps) if (r.guards.length && /FastAPI/.test(ctx.assigns.get(name)!.text)) ctx.meta.globalGuard = true;
    for (const fn of ctx.fns) {
      for (const d of fn.decorators) {
        const m = /^(\w+)\.(get|post|put|patch|delete|options|head|api_route|websocket)$/.exec(d.name);
        if (!m) continue;
        const path = lit(d.args[0]) ?? lit(d.kwargs.path) ?? "";
        const verb = m[2] === "api_route" ? (lit(/\[\s*([^,\]]+)/.exec(d.kwargs.methods ?? "")?.[1]) ?? "ALL").toUpperCase() : m[2] === "websocket" ? "WS" : m[2].toUpperCase();
        const router = apps.get(m[1]);
        const deps = fn.params.filter((p) => /^(Depends|Security)\(/.test(p.default) || /Depends\(|Security\(/.test(p.type));
        const depNames = deps.flatMap((p) => names(p.default + p.type));
        const guards = [...(router?.guards ?? []), ...names(d.kwargs.dependencies).filter((g) => AUTH.test(g)), ...depNames.filter((g) => AUTH.test(g))];
        const inputs = fn.params.filter((p) => !deps.includes(p) && !/^(request|response|background_tasks|db|session)$/.test(p.name));
        mark(fn, {
          guards,
          hasActor: depNames.some((g) => AUTH.test(g)),
          idArgs: inputs.filter((p) => ID_PARAM.test(p.name)).map((p) => p.name),
          inline: VALIDATES.test(fn.text) ? [] : inputs.filter((p) => INLINE_TYPES.test(p.type) && /body|data|payload|item|input/.test(p.name)).map((p) => p.name),
          input: inputs.map((p) => ({ name: p.name, type: p.type || "any", validated: !INLINE_TYPES.test(p.type) })),
        });
        operation(ctx, verb, (router?.prefix ?? "") + path, ctx.fnKey(fn.node.name), d.line, { framework: "fastapi" });
      }
    }
  },
};

export const flask: FlowMapPlugin = {
  id: "flask",
  detect: (pkg) => !!pkg.dependencies?.flask,
  extractPy(ctx) {
    const bps = routers(ctx, /^(Blueprint|Flask)$/, "url_prefix");
    for (const fn of ctx.fns) {
      for (const d of fn.decorators) {
        const m = /^(\w+)\.(route|get|post|put|patch|delete)$/.exec(d.name);
        if (!m) continue;
        const path = lit(d.args[0]) ?? "";
        const verbs = m[2] === "route" ? [...(d.kwargs.methods ?? "").matchAll(/["'](\w+)["']/g)].map((x) => x[1].toUpperCase()) : [m[2].toUpperCase()];
        const guards = fn.decorators.filter((x) => x !== d && AUTH.test(x.name)).map((x) => x.name);
        const pathIds = [...path.matchAll(/<(?:\w+:)?(\w+)>/g)].map((x) => x[1]).filter((n) => ID_PARAM.test(n));
        const body = /request\.(json|get_json|form|data)\b/.test(fn.text) && !VALIDATES.test(fn.text);
        mark(fn, {
          guards,
          hasActor: !!fn.node.attrs.actor,
          idArgs: pathIds,
          inline: body ? ["request body"] : [],
        });
        for (const verb of verbs.length ? verbs : ["GET"]) operation(ctx, verb, (bps.get(m[1])?.prefix ?? "") + path, ctx.fnKey(fn.node.name), d.line, { framework: "flask" });
      }
    }
  },
};

// ---------- Django (+ Django REST framework) ----------

const DJ_READ = new Set(["get", "filter", "all", "exclude", "first", "last", "count", "exists", "values", "values_list", "aggregate", "annotate", "order_by", "in_bulk", "iterator", "latest", "earliest", "get_or_none", "select_related", "prefetch_related", "distinct", "only", "defer"]);
const DJ_WRITE = new Set(["create", "update", "delete", "bulk_create", "bulk_update", "get_or_create", "update_or_create", "save"]);
const CBV_BASE = /View|ViewSet|APIView|Mixin/;
const CBV_METHODS = /^(get|post|put|patch|delete|list|create|retrieve|update|partial_update|destroy)$/;
const VIEWSET_ACTIONS: [string, string, boolean][] = [["GET", "list", false], ["POST", "create", false], ["GET", "retrieve", true], ["PUT", "update", true], ["PATCH", "partial_update", true], ["DELETE", "destroy", true]];

const isModel = (ctx: PyFileContext, name: string) =>
  !!ctx.classes.get(name)?.bases.some((b) => /(^|\.)Model$/.test(b)) || /models(\.py$|\/)/.test(ctx.imports.get(name)?.resolved ?? "");

function djangoModels(ctx: PyFileContext) {
  for (const cls of ctx.classes.values()) {
    if (!cls.bases.some((b) => /(^|\.)Model$/.test(b)) || /True/.test(cls.fields.get("Meta.abstract")?.value ?? "")) continue;
    const app = ctx.file.split("/").slice(-3, -1).find((p) => p !== "models") ?? "app";
    const table = lit(cls.fields.get("Meta.db_table")?.value) ?? `${app}_${cls.name.toLowerCase()}`;
    const id = `${ctx.repo.name}:table:${table}`;
    const relations = [...cls.fields.entries()]
      .map(([name, f]) => ({ name, m: /(ForeignKey|OneToOneField)\(\s*["']?([\w.]+)/.exec(f.value) }))
      .filter((r) => r.m).map((r) => ({ to: last(r.m![2]), column: `${r.name}_id`, indexed: !/db_index\s*=\s*False/.test(cls.fields.get(r.name)!.value) }));   // Django indexes foreign keys itself
    ctx.node({ id, kind: "Table", name: table, repo: ctx.repo.name, file: ctx.file, line: cls.line, keys: [`table:${table}`, `entity:${cls.name}`], attrs: { entity: cls.name, relations } });
    for (const r of relations) ctx.edge({ src: id, kind: "relates", dstKey: `entity:${r.to}`, line: cls.line, attrs: { column: r.column, optional: true } });
  }
}

function djangoOrm(ctx: PyFileContext) {
  const instances = new Map<PyFn, Map<string, string>>();
  const instancesOf = (fn: PyFn) => {
    let m = instances.get(fn);
    if (m) return m;
    m = new Map();
    for (const a of fn.body.descendantsOfType("assignment")) {
      const left = a?.childForFieldName("left");
      const right = a?.childForFieldName("right");
      if (left?.type !== "identifier" || right?.type !== "call") continue;
      const root = /^(\w+)/.exec(right.childForFieldName("function")!.text)?.[1] ?? "";
      if (isModel(ctx, root)) m.set(left.text, root);
    }
    instances.set(fn, m);
    return m;
  };
  for (const c of ctx.calls) {
    if (c.claimed || !c.fn || !c.root || c.node.parent?.type === "attribute") continue;   // only the outermost call of a chain
    let model: string | null = null;
    let write = false;
    if (c.segments[0] === "objects" || (c.segments.length > 1 && isModel(ctx, c.root) && /^[A-Z]/.test(c.root))) {
      if (!isModel(ctx, c.root) && c.segments[0] !== "objects") continue;
      model = c.root;
      write = c.segments.slice(1).some((s) => DJ_WRITE.has(s));
      if (!write && !c.segments.slice(1).some((s) => DJ_READ.has(s))) continue;
    } else if (c.segments.length === 1 && (c.method === "save" || c.method === "delete") && instancesOf(c.fn).has(c.root)) {
      model = instancesOf(c.fn).get(c.root)!;
      write = true;
    }
    if (!model) continue;
    const unbounded = !write && DJ_MANY.has(c.method) && !PY_BOUNDED.test(chainOf(c.node));
    ctx.edge({ src: c.fn.node.id, kind: write ? "writes" : "reads", dstKey: `entity:${model}`, line: c.line, attrs: { ...flags(c), method: c.method, ...(unbounded ? { unbounded: true } : {}) } });
    c.claimed = true;
  }
}

function djangoViews(ctx: PyFileContext) {
  if (/settings(\.py$|\/)/.test(ctx.file) && /DEFAULT_PERMISSION_CLASSES[\s\S]{0,200}IsAuthenticated/.test(ctx.root.text)) ctx.meta.globalGuard = true;
  const viewsFile = /views?(\.py$|\/)|api(\.py$|\/)/.test(ctx.file);
  for (const fn of ctx.fns) {
    if (fn.decorators.some((d) => /(^|\.)atomic$/.test(d.name))) fn.node.attrs.transactional = "decorator";
    const cbv = fn.cls && fn.cls.bases.some((b) => CBV_BASE.test(b)) && CBV_METHODS.test(fn.name);
    const fbv = !fn.cls && viewsFile && fn.params[0]?.name === "request";
    if (!cbv && !fbv) continue;
    const decoGuards = fn.decorators.filter((d) => /login_required|permission_required|user_passes_test|staff_member_required|permission_classes/.test(d.name))
      .map((d) => d.name === "permission_classes" ? d.args.join(",") : d.name).filter((g) => !/AllowAny/.test(g));
    const clsGuards = fn.cls ? ["permission_classes", "authentication_classes"].map((k) => fn.cls!.fields.get(k)?.value ?? "").filter((v) => v && !/AllowAny/.test(v)) : [];
    const writesBody = /request\.(data|POST|body)\b/.test(fn.text) && !/is_valid\(|Serializer\(|\.validate\(|Form\(/.test(fn.text);
    mark(fn, {
      guards: [...decoGuards, ...clsGuards],
      hasActor: !!fn.node.attrs.actor,
      idArgs: fn.params.slice(fbv ? 1 : 0).filter((p) => ID_PARAM.test(p.name)).map((p) => p.name),
      inline: writesBody ? ["request body"] : [],
    });
  }
}

function djangoUrls(ctx: PyFileContext) {
  if (!/urls\.py$/.test(ctx.file)) return;
  const target = (view: PyNode): { keys: string[]; hint: string } | null => {
    let v = view;
    let cbv = false;
    if (v.type === "call" && /\.as_view$/.test(v.childForFieldName("function")!.text)) { v = v.childForFieldName("function")!.childForFieldName("object")!; cbv = true; }
    const parts = v.text.split(".");
    const head = ctx.imports.get(parts[0]);
    const hint = head?.resolved ?? ctx.file;
    const name = head?.name && parts.length === 1 ? head.name : parts.slice(head && !head.name ? 1 : 0).join(".");
    if (!name) return null;
    return { keys: cbv ? ["get", "post", "put", "patch", "delete"].map((m) => ctx.fnKey(`${name}.${m}`)) : [ctx.fnKey(name)], hint };
  };
  for (const c of ctx.calls) {
    if (c.fn) continue;
    if (/^(path|re_path|url)$/.test(c.callee) && c.args.length >= 2) {
      const raw = pyStr(c.args[0]);
      if (raw === null || c.args[1].type === "call" && /^include$/.test(c.args[1].childForFieldName("function")!.text)) continue;
      const t = target(c.args[1]);
      if (!t) continue;
      const path = "/" + raw.replace(/^\^|\$$/g, "").replace(/\(\?P<(\w+)>[^)]*\)/g, "<$1>");
      // class-based views: whichever of get/post/... the class defines handles the request
      const optional = t.keys.length > 1;
      const id = operation(ctx, "ALL", path, t.keys[0], c.line, { framework: "django" }, t.hint, optional);
      for (const k of t.keys.slice(1)) ctx.edge({ src: id, kind: "handles", dstKey: k, line: c.line, attrs: { hint: t.hint, optional: true } });
    } else if (c.method === "register" && c.segments.length === 1 && c.args.length >= 2) {
      // DRF: router.register(r"users", UserViewSet)
      const prefix = "/" + (pyStr(c.args[0]) ?? "").replace(/^\^|\$$/g, "");
      const t = target(c.args[1]);
      if (!t) continue;
      const cls = c.args[1].text.split(".").pop()!;
      for (const [verb, action, detail] of VIEWSET_ACTIONS) {
        operation(ctx, verb, detail ? `${prefix}/<pk>` : prefix, ctx.fnKey(`${cls}.${action}`), c.line, { framework: "django" }, t.hint, true);
      }
    }
  }
}

export const django: FlowMapPlugin = {
  id: "django",
  detect: (pkg) => !!(pkg.dependencies?.django ?? pkg.dependencies?.djangorestframework),
  extractPy(ctx) {
    djangoModels(ctx);
    djangoViews(ctx);
    djangoUrls(ctx);
    djangoOrm(ctx);
  },
};

// ---------- SQLAlchemy ----------

const SESSION = /session|^db$|^s$|conn|connection/i;

export const sqlalchemy: FlowMapPlugin = {
  id: "sqlalchemy",
  detect: (pkg) => !!(pkg.dependencies?.sqlalchemy ?? pkg.dependencies?.sqlmodel ?? pkg.dependencies?.["flask-sqlalchemy"]),
  extractPy(ctx) {
    for (const cls of ctx.classes.values()) {
      const table = lit(cls.fields.get("__tablename__")?.value) ?? (cls.bases.some((b) => /SQLModel/.test(b)) && /table\s*=\s*True/.test(cls.node.text.split("\n")[0]) ? cls.name.toLowerCase() : null);
      if (!table) continue;
      const relations = [...cls.fields.entries()].flatMap(([name, f]) => {
        const fk = /ForeignKey\(\s*["'](\w+)\.\w+["']/.exec(f.value);
        return fk ? [{ to: fk[1], column: name, indexed: /\b(index|unique|primary_key)\s*=\s*True/.test(f.value) }] : [];
      });
      const id = `${ctx.repo.name}:table:${table}`;
      ctx.node({ id, kind: "Table", name: table, repo: ctx.repo.name, file: ctx.file, line: cls.line, keys: [`table:${table}`, `entity:${cls.name}`], attrs: { entity: cls.name, relations } });
      for (const r of relations) ctx.edge({ src: id, kind: "relates", dstKey: `table:${r.to}`, line: cls.line, attrs: { column: r.column } });
    }
      const entityArg = (n: PyNode | undefined) => n?.type === "identifier" && /^[A-Z]/.test(n.text) ? n.text : n?.type === "call" && /^[A-Z]\w*$/.test(n.childForFieldName("function")!.text) ? n.childForFieldName("function")!.text : null;
    const varModels = new Map<PyFn, Map<string, string>>();
    const modelOfVar = (fn: PyFn, name: string) => {
      let m = varModels.get(fn);
      if (!m) {
        m = new Map();
        for (const a of fn.body.descendantsOfType("assignment")) {
          const e = entityArg(a?.childForFieldName("right") ?? undefined);
          if (a?.childForFieldName("left")?.type === "identifier" && e) m.set(a.childForFieldName("left")!.text, e);
        }
        varModels.set(fn, m);
      }
      return m.get(name) ?? null;
    };
    for (const c of ctx.calls) {
      if (c.claimed || !c.fn) continue;
      const recv = c.segments.length ? [c.root, ...c.segments.slice(0, -1)].join(".") : "";
      let kind: "reads" | "writes" | null = null;
      let entity: string | null = null;
      if (c.segments.length === 0 && /^(select|insert|update|delete)$/.test(c.method)) {
        entity = entityArg(c.args[0]);
        kind = c.method === "select" ? "reads" : "writes";
      } else if (SESSION.test(recv) && /^(query|get|scalars?|execute)$/.test(c.method)) {
        entity = entityArg(c.args[0]);
        kind = "reads";
        const sql = c.args[0]?.type === "call" && /(^|\.)text$/.test(c.args[0].childForFieldName("function")!.text) ? pyStr(c.args[0].childForFieldName("arguments")?.namedChildren[0]) : null;
        if (sql) {
          const w = /\b(?:insert\s+into|update|delete\s+from)\s+["`]?(\w+)/i.exec(sql);
          const r = /\bfrom\s+["`]?(\w+)/i.exec(sql);
          if (w ?? r) {
            ctx.edge({ src: c.fn.node.id, kind: w ? "writes" : "reads", dstKey: `table:${(w ?? r)![1]}`, line: c.line, attrs: { ...flags(c), method: c.method, raw: true } });
            c.claimed = true;
          }
          continue;
        }
      } else if (SESSION.test(recv) && /^(add|add_all|delete|merge)$/.test(c.method)) {
        const a = c.args[0];
        entity = entityArg(a) ?? (a?.type === "identifier" ? modelOfVar(c.fn, a.text) : null);
        kind = "writes";
      }
      if (!kind || !entity) continue;
      const chain = chainOf(c.node);
      const unbounded = kind === "reads" && /\.all\(/.test(chain) && !PY_BOUNDED.test(chain);
      ctx.edge({ src: c.fn.node.id, kind, dstKey: `entity:${entity}`, line: c.line, attrs: { ...flags(c), method: c.method, ...(unbounded ? { unbounded: true } : {}) } });
      c.claimed = true;
    }
  },
};

// ---------- Celery ----------

export const celery: FlowMapPlugin = {
  id: "celery",
  detect: (pkg) => !!pkg.dependencies?.celery,
  extractPy(ctx) {
    for (const fn of ctx.fns) {
      const d = fn.decorators.find((x) => /(^|\.)(task|shared_task)$/.test(x.name));
      if (!d || fn.cls) continue;
      const name = lit(d.kwargs.name);
      const id = `${ctx.repo.name}:queue:task:${fn.name}`;
      ctx.node({ id, kind: "Queue", name: `task ${name ?? fn.name}`, repo: ctx.repo.name, file: ctx.file, line: d.line, keys: [`queue:task:${fn.name}`, `queue:task:${ctx.meta.module}.${fn.name}`, ...(name ? [`queue:task:${name}`] : [])] });
      ctx.edge({ src: id, kind: "triggers", dstKey: ctx.fnKey(fn.node.name), line: d.line, attrs: { hint: ctx.file } });
    }
    for (const c of ctx.calls) {
      if (c.claimed || !c.fn) continue;
      let task: string | null = null;
      if (/^(delay|apply_async|s|si|signature)$/.test(c.method) && c.segments.length === 1 && c.root) task = c.root;
      else if (c.method === "send_task") task = pyStr(c.args[0]);
      if (!task) continue;
      ctx.edge({ src: c.fn.node.id, kind: "enqueues", dstKey: `queue:task:${task}`, line: c.line, attrs: { method: c.method, ...(c.inTx ? { inTx: true } : {}), ...(c.afterCommit ? { afterCommit: true } : {}) } });
      c.claimed = true;
    }
  },
};

/** Plain Python (no framework plugin): functions, calls, imports and outside services. */
export const python: FlowMapPlugin = {
  id: "python",
  extractPy() {},
};

export const pythonPlugins = [python, fastapi, flask, django, sqlalchemy, celery];
