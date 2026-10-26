import { Node, SyntaxKind, type CallExpression, type Expression } from "ts-morph";
import type { FileContext, FlowMapPlugin } from "@flowmap/core";
import { operation } from "./routes.ts";
import { identKey } from "./util.ts";

/** HTTP server frameworks that register routes as calls: app.get("/users/:id", auth, handler). Data per framework. */
interface ServerPack {
  id: string;
  deps: string[];
  modules: RegExp;          // imports that mark a server file
  factories: RegExp;        // initializers that create an app/router
  types: RegExp;            // parameter types that are an app/router (route modules receiving the app)
}

export const SERVER_PACKS: ServerPack[] = [
  { id: "express", deps: ["express"], modules: /^express$/, factories: /^(express|express\.Router|Router)\(/, types: /\b(Express|Router|Application)\b/ },
  { id: "fastify", deps: ["fastify"], modules: /^fastify$/, factories: /^(fastify|Fastify)\(/, types: /\bFastifyInstance\b/ },
  { id: "hono", deps: ["hono"], modules: /^hono(\/|$)/, factories: /^new Hono\b/, types: /\bHono\b/ },
  { id: "koa", deps: ["@koa/router", "koa-router"], modules: /^(@koa\/router|koa-router)$/, factories: /^new (Router|KoaRouter)\b/, types: /\bRouter\b/ },
];

const METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);
const AUTH_MW = /auth|jwt|login|session|protect|require|verify|guard|passport|clerk|permission|role|admin|token/i;
const VALIDATE_MW = /valid|schema|zod|celebrate|joi|yup|\bbody\(|\bcheck\(/i;

const str = (n: Node | undefined) => n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) ? n.getLiteralValue() : null;
const propOf = (o: Node, k: string): Expression | undefined => {
  if (!Node.isObjectLiteralExpression(o)) return undefined;
  const p = o.getProperty(k);
  return p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
};

function handlerTarget(ctx: FileContext, h: Node | undefined): { key: string; hint: string } | null {
  if (!h) return null;
  if (Node.isCallExpression(h)) h = h.getArguments().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a)) ?? h.getArguments()[0];
  if (!h) return null;
  if (Node.isArrowFunction(h) || Node.isFunctionExpression(h)) {
    const fn = ctx.fns.find((f) => f.body === h);
    return fn ? { key: ctx.fnKey(fn.node.name), hint: ctx.file } : null;
  }
  return Node.isIdentifier(h) || Node.isPropertyAccessExpression(h) ? identKey(ctx, h.getText()) : null;
}

function serverRoutes(ctx: FileContext, pack: ServerPack) {
  const imported = [...ctx.imports.values()].some((i) => pack.modules.test(i.spec));
  const receivers = new Set<string>();
  for (const d of ctx.sf.getVariableDeclarations()) {
    if (pack.factories.test((d.getInitializer()?.getText() ?? "").replace(/^await\s+/, ""))) receivers.add(d.getName());
  }
  for (const fn of ctx.fns) for (const p of fn.params) if (pack.types.test(p.type)) receivers.add(p.name);
  if (pack.id === "fastify" && imported) ["fastify", "app", "instance", "server"].forEach((n) => receivers.add(n));
  if (!receivers.size) return;

  // app.get(...) / router.use(...) calls, wherever they are (often at module level, outside any function)
  const calls: { call: CallExpression; root: string; method: string; line: number }[] = [];
  for (const call of ctx.sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const e = call.getExpression();
    if (Node.isPropertyAccessExpression(e) && Node.isIdentifier(e.getExpression()) && receivers.has(e.getExpression().getText())) {
      calls.push({ call, root: e.getExpression().getText(), method: e.getName(), line: call.getStartLineNumber() });
    }
  }

  // same-file prefixes (app.use("/users", users)) and global auth middleware (app.use(authenticate))
  const prefix = new Map<string, string>();
  for (const cs of calls) {
    const [a, b] = cs.call.getArguments();
    const p = str(a);
    if ((cs.method === "use" || cs.method === "route") && p !== null && b && Node.isIdentifier(b)) prefix.set(b.getText(), p);
    if ((cs.method === "use" || cs.method === "addHook") && cs.call.getArguments().some((x) => !Node.isStringLiteral(x) && AUTH_MW.test(x.getText()))) ctx.meta.globalGuard = true;
  }

  for (const cs of calls) {
    const args = cs.call.getArguments();
    let path: string | null = null;
    let verb = "";
    let handler: Node | undefined;
    let mw: Node[] = [];
    if (METHODS.has(cs.method) && args.length >= 2) {
      path = str(args[0]);
      verb = cs.method === "all" ? "ALL" : cs.method.toUpperCase();
      handler = args[args.length - 1];
      mw = args.slice(1, -1);
    } else if (cs.method === "route" && args.length === 1 && Node.isObjectLiteralExpression(args[0])) {
      const o = args[0];
      path = str(propOf(o, "url") ?? propOf(o, "path"));
      const m = propOf(o, "method");
      verb = (str(m) ?? (m && Node.isArrayLiteralExpression(m) ? str(m.getElements()[0]) : null) ?? "ALL").toUpperCase();
      handler = propOf(o, "handler");
      mw = [o];
    }
    if (path === null || !(path.startsWith("/") || path === "*")) continue;
    // fastify options object: { preHandler: [auth], schema: {...} }
    const parts = mw.flatMap((m) => Node.isObjectLiteralExpression(m)
      ? ["preHandler", "onRequest", "preValidation"].map((k) => propOf(m, k)?.getText() ?? "").concat(propOf(m, "schema") ? ["schema"] : [])
      : [m.getText()]).filter(Boolean);
    const target = handlerTarget(ctx, handler);
    if (!target) continue;
    const guards = parts.filter((t) => AUTH_MW.test(t)).map((t) => t.replace(/\s+/g, " ").slice(0, 60));
    operation(ctx, verb, (prefix.get(cs.root) ?? "") + path, target.key, cs.line,
      { framework: pack.id, handlerInfo: { guards, validated: parts.some((t) => VALIDATE_MW.test(t)) } }, target.hint);
  }
}

export const serverPlugins: FlowMapPlugin[] = SERVER_PACKS.map((pack) => ({
  id: pack.id,
  detect: (pkg) => pack.deps.some((d) => !!(pkg.dependencies?.[d] ?? pkg.devDependencies?.[d])),
  extract: (ctx) => serverRoutes(ctx, pack),
}));
