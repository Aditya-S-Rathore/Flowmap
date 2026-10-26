import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Node as PyNode, Parser, Tree } from "web-tree-sitter";
import { flags, isWriteMethod } from "./extract.ts";
import type { DecoratorInfo, FlowMapConfig, GraphEdge, GraphNode, RepoConfig } from "./types.ts";

export type { PyNode };

let parser: Parser | null = null;

/** Loads the tree-sitter runtime and the Python grammar (WebAssembly) once per process. */
export async function initPython() {
  if (parser) return;
  const { Parser, Language } = await import("web-tree-sitter");
  await Parser.init();
  const lang = await Language.load(createRequire(import.meta.url).resolve("tree-sitter-python/tree-sitter-python.wasm"));
  parser = new Parser();
  parser.setLanguage(lang);
}

export interface PyDecorator extends DecoratorInfo {
  kwargs: Record<string, string>;
}

export interface PyParam {
  name: string;
  type: string;
  default: string;
}

export interface PyClass {
  name: string;
  line: number;
  bases: string[];
  decorators: PyDecorator[];
  fields: Map<string, { value: string; type: string; line: number }>;   // class body assignments (incl. "Meta.db_table")
  attrTypes: Map<string, string>;                                       // self.x → type name
  node: PyNode;
}

export interface PyFn {
  node: GraphNode;
  cls: PyClass | null;
  name: string;             // function or method name
  decorators: PyDecorator[];
  params: PyParam[];
  body: PyNode;
  text: string;
}

export interface PyCall {
  fn: PyFn | null;          // null = module level
  node: PyNode;
  line: number;
  callee: string;
  root: string | null;
  segments: string[];
  chained: boolean;
  method: string;
  args: PyNode[];
  kwargs: Record<string, PyNode>;
  inLoop: boolean;
  inTx: boolean;
  afterCommit: boolean;
  withs: string[];
  claimed: boolean;
}

export interface PyImport {
  module: string;           // dotted module
  name: string | null;      // imported name, null = the module itself
  resolved: string | null;  // repo-relative file of the module
}

export interface PyFileContext {
  language: "python";
  root: PyNode;
  repo: RepoConfig;
  file: string;
  config: FlowMapConfig;
  fns: PyFn[];
  classes: Map<string, PyClass>;
  calls: PyCall[];
  imports: Map<string, PyImport>;
  assigns: Map<string, PyNode>;            // module-level `name = value`
  hasFile(path: string): boolean;
  resolveModule(module: string): string | null;
  fnKey(name: string): string;
  node(n: Omit<GraphNode, "endLine" | "keys" | "attrs"> & Partial<Pick<GraphNode, "endLine" | "keys" | "attrs">>): GraphNode;
  edge(e: Omit<GraphEdge, "repo" | "file"> & Partial<Pick<GraphEdge, "file">>): void;
  constant(key: string, value: string): void;
  meta: Record<string, any>;
}

