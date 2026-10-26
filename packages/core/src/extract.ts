import { Node, SyntaxKind, type SourceFile, type ClassDeclaration, type CallExpression, type Decorator, type VariableDeclaration } from "ts-morph";
import type { CallSite, ClassInfo, DecoratorInfo, FieldInfo, FileContext, FnInfo, GraphEdge, GraphNode, ImportInfo, ParamInfo } from "./types.ts";
import { jsxUi, templateUi, type UiEl } from "./ui.ts";

export const DEFAULT_EXTERNALS: Record<string, string> = {
  Stripe: "Stripe",
  S3: "S3", S3Client: "S3",
  SQS: "SQS", SQSClient: "SQS",
  SNS: "SNS", SNSClient: "SNS",
  SES: "Mail", SESClient: "Mail", SESv2Client: "Mail", Transporter: "Mail", MailerService: "Mail",
  HttpService: "HTTP", AxiosInstance: "HTTP", axios: "HTTP", fetch: "HTTP", got: "HTTP",
  WebClient: "Slack", PostHog: "PostHog", Redis: "Redis", OpenAI: "OpenAI", Anthropic: "Anthropic",
};

const READ_METHOD = /^(get|list|retrieve|find|fetch|search|head|describe|count|exists?|is|has|check|validate|verify|calculate|compute|preview|construct|parse|build|sign|presign|generatePresigned|getSigned)/i;
export const isWriteMethod = (method: string) => !READ_METHOD.test(method.split(".").pop() ?? method);

const LOOP_KINDS = new Set([SyntaxKind.ForStatement, SyntaxKind.ForOfStatement, SyntaxKind.ForInStatement, SyntaxKind.WhileStatement, SyntaxKind.DoStatement]);
const ITERATORS = new Set(["forEach", "map", "flatMap", "filter", "reduce", "some", "every", "find"]);

export function decoratorInfo(d: Decorator): DecoratorInfo {
  return { name: d.getName(), args: d.getArguments().map((a) => a.getText()), line: d.getStartLineNumber() };
}

function typeParts(text: string | undefined): { typeName: string | null; typeArgs: string[] } {
  if (!text) return { typeName: null, typeArgs: [] };
  const m = /^([\w.]+)\s*(?:<(.+)>)?/.exec(text.trim());
  if (!m) return { typeName: null, typeArgs: [] };
  return { typeName: m[1].split(".").pop()!, typeArgs: m[2] ? m[2].split(",").map((s) => s.trim()) : [] };
}

function classInfo(c: ClassDeclaration): ClassInfo {
  const fields = new Map<string, FieldInfo>();
  for (const p of c.getProperties()) {
    const init = p.getInitializer();
    const typeText = p.getTypeNode()?.getText() ?? (init && Node.isNewExpression(init) ? init.getExpression().getText() : undefined);
    fields.set(p.getName(), { name: p.getName(), ...typeParts(typeText), decorators: p.getDecorators().map(decoratorInfo) });
  }
  for (const ctor of c.getConstructors()) {
    for (const p of ctor.getParameters()) {
      if (!p.isParameterProperty() && !p.getDecorators().length) continue;
      fields.set(p.getName(), { name: p.getName(), ...typeParts(p.getTypeNode()?.getText()), decorators: p.getDecorators().map(decoratorInfo) });
    }
  }
  return {
    name: c.getName() ?? "default",
    line: c.getStartLineNumber(),
    decorators: c.getDecorators().map(decoratorInfo),
    extends: c.getExtends()?.getText() ?? null,
    fields,
  };
}

function isFunctionLike(n: Node | undefined): boolean {
  if (!n) return false;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) return true;
  if (Node.isAsExpression(n) || Node.isSatisfiesExpression(n) || Node.isParenthesizedExpression(n)) return isFunctionLike(n.getExpression());
  // createAsyncThunk("x", async () => {}), memo(() => ...), forwardRef(...), useCallback-free wrappers
  return Node.isCallExpression(n) && n.getArguments().some((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
}

function unwrap(n: Node): Node {
  while (Node.isAsExpression(n) || Node.isSatisfiesExpression(n) || Node.isParenthesizedExpression(n)) n = n.getExpression();
  return n;
}

function flattenConstants(prefix: string, n: Node, out: [string, string][]) {
  n = unwrap(n);
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) out.push([prefix, n.getLiteralValue()]);
  else if (Node.isNumericLiteral(n)) out.push([prefix, n.getText()]);
  else if (Node.isObjectLiteralExpression(n)) {
    for (const p of n.getProperties()) {
      if (Node.isPropertyAssignment(p)) {
        const init = p.getInitializer();
        if (init) flattenConstants(`${prefix}.${p.getName().replace(/^["']|["']$/g, "")}`, init, out);
      }
    }
  }
}

