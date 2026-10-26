import { Node, SyntaxKind, type Expression, type JsxAttribute, type ObjectLiteralExpression } from "ts-morph";
import type { FileContext, FlowMapPlugin, FnInfo, GraphEdge } from "@flowmap/core";
import { identKey, normalizeRestPath } from "./util.ts";

/*
 * Screens and links for any router, from three generic readers driven by data (see router-packs.ts):
 *  - file-based:   the folder path is the URL (Next.js, Nuxt, SvelteKit, Remix, Expo Router, Astro)
 *  - config-based: route objects / <Route> elements (React Router, Vue Router, Angular, TanStack, React Navigation)
 *  - links:        <Link to>, navigate(), router.push(), <RouterLink to> ... become `navigates` edges
 */

export interface FileRule {
  dir: string;              // folder under a package root: "app", "src/routes", "server/api"
  kind: "page" | "endpoint";
  file: RegExp;             // files in that folder that count
  nameInPath: boolean;      // pages/about.tsx → /about (true); app/about/page.tsx → /about (false)
  prefix?: string;          // URL prefix, e.g. "/api" for Next pages/api and Nuxt server/api
  flat?: boolean;           // Remix flat routes: dots in names separate segments (users.$id.tsx)
  verbs?: boolean;          // endpoint verbs are exported functions (GET, POST); otherwise the default export (verb from name or ALL)
  exclude?: RegExp;         // file or folder names that are not routes
}

export interface ConfigRules {
  componentKeys: string[];  // route object keys that hold the screen component
  jsxRoute?: boolean;       // <Route path element> / <Route path component>
  jsxScreen?: boolean;      // <Stack.Screen name component> (name-based)
  screensObject?: boolean;  // createXNavigator({ screens: { Home: HomeScreen } })
  fileRouteCall?: boolean;  // TanStack createFileRoute("/posts/$id")({ component })
  routeCalls?: boolean;     // React Router 7 routes.ts: route("about", "routes/about.tsx"), index("routes/home.tsx")
  angularComponents?: boolean;
}

export interface RouterPack {
  id: string;
  deps: string[];           // package names that turn the pack on in `flowmap init`
  files?: FileRule[];
  config?: ConfigRules;
  serverActions?: boolean;  // Next.js "use server" functions are APIs
}

const COPY_PROPS = ["layout", "isAuthen", "auth", "private", "featureFlag", "flag", "theme", "roles", "allowWhenAuthed", "requiresAuth", "canActivate", "meta"];
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// ---------- link targets ----------

const LINK_TAGS: Record<string, string[]> = {
  Link: ["to", "href"], NavLink: ["to"], Navigate: ["to"], Redirect: ["to"], RouterLink: ["to"], "router-link": ["to"],
  NuxtLink: ["to"], "nuxt-link": ["to"], A: ["href"], a: ["href"],
};
const NAV_CALLS = new Set(["navigate", "redirect", "permanentRedirect", "navigateTo", "goto", "navigateByUrl"]);
const NAV_RECEIVER = /router|history|navigation|navigator|^nav$/i;
const LINK_PROPS = /^(to|href|path|link|url|route|pathname|redirectTo|redirect)$/;
const ROUTE_OBJECT_KEYS = ["component", "element", "Component", "loadComponent", "lazy", "children", "screen"];
const ROUTE_CONSTANTS = /^[A-Za-z_]*(path|route|url|link|page|screen)(s|names?)?$/i;