const LOOPS = new Set(["for_statement", "while_statement"]);
const COMPREHENSIONS = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);
const TX_WITH = /\b(atomic|begin|begin_nested|transaction)\s*\(/;
const RAW_ERRORS = /^(Exception|RuntimeError|ValueError|KeyError|TypeError|AssertionError)$/;
const PY_ACTOR = /\brequest\.(?:user|auth)\b|\bcurrent_user\b|\bg\.user\b|get_jwt_identity\(/;
const PY_VERIFIES = /construct_event|hmac\.|compare_digest|verify_\w*signature|validate_\w*signature|webhook\w*\.verify|\bWebhook\(|\.verify\(|headers(?:\.get\(|\[)\s*["'][\w-]*(?:token|signature|secret|hmac)/i;
const PY_CATCH_ALL = /exception_handler\(\s*Exception\b|errorhandler\(\s*(?:Exception|500)\b|def\s+process_exception\(|EXCEPTION_HANDLER/;
const HTTP_LIBS = new Set(["requests", "httpx", "aiohttp"]);
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export const PY_EXTERNALS: Record<string, string> = {
  stripe: "Stripe", boto3: "AWS", requests: "HTTP", httpx: "HTTP", aiohttp: "HTTP", smtplib: "Mail", sendgrid: "Mail",
  redis: "Redis", openai: "OpenAI", anthropic: "Anthropic", slack_sdk: "Slack", twilio: "Twilio", posthog: "PostHog",
};
const AWS_SERVICES: Record<string, string> = { s3: "S3", sqs: "SQS", sns: "SNS", ses: "Mail", sesv2: "Mail", dynamodb: "DynamoDB", lambda: "Lambda" };

/** String value of a Python string literal; f-string fields become ${expr} so REST paths can be normalized. */
export function pyStr(n: PyNode | null | undefined): string | null {
  if (!n) return null;
  if (n.type === "concatenated_string") return n.namedChildren.map((c) => pyStr(c) ?? "").join("");
  if (n.type !== "string") return null;
  let out = "";
  for (const c of n.namedChildren) {
    if (c.type === "string_content") out += c.text;
    else if (c.type === "interpolation") out += "${" + (c.namedChildren[0]?.text ?? "") + "}";
  }
  return out;
}

const line = (n: PyNode) => n.startPosition.row + 1;

function chainOf(n: PyNode) {
  const segments: string[] = [];
  let chained = false;
  while (true) {
    if (n.type === "attribute") {
      segments.unshift(n.childForFieldName("attribute")!.text);
      n = n.childForFieldName("object")!;
    } else if (n.type === "call") {
      chained = true;
      n = n.childForFieldName("function")!;
    } else if (n.type === "parenthesized_expression" || n.type === "await") {
      n = n.namedChildren[0]!;
    } else break;
  }
  return { root: n.type === "identifier" ? n.text : null, segments, chained };
}

function decorator(d: PyNode): PyDecorator {
  const expr = d.namedChildren[0]!;
  const call = expr.type === "call" ? expr : null;
  const args: string[] = [];
  const kwargs: Record<string, string> = {};
  for (const a of call?.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "keyword_argument") kwargs[a.childForFieldName("name")!.text] = a.childForFieldName("value")!.text;
    else if (a.type !== "comment") args.push(a.text);
  }
  return { name: (call ? call.childForFieldName("function")! : expr).text, args, kwargs, line: line(d) };
}

function params(fn: PyNode): PyParam[] {
  const out: PyParam[] = [];
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    let name = "", type = "", def = "";
    if (p.type === "identifier") name = p.text;
    else if (p.type === "typed_parameter") { name = p.namedChildren[0]!.text; type = p.childForFieldName("type")?.text ?? ""; }
    else if (p.type === "default_parameter") { name = p.childForFieldName("name")!.text; def = p.childForFieldName("value")!.text; }
    else if (p.type === "typed_default_parameter") { name = p.childForFieldName("name")!.text; type = p.childForFieldName("type")?.text ?? ""; def = p.childForFieldName("value")!.text; }
    else continue;
    if (name !== "self" && name !== "cls") out.push({ name, type, default: def });
  }
  return out;
}

const decoratorsOf = (def: PyNode) => def.parent?.type === "decorated_definition" ? def.parent.namedChildren.filter((c) => c.type === "decorator").map(decorator) : [];

/** Parses one Python file into a context plugins can read. The caller must call `done()` after plugins ran (frees the tree). */
export function extractPython(text: string, base: { repo: RepoConfig; file: string; config: FlowMapConfig; hasFile(path: string): boolean; roots: string[] }) {
  if (!parser) throw new Error("Python support is not initialized");
  const tree: Tree = parser.parse(text)!;
  const { repo, file } = base;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const constants: [string, string][] = [];

  const roots = [...new Set(["", "src/", ...base.roots.filter(Boolean).map((r) => r + "/")])];
  const resolveModule = (mod: string): string | null => {
    const path = mod.replace(/\./g, "/");
    for (const r of roots) for (const c of [`${r}${path}.py`, `${r}${path}/__init__.py`]) if (base.hasFile(c)) return c;
    return null;
  };
  const moduleOfFile = file.replace(/(\/__init__)?\.py$/, "").replace(/\//g, ".");

  const ctx: PyFileContext = {
    language: "python", root: tree.rootNode, repo, file, config: base.config,
    fns: [], classes: new Map(), calls: [], imports: new Map(), assigns: new Map(),
    hasFile: base.hasFile, resolveModule, meta: {},
    fnKey: (name) => `fn:${repo.name}:${name}`,
    node(n) {
      const full: GraphNode = { endLine: n.line, keys: [], attrs: {}, ...n };
      nodes.push(full);
      return full;
    },
    edge(e) {
      edges.push({ ...e, repo: repo.name, file: e.file ?? file });
    },
    constant(key, value) {
      constants.push([key, value]);
    },
  };

  // imports
  const metaImports: { spec: string; line: number; resolved: string | null; names: string[] }[] = [];
  let exportStar = false;
  const absolute = (mod: PyNode) => {
    if (mod.type !== "relative_import") return mod.text;
    const dots = /^\.+/.exec(mod.text)![0].length;
    let dir = dirname(file);
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    const rest = mod.text.slice(dots);
    const pkg = dir === "." ? "" : dir.replace(/\//g, ".");
    return [pkg, rest].filter(Boolean).join(".");
  };
  const internal = (mod: string) => {
    const top = mod.split(".")[0];
    return roots.some((r) => base.hasFile(`${r}${top}.py`) || base.hasFile(`${r}${top}/__init__.py`)) || !!resolveModule(mod);
  };
  for (const st of tree.rootNode.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (!st) continue;
    if (st.type === "import_statement") {
      for (const n of st.namedChildren) {
        const mod = n.type === "aliased_import" ? n.childForFieldName("name")!.text : n.text;
        const local = n.type === "aliased_import" ? n.childForFieldName("alias")!.text : mod.split(".")[0];
        const resolved = resolveModule(mod);
        ctx.imports.set(local, { module: n.type === "aliased_import" ? mod : mod.split(".")[0], name: null, resolved: n.type === "aliased_import" ? resolved : resolveModule(mod.split(".")[0]) });
        if (internal(mod)) metaImports.push({ spec: mod, line: line(st), resolved, names: [] });
      }
      continue;
    }
    const modNode = st.childForFieldName("module_name")!;
    const mod = absolute(modNode);
    const resolved = resolveModule(mod);
    const names: string[] = [];
    if (st.namedChildren.some((c) => c.type === "wildcard_import")) {
      if (file.endsWith("__init__.py")) exportStar = true;
    }
    for (const n of st.childrenForFieldName("name")) {
      if (!n) continue;
      const name = n.type === "aliased_import" ? n.childForFieldName("name")!.text : n.text;
      const local = n.type === "aliased_import" ? n.childForFieldName("alias")!.text : name;
      const sub = resolveModule(`${mod}.${name}`);
      if (sub) ctx.imports.set(local, { module: `${mod}.${name}`, name: null, resolved: sub });
      else {
        ctx.imports.set(local, { module: mod, name, resolved });
        names.push(name);
      }
    }
    if (internal(mod)) metaImports.push({ spec: modNode.text.startsWith(".") ? `${modNode.text} (${mod})` : mod, line: line(st), resolved, names: resolved ? names : [] });
  }

  // module-level assignments and constants
  const exportsList = new Set<string>(ctx.imports.keys());
  for (const st of tree.rootNode.namedChildren) {
    const a = st.type === "expression_statement" ? st.namedChildren[0] : null;
    if (a?.type !== "assignment") continue;
    const left = a.childForFieldName("left")!;
    const right = a.childForFieldName("right");
    if (left.type !== "identifier" || !right) continue;
    ctx.assigns.set(left.text, right);
    exportsList.add(left.text);
    const v = pyStr(right);
    if (v !== null) constants.push([left.text, v]);
  }

  // classes and functions
  const addFn = (def: PyNode, cls: PyClass | null) => {
    const name = def.childForFieldName("name")!.text;
    const qual = cls ? `${cls.name}.${name}` : name;
    const body = def.childForFieldName("body")!;
    const raw = body.descendantsOfType("raise_statement").filter((r) => {
      const e = r?.namedChildren[0];
      const callee = e?.type === "call" ? e.childForFieldName("function")!.text : e?.text;
      return !!callee && RAW_ERRORS.test(callee);
    }).map((r) => line(r!));
    const decorators = decoratorsOf(def);
    const node = ctx.node({
      id: `${repo.name}:${file}#${qual}`, kind: "Function", name: qual, repo: repo.name, file,
      line: line(decorators.length ? def.parent! : def), endLine: def.endPosition.row + 1,
      keys: [ctx.fnKey(qual)],
      attrs: {
        loc: def.endPosition.row - def.startPosition.row + 1,
        exported: !name.startsWith("_"),
        ...(cls ? { className: cls.name } : {}),
        ...(decorators.length ? { decorators: decorators.map((d) => d.name) } : {}),
        ...(def.text.startsWith("async") ? { async: true } : {}),
        ...(raw.length ? { rawThrows: raw } : {}),
        ...(PY_ACTOR.test(def.text) ? { actor: true } : {}),
        ...(PY_VERIFIES.test(def.text) ? { verifies: true } : {}),
      },
    });
    ctx.fns.push({ node, cls, name, decorators, params: params(def), body, text: def.text });
  };

  const defOf = (n: PyNode) => (n.type === "decorated_definition" ? n.childForFieldName("definition") : n);
  for (const top of tree.rootNode.namedChildren) {
    const def = defOf(top);
    if (!def) continue;
    if (def.type === "function_definition") {
      addFn(def, null);
      exportsList.add(def.childForFieldName("name")!.text);
    } else if (def.type === "class_definition") {
      const name = def.childForFieldName("name")!.text;
      exportsList.add(name);
      const bases = (def.childForFieldName("superclasses")?.namedChildren ?? []).filter((b) => b.type !== "keyword_argument").map((b) => b.text);
      const cls: PyClass = { name, line: line(def), bases, decorators: decoratorsOf(def), fields: new Map(), attrTypes: new Map(), node: def };
      ctx.classes.set(name, cls);
      if (bases[0]) constants.push([`__extends:${name}`, bases[0].split(".").pop()!]);
      const fields = (body: PyNode, prefix: string) => {
        for (const st of body.namedChildren) {
          const a = st.type === "expression_statement" ? st.namedChildren[0] : null;
          if (a?.type === "assignment") {
            const left = a.childForFieldName("left")!;
            const type = a.childForFieldName("type")?.text ?? "";
            if (left.type === "identifier") {
              cls.fields.set(prefix + left.text, { value: a.childForFieldName("right")?.text ?? "", type, line: line(a) });
              if (type) cls.attrTypes.set(left.text, type.replace(/^Optional\[|\]$/g, ""));
            }
          } else if (st.type === "class_definition" && !prefix) {
            fields(st.childForFieldName("body")!, st.childForFieldName("name")!.text + ".");
          }
        }
      };
      fields(def.childForFieldName("body")!, "");
      for (const m of def.childForFieldName("body")!.namedChildren) {
        const mdef = defOf(m);
        if (mdef?.type === "function_definition") addFn(mdef, cls);
      }
      // self.x = Type(...) / self.x = param (typed)
      for (const fn of ctx.fns.filter((f) => f.cls === cls)) {
        for (const a of fn.body.descendantsOfType("assignment")) {
          const left = a?.childForFieldName("left");
          const right = a?.childForFieldName("right");
          if (left?.type !== "attribute" || left.childForFieldName("object")?.text !== "self" || !right) continue;
          const attr = left.childForFieldName("attribute")!.text;
          let type = "";
          if (right.type === "call") type = right.childForFieldName("function")!.text.split(".").pop()!;
          else if (right.type === "identifier") type = fn.params.find((p) => p.name === right.text)?.type ?? "";
          if (/^[A-Z]/.test(type) && !cls.attrTypes.has(attr)) cls.attrTypes.set(attr, type);
        }
      }
    }
  }

  // calls, owned by the innermost known function
  const owners = new Map<number, PyFn>(ctx.fns.map((f) => [f.body.id, f]));
  for (const c of tree.rootNode.descendantsOfType("call")) {
    if (!c) continue;
    let fn: PyFn | null = null;
    let inLoop = false, afterCommit = false;
    const withs: string[] = [];
    let prev: PyNode = c;
    for (let a = c.parent; a; prev = a, a = a.parent) {
      const owner = owners.get(a.id);
      if (owner) { fn = owner; break; }
      if (LOOPS.has(a.type) && !(a.type === "for_statement" && a.childForFieldName("right")?.id === prev.id)) inLoop = true;
      if (COMPREHENSIONS.has(a.type) && prev.type !== "for_in_clause") inLoop = true;
      if (a.type === "with_statement") for (const item of a.descendantsOfType("with_item")) if (item) withs.push(item.text);
      if ((a.type === "lambda" || a.type === "function_definition") && a.parent?.type === "argument_list") {
        const outer = a.parent.parent;
        const m = outer?.type === "call" ? outer.childForFieldName("function")!.text.split(".").pop()! : "";
        if (base.config.afterCommit.includes(m)) afterCommit = true;
      }
    }
    const fnNode = c.childForFieldName("function")!;
    const { root, segments, chained } = chainOf(fnNode);
    const method = segments.length ? segments[segments.length - 1] : root ?? "";
    if (!method) continue;
    const args: PyNode[] = [];
    const kwargs: Record<string, PyNode> = {};
    for (const a of c.childForFieldName("arguments")?.namedChildren ?? []) {
      if (a.type === "keyword_argument") kwargs[a.childForFieldName("name")!.text] = a.childForFieldName("value")!;
      else if (a.type !== "comment") args.push(a);
    }
    ctx.calls.push({
      fn, node: c, line: line(c), callee: fnNode.text.slice(0, 200), root, segments, chained, method, args, kwargs,
      inLoop, inTx: withs.some((w) => TX_WITH.test(w)), afterCommit, withs, claimed: false,
    });
  }

  const suppressions: { line: number; rule: string; reason: string }[] = [];
  text.split("\n").forEach((l, i) => {
    const m = /#\s*flowmap-ignore\s+([\w-]+)(?:\s*:\s*(.+))?/.exec(l);
    if (m) suppressions.push({ line: i + 1, rule: m[1], reason: (m[2] ?? "").trim() });
  });
  ctx.meta = { ...(PY_CATCH_ALL.test(text) ? { errorHandler: true } : {}), suppressions, exports: [...exportsList], exportStar, imports: metaImports, module: moduleOfFile };

  return { ctx, nodes, edges, constants, done: () => tree.delete() };
}

/** Edges for calls no plugin claimed: internal calls (self., imported functions, modules) and well-known outside services. */
export function emitPyDefaultEdges(ctx: PyFileContext, externals: Record<string, string>) {
  const local = new Set(ctx.fns.filter((f) => !f.cls).map((f) => f.name));
  const ext = (c: PyCall, label: string, method: string) =>
    ctx.edge({ src: c.fn!.node.id, kind: "calls_external", dstKey: `ext:${label}`, line: c.line, attrs: { ...flags(c), method, write: isWriteMethod(method), label } });
  const call = (c: PyCall, name: string, hint: string) =>
    ctx.edge({ src: c.fn!.node.id, kind: "calls", dstKey: ctx.fnKey(name), line: c.line, attrs: { ...flags(c), hint } });

  // local variables holding outside clients: s3 = boto3.client("s3"), client = OpenAI()
  const clientLabel = (v: PyNode | undefined | null): string | null => {
    if (v?.type !== "call") return null;
    const { root, segments } = chainOf(v.childForFieldName("function")!);
    const imp = root ? ctx.imports.get(root) : undefined;
    const top = imp ? (imp.name ? imp.module : imp.module).split(".")[0] : root ?? "";
    if (top === "boto3") return AWS_SERVICES[pyStr(v.childForFieldName("arguments")?.namedChildren[0]) ?? ""] ?? "AWS";
    const cls = segments.length ? segments[segments.length - 1] : imp?.name ?? root ?? "";
    return externals[cls] ?? (!imp?.resolved ? PY_EXTERNALS[top] : undefined) ?? null;
  };
  const moduleClients = new Map<string, string>();
  for (const [name, v] of ctx.assigns) {
    const label = clientLabel(v);
    if (label) moduleClients.set(name, label);
  }
  const fnClients = new Map<PyFn, Map<string, string>>();
  const clientsOf = (fn: PyFn) => {
    let m = fnClients.get(fn);
    if (m) return m;
    m = new Map(moduleClients);
    for (const a of fn.body.descendantsOfType("assignment")) {
      const left = a?.childForFieldName("left");
      const label = clientLabel(a?.childForFieldName("right"));
      if (left?.type === "identifier" && label) m.set(left.text, label);
    }
    fnClients.set(fn, m);
    return m;
  };

  const http = (c: PyCall, verb: string) => {
    const url = pyStr(c.args[0] ?? c.kwargs.url);
    if (!url || !url.includes("/")) return false;
    const host = /^https?:\/\/([^/{$]+)/.exec(url)?.[1];
    if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|[\w-]+)(:\d+)?$/.test(host)) {
      ctx.edge({ src: c.fn!.node.id, kind: "calls_external", dstKey: `ext:HTTP ${host}`, line: c.line, attrs: { ...flags(c), method: verb, write: verb !== "GET", label: `HTTP ${host}` } });
    } else {
      const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "").replace(/\$\{[^}]*\}/g, ":p").replace(/^[^/]*?(?=\/)/, "").replace(/\/+$/, "") || "/";
      ctx.edge({ src: c.fn!.node.id, kind: "requests", dstKey: `op:rest:${verb} ${path.replace(/:\w+/g, ":p")}`, line: c.line, attrs: { ...flags(c), method: verb, label: `${verb} ${path}` } });
    }
    return true;
  };

  for (const c of ctx.calls) {
    if (c.claimed || !c.fn) continue;
    const fn = c.fn;
    if ((c.root === "self" || c.root === "cls") && fn.cls) {
      if (c.segments.length === 1) { call(c, `${fn.cls.name}.${c.method}`, ctx.file); continue; }
      const type = fn.cls.attrTypes.get(c.segments[0]);
      if (!type || c.chained) continue;
      const label = externals[type];
      if (label) ext(c, label, c.segments.slice(1).join("."));
      const imp = ctx.imports.get(type);
      const hint = ctx.classes.has(type) ? ctx.file : imp?.resolved;
      if (hint) call(c, `${type}.${c.segments[1]}`, hint);
      continue;
    }
    if (!c.root) continue;
    const clients = clientsOf(fn);
    if (clients.has(c.root) && c.segments.length) { ext(c, clients.get(c.root)!, c.segments.join(".")); continue; }
    const imp = ctx.imports.get(c.root);
    if (imp) {
      const top = imp.module.split(".")[0];
      if (HTTP_LIBS.has(top) && !imp.resolved) {
        const verb = c.method === "request" ? (pyStr(c.args.shift()) ?? "GET").toUpperCase() : c.method.toUpperCase();
        if ((HTTP_VERBS.has(c.method) || c.method === "request") && http(c, verb)) continue;
      }
      if (!imp.resolved) {
        const label = PY_EXTERNALS[top] ?? externals[imp.name ?? ""];
        if (label) ext(c, label, [imp.name, ...c.segments].filter(Boolean).join(".") || c.root);
        else {
          const k = `${imp.module}#${c.root}`;
          (ctx.meta.unknownCalls ??= {})[k] = (ctx.meta.unknownCalls[k] ?? 0) + 1;
        }
        continue;
      }
      if (imp.name) {
        // from x import func / Class.method(); not: instances (session.add), constructors (Payment(...)), deeper chains
        const isClass = /^[A-Z]/.test(imp.name);
        if (c.chained || c.segments.length > 1 || (c.segments.length === 1 && !isClass) || (c.segments.length === 0 && isClass)) continue;
        call(c, c.segments.length ? `${imp.name}.${c.segments[0]}` : imp.name, imp.resolved);
        continue;
      }
      // module import: mod.func() / mod.sub.func() / mod.Class.method()
      let mod = imp.module;
      let rest = [...c.segments];
      let file = imp.resolved;
      while (rest.length > 1) {
        const sub = ctx.resolveModule(`${mod}.${rest[0]}`);
        if (!sub) break;
        mod = `${mod}.${rest.shift()}`;
        file = sub;
      }
      if (rest.length && !c.chained) call(c, rest.slice(0, 2).join("."), file);
      continue;
    }
    if (c.segments.length === 0 && local.has(c.root)) call(c, c.root, ctx.file);
    else if (c.segments.length === 1 && ctx.classes.has(c.root)) call(c, `${c.root}.${c.method}`, ctx.file);
    else if (externals[c.root] && c.segments.length) ext(c, externals[c.root], c.segments.join("."));
  }
}