function hasJsx(n: Node) {
  return n.getFirstDescendant((d) => Node.isJsxElement(d) || Node.isJsxSelfClosingElement(d) || Node.isJsxFragment(d)) !== undefined;
}

/** Walk a call expression's callee down to its root: this.repo.createQueryBuilder().getMany → root "this", segments [repo, createQueryBuilder, getMany]. */
function calleeChain(call: CallExpression) {
  const segments: string[] = [];
  let chained = false;
  let n: Node = call.getExpression();
  while (true) {
    if (Node.isPropertyAccessExpression(n)) {
      segments.unshift(n.getName());
      n = n.getExpression();
    } else if (Node.isCallExpression(n)) {
      chained = true;
      n = n.getExpression();
    } else if (Node.isNonNullExpression(n) || Node.isParenthesizedExpression(n) || Node.isAwaitExpression(n)) {
      n = n.getExpression();
    } else break;
  }
  const root = n.getKind() === SyntaxKind.ThisKeyword ? "this" : Node.isIdentifier(n) ? n.getText() : null;
  return { root, segments, chained };
}

function callContext(call: Node, boundary: Node, afterCommit: string[]) {
  let inLoop = false, inTx = false, after = false;
  let prev: Node = call;
  for (let a = call.getParent(); a && a !== boundary; prev = a, a = a.getParent()) {
    if (LOOP_KINDS.has(a.getKind())) {
      // the loop body (not its iterable expression) counts
      if (!(Node.isForOfStatement(a) || Node.isForInStatement(a)) || prev !== a.getExpression()) inLoop = true;
    }
    if ((Node.isArrowFunction(a) || Node.isFunctionExpression(a)) && Node.isCallExpression(a.getParent())) {
      const outer = a.getParent() as CallExpression;
      const expr = outer.getExpression();
      const name = Node.isPropertyAccessExpression(expr) ? expr.getName() : Node.isIdentifier(expr) ? expr.getText() : "";
      if (ITERATORS.has(name)) inLoop = true;
      if (name === "transaction" || name === "$transaction") inTx = true;
      if (afterCommit.includes(name)) after = true;
    }
  }
  return { inLoop, inTx, afterCommit: after };
}