/** Route key for a link argument, or null when it isn't an in-app path. */
export function linkKey(n: Node | undefined, named = false): string | null {
  if (!n) return null;
  if (Node.isParenthesizedExpression(n) || Node.isAsExpression(n)) return linkKey(n.getExpression(), named);
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) {
    const v = n.getLiteralValue();
    if (v.startsWith("/") && !v.startsWith("//")) return `route:${v}`;
    return named && /^[A-Za-z][\w-]*$/.test(v) ? `route:${v}` : null;
  }
  if (Node.isTemplateExpression(n)) {
    let out = n.getHead().getLiteralText();
    const spans = n.getTemplateSpans();
    if (!out && spans.length) {
      const first = spans[0].getExpression();
      if (!(Node.isPropertyAccessExpression(first) || /^[A-Z][A-Z0-9_]*$/.test(first.getText()))) return null;
    }
    spans.forEach((s, i) => {
      const e = s.getExpression();
      // a value glued to the previous text (`${PATHNAME.X}${location.search}`) is a query/suffix, not a path segment
      if (i === 0 || !out || out.endsWith("/")) out += Node.isIdentifier(e) || Node.isPropertyAccessExpression(e) ? `{param:${e.getText()}}` : ":p";
      out += s.getLiteral().getLiteralText();
    });
    return out.startsWith("/") || out.startsWith("{param:") ? `route:${out.replace(/^\{param:([^}]+)\}/, "{const:$1}")}` : null;
  }
  if (Node.isPropertyAccessExpression(n) || (Node.isIdentifier(n) && /^[A-Z][A-Z0-9_]*$/.test(n.getText()))) return `route:{const:${n.getText()}}`;
  if (Node.isObjectLiteralExpression(n)) {
    const prop = (k: string) => { const p = n.getProperty(k); return p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined; };
    const name = prop("name");
    if (name && (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name))) return `routename:${name.getLiteralValue()}`;
    return linkKey(prop("pathname") ?? prop("path"), named);
  }
  if (Node.isArrayLiteralExpression(n)) {
    // Angular: router.navigate(["/heroes", id])
    const parts = n.getElements().map((e) => (Node.isStringLiteral(e) ? e.getLiteralValue().replace(/^\/|\/$/g, "") : ":p"));
    return parts.length && Node.isStringLiteral(n.getElements()[0]) && n.getElements()[0].getText().slice(1).startsWith("/") ? `route:/${parts.join("/")}` : null;
  }
  return null;
}

/** cond ? "/a" : "/b" → both */
function branches(n: Node | undefined): (Node | undefined)[] {
  if (n && Node.isConditionalExpression(n)) return [...branches(n.getWhenTrue()), ...branches(n.getWhenFalse())];
  if (n && Node.isParenthesizedExpression(n)) return branches(n.getExpression());
  return [n];
}

/** Innermost function of the file around a node (the owner of a JSX link). */
function ownerOf(owners: Map<Node, FnInfo>, n: Node): FnInfo | undefined {
  for (let a = n.getParent(); a; a = a.getParent()) {
    const f = owners.get(a);
    if (f) return f;
  }
  return undefined;
}

function attrValue(a: JsxAttribute): Node | undefined {
  const init = a.getInitializer();
  if (!init) return undefined;
  return Node.isJsxExpression(init) ? init.getExpression() : init;
}

const linksDone = new WeakSet<FileContext>();

/** <Link to>, navigate(), router.push(), redirect(), template <RouterLink to> → navigates edges (once per file, whichever router pack runs first). */
export function extractLinks(ctx: FileContext) {
  if (linksDone.has(ctx)) return;
  linksDone.add(ctx);
  const sfc = ctx.fns.find((f) => f.node.attrs.sfc);
  const owners = new Map<Node, FnInfo>(ctx.fns.map((f) => [f.body, f]));
  const seen = new Set<string>();
  const add = (src: string, dstKey: string, line: number, optional = false, pos?: number) => {
    const sig = `${src}|${dstKey}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    ctx.edge({ src, kind: "navigates", dstKey, line, attrs: { label: dstKey.replace(/^route(name)?:/, ""), ...(optional ? { optional: true } : {}), ...(pos !== undefined ? { pos } : {}) } });
  };
  for (const el of ctx.sf.getDescendants()) {
    if (!Node.isJsxOpeningElement(el) && !Node.isJsxSelfClosingElement(el)) continue;
    const attrs = LINK_TAGS[el.getTagNameNode().getText()];
    if (!attrs) continue;
    for (const a of el.getAttributes()) {
      if (!Node.isJsxAttribute(a) || !attrs.includes(a.getNameNode().getText())) continue;
      const key = linkKey(attrValue(a));
      const owner = key && (ownerOf(owners, el) ?? sfc);
      if (key && owner) add(owner.node.id, key, el.getStartLineNumber());
    }
  }
  for (const cs of ctx.calls) {
    const recv = cs.segments.length > 1 ? cs.segments[cs.segments.length - 2] : cs.root ?? "";
    const isNav = NAV_CALLS.has(cs.method) || ((cs.method === "push" || cs.method === "replace") && (NAV_RECEIVER.test(recv) || /useRouter\(\)/.test(cs.callee)));
    if (!isNav) continue;
    const named = cs.method === "navigate" && cs.segments.length > 0;   // navigation.navigate("Profile")
    for (const arg of branches(cs.call.getArguments()[0])) {
      const key = linkKey(arg, named);
      if (key) add(cs.fn.node.id, key, cs.line, false, cs.call.getStart());
    }
  }
  // links kept as data: menus [{ path: PATHNAME.BILLING }] rendered with items.map(...), tab lists, redirect maps, path checks
  const inRouteDefinition = (n: Node) => n.getAncestors().some((a) => Node.isObjectLiteralExpression(a) && ROUTE_OBJECT_KEYS.some((k) => a.getProperty(k)));
  const owner = (n: Node) => ownerOf(owners, n)?.node.id ?? sfc?.node.id ?? `${ctx.repo.name}:${ctx.file}`;
  for (const p of ctx.sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (!LINK_PROPS.test(p.getName()) || inRouteDefinition(p)) continue;
    const key = linkKey(p.getInitializer());
    if (key) add(owner(p), key, p.getStartLineNumber(), true);
  }
  const startsWithRouteConst = (t: Node) => {
    const e = Node.isTemplateExpression(t) && !t.getHead().getLiteralText() ? t.getTemplateSpans()[0]?.getExpression() : undefined;
    return !!e && Node.isPropertyAccessExpression(e) && ROUTE_CONSTANTS.test(e.getExpression().getText());
  };
  for (const t of ctx.sf.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    if (!startsWithRouteConst(t) || inRouteDefinition(t)) continue;     // `${PATHNAME.STORAGE}/${id}/chat` kept in a variable
    const key = linkKey(t);
    if (key) add(owner(t), key, t.getStartLineNumber(), true);
  }
  for (const pa of ctx.sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const head = pa.getExpression();
    if (!Node.isIdentifier(head) || !ROUTE_CONSTANTS.test(head.getText()) || Node.isPropertyAccessExpression(pa.getParent()) || inRouteDefinition(pa)) continue;
    const span = pa.getParent();
    if (Node.isTemplateSpan(span) && startsWithRouteConst(span.getParent())) continue;
    add(owner(pa), `route:{const:${pa.getText()}}`, pa.getStartLineNumber(), true);
  }
  if (sfc && ctx.template) {
    for (const m of ctx.template.text.matchAll(/<(RouterLink|router-link|NuxtLink|nuxt-link|a|Link)\b([^>]*)>/g)) {
      const a = /(?:^|\s)(:?)(?:to|href)\s*=\s*(?:"([^"]*)"|\{`?([^}`]*)`?\})/.exec(m[2]);
      if (!a) continue;
      let v = (a[2] ?? a[3] ?? "").trim();
      if (a[1]) v = /^'([^']*)'$/.exec(v)?.[1] ?? (/name\s*:\s*'([^']+)'/.exec(v) ? `name:${/name\s*:\s*'([^']+)'/.exec(v)![1]}` : "");
      v = v.replace(/\$\{[^}]*\}/g, ":p");
      if (v.startsWith("name:")) add(sfc.node.id, `routename:${v.slice(5)}`, ctx.template.line(m.index!));
      else if (v.startsWith("/") && !v.startsWith("//")) add(sfc.node.id, `route:${v}`, ctx.template.line(m.index!));
    }
  }
}

// ---------- file-based routes ----------