const TEST_CALLS = /^(describe|it|test|context|suite|beforeEach|afterEach|beforeAll|afterAll)$/;
const REQUEST_PARAM = /^(req|request|event|ctx|c|context)$/;
const ACTOR = /\b(?:req|request)\.(?:user|auth|session)\b|ctx\.state\.user|c\.get\(\s*['"](?:user|jwtPayload|session)['"]|res\.locals\.user|event\.context\.(?:user|auth|session)|locals\.user/;
const AUTH_CALL = /\b(auth|getServerSession|getSession|currentUser|getUser|requireAuth|requireUser|requireSession|verifyToken|getAuth|validateRequest|getToken)\s*\(/g;
const AUTH_CALL_ONE = new RegExp(AUTH_CALL.source);
const ID_READ = /\b(?:params|query|body)\??\.(id|\w*Id|\w*_id)\b|\bparam\(\s*['"](id|\w*Id)['"]/g;
const ID_DESTRUCTURE = /\{([\w\s,:]+)\}\s*=\s*(?:await\s+)?(?:req|request|ctx|c\.req|context)\.(?:params|query|body)\b/g;
export const VALIDATES = /\.(?:parse|safeParse|parseAsync|safeParseAsync|validate|validateSync)\(|zValidator|celebrate|Joi\.|yup\.|ajv|typia\./;
// anywhere in a function: it looks at who is calling (directly, or via a request-context store)
const USES_ACTOR = new RegExp(`${ACTOR.source}|${AUTH_CALL.source}|\\bcls\\w*\\.get\\(\\s*['"](?:user|actor)`);
// it checks the sender (webhooks: Stripe constructEvent, HMAC compare, svix, or a shared token/signature header)
const VERIFIES = /constructEvent|createHmac|timingSafeEqual|verify\w*(?:Signature|Webhook|Hmac)|validate\w*(?:Signature|Webhook)|webhooks?\.(?:verify|unwrap)|new\s+Webhook\(|\.verify\(|['"`][\w-]*(?:token|signature|secret|hmac)['"`]\s*\]/i;
// a catch-all error handler: thrown Errors are mapped to a response somewhere central
const CATCH_ALL = /@Catch\(\s*\)|\(\s*err\w*\s*(?::[^,()]+)?,\s*req\w*\s*(?::[^,()]+)?,\s*res\w*\s*(?::[^,()]+)?,\s*next\b|\.setErrorHandler\(|\.onError\(/;
const BODY_READ = /\b(?:req|request)\.body\b|\b(?:request|req)\.json\(\)|c\.req\.json\(\)|readBody\(/;

/** How a function that receives an HTTP request uses it (who is calling, which ids it reads, whether input is validated). */
function httpUsage(text: string) {
  const authCalls = [...new Set([...text.matchAll(AUTH_CALL)].map((m) => `${m[1]}()`))];
  const ids = new Set<string>();
  for (const m of text.matchAll(ID_READ)) ids.add(m[1] ?? m[2]);
  for (const m of text.matchAll(ID_DESTRUCTURE)) m[1].split(",").map((x) => x.split(":")[0].trim()).filter((x) => /^id$|Id$|_id$/.test(x)).forEach((x) => ids.add(x));
  return { actor: ACTOR.test(text) || authCalls.length > 0, authCalls, ids: [...ids], validates: VALIDATES.test(text), readsBody: BODY_READ.test(text) };
}

/** Edge attrs every call site carries. pos: where the call starts, so a screen element's handler finds exactly its own calls. */
export const flags = (cs: { inLoop: boolean; inTx: boolean; afterCommit: boolean; call?: { getStart(): number } }) =>
  ({ ...(cs.inLoop ? { inLoop: true } : {}), ...(cs.inTx ? { inTx: true } : {}), ...(cs.afterCommit ? { afterCommit: true } : {}), ...(cs.call ? { pos: cs.call.getStart() } : {}) });

const isFnLiteral = (n: Node | undefined) => !!n && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));

/**
 * `component`: name of the synthetic component for a single-file component (.vue/.svelte/.astro):
 * its top-level script code, template tags and links belong to it.
 */
export function buildFileContext(
  sf: SourceFile,
  base: Pick<FileContext, "repo" | "file" | "config" | "resolveImport" | "roots" | "hasFile" | "template">,
  component?: string,
): { ctx: FileContext; nodes: GraphNode[]; edges: GraphEdge[]; constants: [string, string][]; ui: [string, UiEl][] } {
  const { repo, file } = base;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const constants: [string, string][] = [];
  const isJsxFile = /\.[jt]sx$/.test(file);

  const imports = new Map<string, ImportInfo>();
  for (const d of sf.getImportDeclarations()) {
    const spec = d.getModuleSpecifierValue();
    const resolved = base.resolveImport(spec);
    const def = d.getDefaultImport();
    if (def) imports.set(def.getText(), { spec, resolved, imported: "default" });
    const ns = d.getNamespaceImport();
    if (ns) imports.set(ns.getText(), { spec, resolved, imported: "*" });
    for (const ni of d.getNamedImports()) imports.set(ni.getAliasNode()?.getText() ?? ni.getName(), { spec, resolved, imported: ni.getName() });
  }

  const ctx: FileContext = {
    ...base,
    sf,
    fns: [],
    classes: new Map(),
    calls: [],
    imports,
    meta: {},
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

  const addFn = (name: string, decl: Node, body: Node, cls: ClassInfo | null, methodName: string, decorators: DecoratorInfo[], params: ParamInfo[], exported: boolean, isDefault = false, idSuffix = "") => {
    const isComponent = isJsxFile && /^[A-Z]/.test(methodName) && !cls && hasJsx(body);
    const node = ctx.node({
      id: `${repo.name}:${file}#${name}${idSuffix}`,
      kind: isComponent ? "Component" : "Function",
      name,
      repo: repo.name,
      file,
      line: decl.getStartLineNumber(),
      endLine: decl.getEndLineNumber(),
      keys: [ctx.fnKey(name)],
      attrs: {
        loc: decl.getEndLineNumber() - decl.getStartLineNumber() + 1,
        exported,
        ...(cls ? { className: cls.name } : {}),
        ...(decorators.length ? { decorators: decorators.map((d) => d.name) } : {}),
      },
    });
    if (isDefault) node.keys.push(`default:${repo.name}:${file}`);
    const rawThrows = body.getDescendantsOfKind(SyntaxKind.ThrowStatement)
      .filter((t) => { const e = t.getExpression(); return Node.isNewExpression(e) && e.getExpression().getText() === "Error"; })
      .map((t) => t.getStartLineNumber());
    if (rawThrows.length) node.attrs.rawThrows = rawThrows;
    if (Node.isMethodDeclaration(decl) || Node.isFunctionDeclaration(decl) || Node.isArrowFunction(decl)) {
      if ((decl as any).isAsync?.()) node.attrs.async = true;
    }
    const text = body.getText();
    if (USES_ACTOR.test(text)) node.attrs.actor = true;
    if (VERIFIES.test(text)) node.attrs.verifies = true;
    if (params.some((p) => REQUEST_PARAM.test(p.name)) || /^(GET|POST|PUT|PATCH|DELETE)$/.test(methodName) || AUTH_CALL_ONE.test(text)) node.attrs.http = httpUsage(text);
    ctx.fns.push({ node, cls, methodName, decorators, params, body });
  };

  const paramsOf = (fnNode: Node): ParamInfo[] =>
    (Node.isMethodDeclaration(fnNode) || Node.isFunctionDeclaration(fnNode) || Node.isArrowFunction(fnNode) || Node.isFunctionExpression(fnNode))
      ? fnNode.getParameters().map((p) => {
          const tn = p.getTypeNode();
          return { name: p.getName(), type: tn?.getText().slice(0, 120) ?? "", typeIsLiteral: !!tn && Node.isTypeLiteral(tn), decorators: p.getDecorators().map(decoratorInfo) };
        })
      : [];

  for (const c of sf.getClasses()) {
    const info = classInfo(c);
    ctx.classes.set(info.name, info);
    const parent = info.extends?.match(/^[\w.]+/)?.[0].split(".").pop();
    if (parent) constants.push([`__extends:${info.name}`, parent]);
    for (const m of c.getMethods()) {
      const body = m.getBody();
      if (!body) continue;
      addFn(`${info.name}.${m.getName()}`, m, body, info, m.getName(), m.getDecorators().map(decoratorInfo), paramsOf(m), c.isExported(), false);
    }
  }

  for (const f of sf.getFunctions()) {
    const body = f.getBody();
    if (!body) continue;
    const name = f.getName() ?? sf.getBaseNameWithoutExtension();
    addFn(name, f, body, null, name, [], paramsOf(f), f.isExported(), f.isDefaultExport());
  }

  for (const vs of sf.getVariableStatements()) {
    for (const d of vs.getDeclarations()) {
      const init = d.getInitializer();
      if (!init) continue;
      const name = d.getName();
      const inner = unwrap(init);
      if (isFunctionLike(init)) {
        const fnNode = Node.isCallExpression(inner) ? inner.getArguments().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a)) ?? inner : inner;
        addFn(name, d, init, null, name, [], paramsOf(fnNode), vs.isExported());
      } else if (Node.isObjectLiteralExpression(inner)) {
        for (const p of inner.getProperties()) {
          if (Node.isMethodDeclaration(p) && p.getBody()) addFn(`${name}.${p.getName()}`, p, p.getBody()!, null, p.getName(), [], paramsOf(p), vs.isExported());
          else if (Node.isPropertyAssignment(p) && isFunctionLike(p.getInitializer())) addFn(`${name}.${p.getName()}`, p, p.getInitializer()!, null, p.getName(), [], paramsOf(unwrap(p.getInitializer()!)), vs.isExported());
        }
      }
      if (vs.getDeclarationKind() === "const") flattenConstants(name, init, constants);
    }
  }
  for (const e of sf.getEnums()) {
    for (const m of e.getMembers()) {
      const v = m.getInitializer();
      if (v) flattenConstants(`${e.getName()}.${m.getName()}`, v, constants);
    }
  }

  // handlers passed inline at statement level: app.get("/users", async (req, res) => {...}), router.post("/x", auth, (req, res) => ...)
  for (const st of sf.getDescendantsOfKind(SyntaxKind.ExpressionStatement)) {
    const call = unwrap(st.getExpression());
    const inner = Node.isAwaitExpression(call) ? call.getExpression() : call;
    if (!Node.isCallExpression(inner)) continue;
    const callee = inner.getExpression().getText();
    if (TEST_CALLS.test(callee) || callee.length > 80) continue;
    const args = inner.getArguments();
    const first = args[0];
    let label: string | null = null;
    let fnArg: Node | undefined;
    if (first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))) {
      label = first.getLiteralValue();
      const last = args[args.length - 1];
      // the handler, possibly wrapped: asyncHandler(async (req, res) => ...)
      fnArg = [...args].reverse().find(isFnLiteral) ?? (last && Node.isCallExpression(last) ? last.getArguments().find(isFnLiteral) : undefined);
    } else if (first && Node.isObjectLiteralExpression(first) && args.length === 1) {
      // fastify.route({ method, url, handler })
      const url = first.getProperty("url") ?? first.getProperty("path");
      const handler = first.getProperty("handler");
      if (url && Node.isPropertyAssignment(url) && handler && Node.isPropertyAssignment(handler)) {
        label = url.getInitializerOrThrow().getText().replace(/^['"`]|['"`]$/g, "");
        fnArg = handler.getInitializer();
        if (!isFnLiteral(fnArg)) fnArg = undefined;
      }
    }
    if (label === null || !fnArg) continue;
    addFn(`${callee} ${label}`, st, fnArg, null, label, [], paramsOf(fnArg), false, false, `@${st.getStartLineNumber()}`);
  }

  // default export by name: export default Foo
  const defaultExport = sf.getExportAssignment((a) => !a.isExportEquals());
  const fileStem = file.replace(/\.[^./]+$/, "");
  if (defaultExport && isFunctionLike(defaultExport.getExpression()) && !Node.isIdentifier(unwrap(defaultExport.getExpression()))) {
    // export default defineEventHandler(async (event) => ...) / export default async (req, res) => ...
    const expr = defaultExport.getExpression();
    const inner = unwrap(expr);
    const fnNode = Node.isCallExpression(inner) ? inner.getArguments().find(isFnLiteral) ?? inner : inner;
    addFn(fileStem, defaultExport, expr, null, fileStem.split("/").pop()!, [], paramsOf(fnNode), true, true);
  } else if (defaultExport && component) {
    // Vue options API: export default { methods: { save() {} }, setup() {} } / defineComponent({...})
    const inner = unwrap(defaultExport.getExpression());
    const obj = Node.isCallExpression(inner) ? inner.getArguments()[0] : inner;
    if (obj && Node.isObjectLiteralExpression(obj)) {
      const collect = (o: Node, depth: number) => {
        if (!Node.isObjectLiteralExpression(o)) return;
        for (const p of o.getProperties()) {
          if (Node.isMethodDeclaration(p) && p.getBody()) addFn(`${component}.${p.getName()}`, p, p.getBody()!, null, p.getName(), [], paramsOf(p), true);
          else if (Node.isPropertyAssignment(p)) {
            const init = p.getInitializer();
            if (isFunctionLike(init)) addFn(`${component}.${p.getName()}`, p, init!, null, p.getName(), [], paramsOf(unwrap(init!)), true);
            else if (init && depth < 1) collect(init, depth + 1);
          }
        }
      };
      collect(obj, 0);
    }
  } else if (defaultExport) {
    const name = defaultExport.getExpression().getText();
    const target = ctx.fns.find((f) => f.node.name === name) ?? (() => {
      // export default connect(...)(Foo) / memo(Foo): pick the innermost identifier that is a local fn
      const ids = defaultExport.getExpression().getDescendantsOfKind(SyntaxKind.Identifier).map((i) => i.getText());
      return ctx.fns.find((f) => ids.includes(f.node.name));
    })();
    if (target) target.node.keys.push(`default:${repo.name}:${file}`);
    else {
      const cls = ctx.classes.get(name);
      if (cls) ctx.fns.filter((f) => f.cls === cls).forEach((f) => f.node.keys.push(`default:${repo.name}:${file}#${f.methodName}`));
    }
  }

  // single-file component: the script's top level and the template belong to one synthetic component
  let sfc: FnInfo | undefined;
  if (component) {
    const node = ctx.node({
      id: `${repo.name}:${file}#${component}`, kind: "Component", name: component, repo: repo.name, file, line: 1, endLine: sf.getEndLineNumber(),
      keys: [ctx.fnKey(component), `default:${repo.name}:${file}`], attrs: { loc: sf.getEndLineNumber(), exported: true, sfc: true },
    });
    for (const f of ctx.fns) ctx.edge({ src: node.id, kind: "calls", dstKey: ctx.fnKey(f.node.name), line: f.node.line, attrs: { hint: file } });
    sfc = { node, cls: null, methodName: component, decorators: [], params: [], body: sf };
  }

  // call sites, each owned by the innermost function around it
  const owners = new Map<Node, FnInfo>(ctx.fns.map((f) => [f.body, f]));
  if (sfc) owners.set(sf, sfc);
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    let fn: FnInfo | undefined;
    for (let a = call.getParent(); a && !fn; a = a.getParent()) fn = owners.get(a);
    if (!fn) continue;
    const { root, segments, chained } = calleeChain(call);
    const method = segments.length ? segments[segments.length - 1] : root ?? "";
    if (!method) continue;
    const field = root === "this" && fn.cls && segments.length > 1 ? fn.cls.fields.get(segments[0]) ?? null : null;
    ctx.calls.push({
      fn, call, line: call.getStartLineNumber(),
      callee: call.getExpression().getText().slice(0, 200),
      root, segments, chained, method, field,
      ...callContext(call, fn.body, base.config.afterCommit),
      claimed: false,
    });
  }
  if (sfc) ctx.fns.push(sfc);

  // per-file facts for rules (suppressions, imports, exports)
  const suppressions: { line: number; rule: string; reason: string }[] = [];
  sf.getFullText().split("\n").forEach((l, i) => {
    const m = /\/\/\s*flowmap-ignore\s+([\w-]+)(?:\s*:\s*(.+))?/.exec(l);
    if (m) suppressions.push({ line: i + 1, rule: m[1], reason: (m[2] ?? "").trim() });
  });
  const exportsList = new Set<string>();
  let exportStar = false;
  for (const s of sf.getStatements()) {
    if (Node.isExportDeclaration(s)) {
      if (!s.getNamedExports().length) exportStar = true;
      s.getNamedExports().forEach((e) => exportsList.add(e.getAliasNode()?.getText() ?? e.getName()));
    } else if (Node.isVariableStatement(s) && s.isExported()) {
      for (const d of s.getDeclarations()) {
        const nameNode = d.getNameNode();
        if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
          nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).forEach((b) => exportsList.add(b.getName()));
        } else exportsList.add(d.getName());
      }
    }
    else if ((Node.isFunctionDeclaration(s) || Node.isClassDeclaration(s) || Node.isInterfaceDeclaration(s) || Node.isTypeAliasDeclaration(s) || Node.isEnumDeclaration(s)) && s.isExported()) {
      const n = s.getName();
      if (n) exportsList.add(n);
      if (s.isDefaultExport()) exportsList.add("default");
    }
  }
  if (defaultExport || component) exportsList.add("default");   // a single-file component is always the default export
  ctx.meta = {
    ...(CATCH_ALL.test(sf.getFullText()) ? { errorHandler: true } : {}),
    suppressions,
    exports: [...exportsList],
    exportStar,
    imports: [...new Map([...sf.getImportDeclarations()].map((d) => [d.getModuleSpecifierValue(), d])).values()].map((d) => ({
      spec: d.getModuleSpecifierValue(),
      line: d.getStartLineNumber(),
      resolved: base.resolveImport(d.getModuleSpecifierValue()),
      names: [...(d.getDefaultImport() ? ["default"] : []), ...d.getNamedImports().filter((n) => !n.isTypeOnly() && !d.isTypeOnly()).map((n) => n.getName())],
    })),
  };

  // rough wireframe per component (screens are stitched together from these at query time)
  const ui: [string, UiEl][] = [];
  for (const fn of ctx.fns) {
    if (fn.node.kind !== "Component") continue;
    const tree = fn.node.attrs.sfc && base.template
      ? templateUi(base.template, (tag) => !!ctx.imports.get(tag)?.resolved || ctx.fns.some((f) => f.node.name === tag))
      : fn.node.attrs.sfc ? null : jsxUi(ctx, fn);
    if (tree) ui.push([fn.node.id, tree]);
  }

  return { ctx, nodes, edges, constants, ui };
}

/** Edges for call sites no plugin claimed: internal function calls, renders, and well-known external clients. */
export function emitDefaultEdges(ctx: FileContext, externals: Record<string, string>) {
  const { repo } = ctx;
  const localFns = new Set(ctx.fns.map((f) => f.node.name));
  const base = (cs: CallSite) => ({ src: cs.fn.node.id, line: cs.line });
  const importKey = (imp: ImportInfo, member?: string) => {
    if (imp.imported === "default") return member ? `default:${repo.name}:${imp.resolved}#${member}` : `default:${repo.name}:${imp.resolved}`;
    if (imp.imported === "*") return ctx.fnKey(member ?? "");
    return ctx.fnKey(member ? `${imp.imported}.${member}` : imp.imported);
  };

  // variables holding an outside client: const stripe = new Stripe(key) (module level or inside the function)
  const clientLabel = (d: VariableDeclaration, known: Map<string, string>) => {
    const typeName = d.getTypeNode()?.getText().split("<")[0].split(".").pop();
    let init = d.getInitializer();
    while (init && (Node.isAwaitExpression(init) || Node.isParenthesizedExpression(init) || Node.isAsExpression(init))) init = init.getExpression();
    let label = typeName ? externals[typeName] : undefined;
    if (!label && init && Node.isNewExpression(init)) label = externals[init.getExpression().getText().split(".").pop()!];
    if (!label && init && Node.isCallExpression(init)) {
      const src = ctx.calls.find((c) => c.call === init);
      label = (src?.field?.typeName && externals[src.field.typeName]) || (src?.root && src.root !== "this" ? known.get(src.root) : undefined);
    }
    return label;
  };
  const moduleClients = new Map<string, string>();
  const moduleUnknown = new Map<string, string>();         // const resend = new Resend(key) from a package FlowMap doesn't know
  for (const vs of ctx.sf.getVariableStatements()) {
    for (const d of vs.getDeclarations()) {
      if (!Node.isIdentifier(d.getNameNode())) continue;
      const label = clientLabel(d, moduleClients);
      if (label) moduleClients.set(d.getName(), label);
      const init = d.getInitializer();
      const cls = init && Node.isNewExpression(init) ? init.getExpression().getText() : null;
      const imp = cls ? ctx.imports.get(cls.split(".")[0]) : undefined;
      if (!label && cls && imp && !imp.resolved) moduleUnknown.set(d.getName(), `${imp.spec}#${cls}`);
    }
  }
  const localClients = new Map<FnInfo, Map<string, string>>();
  const clientsOf = (fn: FnInfo) => {
    let m = localClients.get(fn);
    if (m) return m;
    m = new Map(moduleClients);
    for (const d of fn.body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const label = clientLabel(d, m);
      if (label && Node.isIdentifier(d.getNameNode())) m.set(d.getName(), label);
    }
    localClients.set(fn, m);
    return m;
  };

  // calls into packages FlowMap doesn't know (for setup suggestions: maybe an outside service)
  const unknown: Record<string, number> = {};
  const note = (pkg: string) => { unknown[pkg] = (unknown[pkg] ?? 0) + 1; };

  for (const cs of ctx.calls) {
    if (cs.claimed) continue;
    const ext = (label: string, method: string) =>
      ctx.edge({ ...base(cs), kind: "calls_external", dstKey: `ext:${label}`, attrs: { ...flags(cs), method, write: isWriteMethod(method), label } });

    if (cs.root === "this" && cs.segments.length === 1 && cs.fn.cls) {
      ctx.edge({ ...base(cs), kind: "calls", dstKey: ctx.fnKey(`${cs.fn.cls.name}.${cs.method}`), attrs: { ...flags(cs), hint: ctx.file } });
    } else if (cs.field && cs.field.typeName) {
      const t = cs.field.typeName;
      const rest = cs.segments.slice(1);
      const label = externals[t];
      // this.client.getX().y() is recorded once, by the outer call
      if (label && !Node.isPropertyAccessExpression(cs.call.getParent())) ext(label, rest.join("."));
      const imp = ctx.imports.get(t);
      if (!label && imp && !imp.resolved) note(`${imp.spec}#${t}`);
      const internal = ctx.classes.has(t) ? ctx.file : imp?.resolved;
      if (internal && rest.length && !cs.chained) {
        ctx.edge({ ...base(cs), kind: "calls", dstKey: ctx.fnKey(`${t}.${rest[0]}`), attrs: { ...flags(cs), hint: internal, ...(label ? { label } : {}) } });
      }
    } else if (cs.root && cs.root !== "this" && cs.segments.length && clientsOf(cs.fn).has(cs.root)) {
      ext(clientsOf(cs.fn).get(cs.root)!, cs.segments.join("."));
    } else if (cs.root && cs.root !== "this") {
      const imp = ctx.imports.get(cs.root);
      const label = externals[cs.root] ?? (imp && !imp.resolved ? externals[imp.imported] : undefined);
      if (label && (!imp || !imp.resolved) && !cs.chained) {
        ext(label, cs.segments.join(".") || cs.root);
      } else if (imp && !imp.resolved && cs.segments.length) {
        note(`${imp.spec}#${cs.root}`);
      } else if (moduleUnknown.has(cs.root) && cs.segments.length) {
        note(moduleUnknown.get(cs.root)!);
      } else if (cs.segments.length === 0 && localFns.has(cs.root)) {
        ctx.edge({ ...base(cs), kind: "calls", dstKey: ctx.fnKey(cs.root), attrs: { ...flags(cs), hint: ctx.file } });
      } else if (imp?.resolved && !cs.chained) {
        const member = cs.segments.length ? cs.segments.join(".") : undefined;
        ctx.edge({ ...base(cs), kind: "calls", dstKey: importKey(imp, member), attrs: { ...flags(cs), hint: imp.resolved } });
      } else if (cs.segments.length === 1 && localFns.has(`${cs.root}.${cs.method}`)) {
        ctx.edge({ ...base(cs), kind: "calls", dstKey: ctx.fnKey(`${cs.root}.${cs.method}`), attrs: { ...flags(cs), hint: ctx.file } });
      }
    }
  }

  if (Object.keys(unknown).length) ctx.meta.unknownCalls = unknown;

  // <Child /> renders edges for components
  for (const fn of ctx.fns) {
    if (fn.node.kind !== "Component") continue;
    const seen = new Set<string>();
    for (const el of fn.body.getDescendants()) {
      if (!Node.isJsxOpeningElement(el) && !Node.isJsxSelfClosingElement(el)) continue;
      const tag = el.getTagNameNode().getText();
      const head = tag.split(".")[0];
      if (!/^[A-Z]/.test(head) || seen.has(tag)) continue;
      seen.add(tag);
      const imp = ctx.imports.get(head);
      const dstKey = localFns.has(tag) ? ctx.fnKey(tag) : imp?.resolved ? importKey(imp, tag.includes(".") ? tag.split(".").slice(1).join(".") : undefined) : null;
      if (dstKey) ctx.edge({ src: fn.node.id, kind: "renders", dstKey, line: el.getStartLineNumber(), attrs: { hint: imp?.resolved ?? ctx.file } });
    }
  }

  // template tags of a single-file component: <UserCard>, <user-card>
  const sfc = ctx.fns.find((f) => f.node.attrs.sfc);
  if (sfc && ctx.template) {
    const seen = new Set<string>();
    for (const m of ctx.template.text.matchAll(/<([A-Z][\w.]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g)) {
      const tag = m[1].includes("-") ? m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("") : m[1];
      const imp = ctx.imports.get(tag.split(".")[0]);
      if (seen.has(tag) || !imp?.resolved) continue;
      seen.add(tag);
      ctx.edge({ src: sfc.node.id, kind: "renders", dstKey: importKey(imp), line: ctx.template.line(m.index!), attrs: { hint: imp.resolved } });
    }
  }
}