/** One URL segment from a folder or file name, for any file router. null = not part of the URL. */
function segment(s: string): string | null {
  if (/^\(.*\)$/.test(s) && !/^\(\$/.test(s)) return null;           // (group), (marketing)
  if (s.startsWith("@")) return null;                                 // @slot (parallel routes)
  if (/^\[\[?\.\.\./.test(s) || s === "$") return "*";              // [...slug], [[...slug]], $
  const m = /^\[\[?(\w+)(?:=\w+)?\]?\]$/.exec(s) ?? /^\(?\$(\w+)\)?$/.exec(s);
  if (m) return `:${m[1]}`;                                            // [id], [[id]], [id=int], $id, ($lang)
  return s.replace(/_$/, "").replace(/\[\.\]/g, ".");
}

export function fileRoute(file: string, roots: string[], rule: FileRule): { url: string; verb: string | null } | null {
  for (const root of roots) {
    const prefix = [root, rule.dir].filter(Boolean).join("/") + "/";
    if (!file.startsWith(prefix)) continue;
    const parts = file.slice(prefix.length).split("/");
    const name = parts.pop()!;
    if (!rule.file.test(name)) return null;
    if (rule.exclude && [...parts, name].some((p) => rule.exclude!.test(p))) return null;
    let stem = name.replace(/\.(tsx|jsx|ts|js|mjs|vue|svelte|astro|mdx|md)$/, "").replace(/\+api$/, "");
    if (rule.flat && parts.length && stem !== "route") return null;     // Remix folder routes: only route.tsx counts
    let verb: string | null = null;
    const v = /\.(get|post|put|patch|delete|head|options)$/i.exec(stem);
    if (v && rule.kind === "endpoint") { verb = v[1].toUpperCase(); stem = stem.slice(0, -v[0].length); }
    const raw = [...parts, ...(rule.nameInPath && stem !== "route" ? [stem] : [])];
    const segs = (rule.flat ? raw.flatMap((p) => p.split(/(?<!\[)\.(?!\])/)) : raw)
      .filter((p) => !/^_?index$/.test(p) && !(rule.flat && p.startsWith("_")))
      .map(segment)
      .filter((p): p is string => p !== null && p !== "");
    return { url: (rule.prefix ?? "") + "/" + segs.join("/") || "/", verb };
  }
  return null;
}

function fileRoutes(ctx: FileContext, pack: RouterPack) {
  for (const rule of pack.files ?? []) {
    const hit = fileRoute(ctx.file, ctx.roots, rule);
    if (!hit) continue;
    const url = hit.url.length > 1 ? hit.url.replace(/\/$/, "") : hit.url;
    if (rule.kind === "page") {
      const id = `${ctx.repo.name}:route:${ctx.file}`;
      ctx.node({ id, kind: "Route", name: url, repo: ctx.repo.name, file: ctx.file, line: 1, attrs: { framework: pack.id, fileRoute: true } });
      ctx.edge({ src: id, kind: "renders", dstKey: `default:${ctx.repo.name}:${ctx.file}`, line: 1, attrs: { hint: ctx.file } });
      // data loaders that run for this screen: Remix loader/action in the same module, SvelteKit +page(.server).ts next to it
      for (const f of ctx.fns.filter((f) => /^(loader|action|clientLoader|clientAction|getServerSideProps|getStaticProps)$/.test(f.node.name))) {
        ctx.edge({ src: id, kind: "calls", dstKey: ctx.fnKey(f.node.name), line: f.node.line, attrs: { hint: ctx.file } });
      }
      const dir = ctx.file.slice(0, ctx.file.lastIndexOf("/") + 1);
      for (const sib of ["+page.server.ts", "+page.server.js", "+page.ts", "+page.js", "+layout.server.ts"]) {
        if (/\+page\.svelte$/.test(ctx.file) && ctx.hasFile(dir + sib)) {
          ctx.edge({ src: id, kind: "calls", dstKey: ctx.fnKey("load"), line: 1, attrs: { hint: dir + sib, optional: true } });
          ctx.edge({ src: id, kind: "calls", dstKey: ctx.fnKey("actions"), line: 1, attrs: { hint: dir + sib, optional: true } });
        }
      }
    } else {
      const handlers = rule.verbs
        ? ctx.fns.filter((f) => VERBS.includes(f.node.name) && f.node.attrs.exported).map((f) => ({ verb: f.node.name, key: ctx.fnKey(f.node.name), fn: f }))
        : [{ verb: hit.verb ?? "ALL", key: `default:${ctx.repo.name}:${ctx.file}`, fn: undefined }];
      for (const h of handlers) {
        operation(ctx, h.verb, url, h.key, h.fn?.node.line ?? 1, { framework: pack.id });
        if (h.fn) h.fn.node.name = `${h.verb} ${url}`;     // export async function GET → shown as "GET /api/users/:id"
      }
    }
    return;
  }
}

/** A REST operation handled by `handlerKey`; guards and other route-level facts go in handlerInfo (merged into the handler at load). */
export function operation(ctx: Pick<FileContext, "repo" | "file" | "node" | "edge">, verb: string, path: string, handlerKey: string, line: number, attrs: Record<string, unknown> = {}, hint = ctx.file, optional = false) {
  const norm = normalizeRestPath(path);
  const id = `${ctx.repo.name}:op:rest:${verb} ${norm}`;
  // display: /users/{id}, /users/<int:id>, /users/[id] → /users/:id
  const shown = path.replace(/\{(\w+)[^}]*\}|<(?:\w+:)?(\w+)>|\[(?:\.\.\.)?(\w+)\]/g, (_, a, b, c) => `:${a ?? b ?? c}`).replace(/\/+$/, "") || "/";
  ctx.node({
    id, kind: "Operation", name: `${verb} ${shown}`, repo: ctx.repo.name, file: ctx.file, line,
    keys: [`op:rest:${verb} ${norm}`], attrs: { protocol: "rest", type: verb, operation: path, handlerInfo: {}, ...attrs },
  });
  ctx.edge({ src: id, kind: "handles", dstKey: handlerKey, line, attrs: { hint, ...(optional ? { optional: true } : {}) } });
  return id;
}

// ---------- config-based routes ----------

/** const Billing = lazy(() => import("pages/billing")) */
function lazyImports(ctx: FileContext) {
  const map = new Map<string, string>();
  for (const d of ctx.sf.getVariableDeclarations()) {
    const text = d.getInitializer()?.getText() ?? "";
    const spec = /import\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(text)?.[1];
    if (!spec || !/lazy|loadable|Loadable|defineAsyncComponent/.test(text)) continue;
    const resolved = ctx.resolveImport(spec);
    if (resolved) map.set(d.getName(), resolved);
  }
  return map;
}

/** Link key + hint for whatever a route points at: Identifier, <Element />, lazy const, () => import("x"), import("x").then(m => m.X). */
function componentTarget(ctx: FileContext, lazy: Map<string, string>, n: Node): Pick<GraphEdge, "dstKey"> & { hint: string } | null {
  if (Node.isJsxSelfClosingElement(n)) return componentTarget(ctx, lazy, n.getTagNameNode());
  if (Node.isJsxElement(n)) return componentTarget(ctx, lazy, n.getOpeningElement().getTagNameNode());
  const text = n.getText();
  const spec = /import\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(text)?.[1];
  if (spec) {
    const resolved = ctx.resolveImport(spec);
    if (!resolved) return null;
    const member = /\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.(\w+)/.exec(text)?.[2];
    return member && member !== "default"
      ? { dstKey: ctx.fnKey(member), hint: resolved }
      : { dstKey: `default:${ctx.repo.name}:${resolved}`, hint: resolved };
  }
  if (lazy.has(text)) return { dstKey: `default:${ctx.repo.name}:${lazy.get(text)}`, hint: lazy.get(text)! };
  const t = identKey(ctx, text);
  return t ? { dstKey: t.key, hint: t.hint } : null;
}

function literalOf(n: Node | undefined): string | null {
  return n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) ? n.getLiteralValue() : null;
}

const prop = (o: ObjectLiteralExpression, k: string): Expression | undefined => {
  const p = o.getProperty(k);
  return p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
};

const join = (parent: string, child: string) => child.startsWith("/") ? child : `${parent.replace(/\/$/, "")}/${child}`.replace(/\/+/g, "/");

/** `ref` is a path with {const:X} parts when the path isn't a plain string. */
function route(ctx: FileContext, lazy: Map<string, string>, path: string | null, ref: string | null, comp: Node | undefined, line: number, attrs: Record<string, unknown>, keys: string[] = []) {
  if (path === null && ref === null) return;           // path={item.path}: a generic loop over routes defined elsewhere
  const id = `${ctx.repo.name}:route:${ctx.file}:${line}`;
  const flag = attrs.featureFlag ?? attrs.flag;
  ctx.node({
    id, kind: "Route", name: path ?? ref!.replace(/\{const:([^}]+)\}/g, "$1"), repo: ctx.repo.name, file: ctx.file, line, keys,
    attrs: {
      ...attrs,
      ...(path === null ? { nameRef: ref } : {}),
      ...(flag ? { flag } : {}),
      ...(attrs.isAuthen ?? attrs.auth ?? attrs.private ?? attrs.requiresAuth ?? attrs.canActivate ? { auth: true } : {}),
    },
  });
  const target = comp && componentTarget(ctx, lazy, comp);
  if (target) ctx.edge({ src: id, kind: "renders", dstKey: target.dstKey, line, attrs: { hint: target.hint } });
}

function copyProps(obj: ObjectLiteralExpression) {
  const out: Record<string, string> = {};
  for (const p of COPY_PROPS) {
    const v = prop(obj, p);
    if (v) out[p] = v.getText().slice(0, 80);
  }
  return out;
}

/** `${PATHNAME.PROJECT}/:id` → "{const:PATHNAME.PROJECT}/:id" (the linker fills in constants); null for non-constant expressions. */
export function pathTemplate(n: Node | undefined): string | null {
  if (!n) return null;
  if (Node.isTemplateExpression(n)) {
    let out = n.getHead().getLiteralText();
    for (const s of n.getTemplateSpans()) {
      const e = s.getExpression();
      if (!Node.isPropertyAccessExpression(e) && !(Node.isIdentifier(e) && /^[A-Z][A-Z0-9_]*$/.test(e.getText()))) return null;
      out += `{const:${e.getText()}}` + s.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isPropertyAccessExpression(n) && /^[A-Z]/.test(n.getText()) || Node.isIdentifier(n) && /^[A-Z][A-Z0-9_]*$/.test(n.getText())) return `{const:${n.getText()}}`;
  return null;
}

/** Path of a route object including its parents' paths (nested `children`). */
function objectPath(obj: ObjectLiteralExpression): { path: string | null; ref: string | null } {
  const own = prop(obj, "path");
  const value = literalOf(own);
  if (own && value === null) return { path: null, ref: pathTemplate(own) };     // PATHNAME.X / `${PATHNAME.X}/:id`: resolved by the linker
  let path = value ?? "";
  for (let a: Node | undefined = obj.getParent(); a; a = a.getParent()) {
    if (Node.isObjectLiteralExpression(a) && literalOf(prop(a, "path")) !== null && a.getProperty("children")) {
      path = join(literalOf(prop(a, "path"))!, path);
    }
  }
  return { path: path.startsWith("/") || !path ? path || "/" : `/${path}`, ref: null };
}

function configRoutes(ctx: FileContext, rules: ConfigRules) {
  const lazy = lazyImports(ctx);
  const routeKeyOf = (obj: ObjectLiteralExpression) => {
    const name = literalOf(prop(obj, "name"));
    return name ? [`routename:${name}`] : [];
  };

  for (const obj of ctx.sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const comp = rules.componentKeys.map((k) => prop(obj, k)).find(Boolean);
    const isIndex = prop(obj, "index")?.getText() === "true";
    if (!comp || (!obj.getProperty("path") && !isIndex)) continue;
    const { path, ref } = objectPath(obj);
    route(ctx, lazy, path, ref, comp, obj.getStartLineNumber(), copyProps(obj), routeKeyOf(obj));
  }

  if (rules.jsxRoute || rules.jsxScreen) {
    for (const el of ctx.sf.getDescendants()) {
      if (!(Node.isJsxSelfClosingElement(el) || Node.isJsxOpeningElement(el))) continue;
      const tag = el.getTagNameNode().getText();
      const attr = (n: string) => {
        const a = el.getAttributes().find((x) => Node.isJsxAttribute(x) && x.getNameNode().getText() === n);
        return a && Node.isJsxAttribute(a) ? attrValue(a) : undefined;
      };
      if (rules.jsxRoute && tag === "Route") {
        const pathNode = attr("path");
        const comp = attr("element") ?? attr("component") ?? attr("Component");
        if ((!pathNode && !attr("index")) || !comp) continue;
        let path = literalOf(pathNode) ?? (pathNode ? null : "");
        if (path !== null) {
          // nested <Route path="settings"><Route path="profile" /></Route>
          for (let a: Node | undefined = el.getParent()?.getParent(); a; a = a.getParent()) {
            if (Node.isJsxElement(a) && a.getOpeningElement().getTagNameNode().getText() === "Route") {
              const p = a.getOpeningElement().getAttributes().find((x) => Node.isJsxAttribute(x) && x.getNameNode().getText() === "path");
              const pv = p && Node.isJsxAttribute(p) ? literalOf(attrValue(p)) : null;
              if (pv) path = join(pv, path);
            }
          }
          path = path.startsWith("/") ? path : `/${path}`;
        }
        route(ctx, lazy, path, path === null ? pathTemplate(pathNode) : null, comp, el.getStartLineNumber(), {});
      } else if (rules.jsxScreen && /(^|\.)Screen$/.test(tag)) {
        const name = literalOf(attr("name"));
        const comp = attr("component") ?? attr("getComponent");
        if (name) route(ctx, lazy, name, null, comp, el.getStartLineNumber(), { screen: true });
      }
    }
  }

  for (const call of ctx.sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    if (rules.screensObject && /^create\w*Navigator$/.test(callee)) {
      const cfg = call.getArguments()[0];
      const screens = cfg && Node.isObjectLiteralExpression(cfg) ? prop(cfg, "screens") : undefined;
      if (screens && Node.isObjectLiteralExpression(screens)) {
        for (const p of screens.getProperties()) {
          if (!Node.isPropertyAssignment(p)) continue;
          const v = p.getInitializerOrThrow();
          const comp = Node.isObjectLiteralExpression(v) ? prop(v, "screen") : v;
          route(ctx, lazy, p.getName(), null, comp, p.getStartLineNumber(), { screen: true });
        }
      }
    }
    if (rules.fileRouteCall && /^create(File|Lazy)?Route$/.test(callee)) {
      // createFileRoute("/posts/$postId")({ component: Post })
      const path = literalOf(call.getArguments()[0]);
      const outer = call.getParent();
      const opts = outer && Node.isCallExpression(outer) && outer.getExpression() === call ? outer.getArguments()[0] : undefined;
      if (path !== null && opts && Node.isObjectLiteralExpression(opts)) route(ctx, lazy, fileSegments(path), null, prop(opts, "component"), call.getStartLineNumber(), { framework: "tanstack-router" });
    }
    if (rules.routeCalls && (callee === "route" || callee === "index")) {
      // React Router 7 framework mode: route("about", "routes/about.tsx"), index("routes/home.tsx"), prefix("x", [...])
      const args = call.getArguments();
      const path = callee === "index" ? "" : literalOf(args[0]);
      const file = literalOf(callee === "index" ? args[0] : args[1]);
      if (path === null || !file) continue;
      let full = path;
      for (let a: Node | undefined = call.getParent(); a; a = a.getParent()) {
        if (Node.isCallExpression(a) && /^(route|prefix)$/.test(a.getExpression().getText()) && a !== call) {
          const p = literalOf(a.getArguments()[0]);
          if (p) full = join(p, full);
        }
      }
      const resolved = ctx.resolveImport(file.startsWith(".") ? file : `./${file}`);
      const id = `${ctx.repo.name}:route:${ctx.file}:${call.getStartLineNumber()}`;
      ctx.node({ id, kind: "Route", name: full.startsWith("/") ? full : `/${full}`, repo: ctx.repo.name, file: ctx.file, line: call.getStartLineNumber(), attrs: { framework: "react-router" } });
      if (resolved) ctx.edge({ src: id, kind: "renders", dstKey: `default:${ctx.repo.name}:${resolved}`, line: call.getStartLineNumber(), attrs: { hint: resolved } });
    }
  }

  if (rules.angularComponents) {
    // @Component classes are the screens' components; their methods run in them
    for (const cls of ctx.classes.values()) {
      const dec = cls.decorators.find((d) => d.name === "Component");
      if (!dec) continue;
      const node = ctx.node({ id: `${ctx.repo.name}:${ctx.file}#${cls.name}`, kind: "Component", name: cls.name, repo: ctx.repo.name, file: ctx.file, line: cls.line, keys: [ctx.fnKey(cls.name)], attrs: { exported: true } });
      for (const f of ctx.fns.filter((f) => f.cls === cls)) ctx.edge({ src: node.id, kind: "calls", dstKey: ctx.fnKey(f.node.name), line: f.node.line, attrs: { hint: ctx.file } });
      for (const m of dec.args.join(" ").matchAll(/routerLink\s*=\s*["'](\/[^"']*)["']/g)) ctx.edge({ src: node.id, kind: "navigates", dstKey: `route:${m[1]}`, line: dec.line, attrs: { label: m[1] } });
    }
  }
}

/** TanStack / Remix style path: /posts/$postId → /posts/:postId */
function fileSegments(path: string) {
  return "/" + path.split("/").filter(Boolean).map(segment).filter((s): s is string => !!s && !s.startsWith("_")).join("/");
}

// ---------- server actions (Next.js) ----------

function serverActions(ctx: FileContext) {
  const fileLevel = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(ctx.sf.getFullText());
  for (const f of ctx.fns) {
    const own = /^[^{]*\{\s*['"]use server['"]/.test(f.body.getText());
    if (!(fileLevel ? f.node.attrs.exported && !f.cls : own)) continue;
    const id = `${ctx.repo.name}:op:action:${ctx.file}#${f.node.name}`;
    ctx.node({ id, kind: "Operation", name: `action ${f.node.name}`, repo: ctx.repo.name, file: ctx.file, line: f.node.line, keys: [`op:action:${f.node.name}`], attrs: { protocol: "action", type: "action", operation: f.node.name, handlerInfo: {} } });
    ctx.edge({ src: id, kind: "handles", dstKey: ctx.fnKey(f.node.name), line: f.node.line, attrs: { hint: ctx.file } });
    f.node.attrs.serverAction = id;
  }
}

export function routerPlugin(pack: RouterPack): FlowMapPlugin {
  return {
    id: pack.id,
    detect: (pkg) => pack.deps.some((d) => !!(pkg.dependencies?.[d] ?? pkg.devDependencies?.[d])),
    extract(ctx) {
      fileRoutes(ctx, pack);
      if (pack.config) configRoutes(ctx, pack.config);
      if (pack.serverActions) serverActions(ctx);
      extractLinks(ctx);
    },
    derive: pack.serverActions ? (g) => {
      // calling a server action from a component is a request to that API
      for (const n of g.nodes.values()) {
        if (!n.attrs.serverAction) continue;
        for (const e of g.inEdges(n.id, ["calls"])) {
          if (g.nodes.get(e.src)?.attrs.serverAction) continue;
          g.addEdge({ src: e.src, dst: n.attrs.serverAction, dstKey: `op:action:${n.name}`, kind: "requests", repo: e.repo, file: e.file, line: e.line, attrs: { label: `action ${n.name}` } });
        }
      }
    } : undefined,
  };
}

