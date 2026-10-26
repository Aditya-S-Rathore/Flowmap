import { Node, SyntaxKind, type JsxAttributeLike, type JsxElement, type JsxFragment, type JsxSelfClosingElement } from "ts-morph";
import type { UiKind } from "./api-types.ts";
import type { FileContext, FnInfo, Template } from "./types.ts";

/**
 * A rough wireframe of each component, kept per component and stitched together per screen at query time:
 * what's on it (headings, buttons, inputs, tables, child components), roughly how it's laid out, and which code
 * each button / link / form runs. Read from JSX (React, Solid, Preact…) or from .vue/.svelte/.astro templates.
 */
export interface UiEl {
  k: UiKind;
  t?: string;                       // label: text, placeholder, aria-label, i18n key
  c?: UiEl[];
  tag?: string;                     // component or element name
  line: number;
  act?: { r?: [number, number, number, number][]; fn?: string; submit?: 1 };   // handler: [first line, last line, start, end] in this file (incl. local helpers it calls), or a function's name; submit = runs on form submit
  rep?: 1;                          // rendered in a loop (.map, v-for, {#each})
  opt?: 1;                          // rendered conditionally
  cols?: number;
}

// Element kinds by tag name (HTML tags and common UI-library components, matched on the last name segment), as data.
const KINDS: [RegExp, UiKind][] = [
  [/^(h[1-6]|heading|title|pagetitle|pageheader|sectiontitle)$/i, "heading"],
  [/button$|^btn$|^fab$/i, "button"],
  [/^(a|link|navlink|routerlink|nuxtlink|anchor|router-link|nuxt-link)$/i, "link"],
  [/(checkbox|switch|toggle|radio|radiogroup)$/i, "checkbox"],
  [/(select|dropdown|combobox|autocomplete|multiselect)$/i, "select"],
  [/^(input|textarea)$|(input|field|textarea|picker|slider|upload|editor|otp)$/i, "input"],
  [/^table$|(table|datagrid|datatable)$/i, "table"],
  [/^(ul|ol)$|^(list|virtuallist|flatlist|flashlist|sectionlist|listview)$/i, "list"],
  [/(modal|dialog|drawer|sheet|popup|popover)$/i, "modal"],
  [/^tabs?$|^(tablist|segmented|segmentedcontrol)$/i, "tabs"],
  [/^(img|svg|picture|video|canvas)$|(image|img|avatar|video|thumbnail|logo|chart|map)$/i, "image"],
  [/icon$/i, "icon"],
  [/^(nav|header|footer|aside)$|(navbar|sidebar|navigation|breadcrumbs?|appbar|toolbar|menu)$/i, "nav"],
  [/^form$/i, "form"],
  [/(card|paper|panel|tile)$/i, "card"],
  [/^(hstack|row|flex|inline|group|space|wrap)$/i, "row"],
  [/^(vstack|stack|column|col|center)$/i, "col"],
  [/^(grid|simplegrid)$/i, "grid"],
  [/^(p|span|label|small|strong|em|b|i|code|pre|blockquote|li|td|th|dt|dd)$|^(text|typography|paragraph|label|caption|badge|tag|chip|alert|tooltip|description)$/i, "text"],
];
const SKIP = /^(fragment|suspense|provider|consumer|helmet|head|script|style|meta|br|hr|template|slot|transition|keepalive|router-view|routerview|outlet|nuxtpage|nuxt-layout|teleport|portal|errorboundary|trans|formattedmessage)$/i;
const LABEL_ATTRS = ["label", "title", "placeholder", "alt", "aria-label", "ariaLabel", "header", "heading", "text", "name", "value", "buttonText", "description"];
const MAX_ELEMENTS = 250;

/** What a component named like a UI element (Button, Input, Modal…) renders as. */
export const uiKindOf = (tag: string): UiKind => KINDS.find(([re]) => re.test(tag.split(".").pop()!))?.[1] ?? "component";

const kindOf = (tag: string, cls: string): UiKind => {
  const last = tag.split(".").pop()!;
  if (/^(div|section|main|article|span)$/.test(last) || !KINDS.some(([re]) => re.test(last))) {
    if (/\bgrid\b/.test(cls)) return "grid";
    if (/\bflex-col\b|\bspace-y-/.test(cls)) return "col";
    if (/\bflex\b|\binline-flex\b|\bspace-x-/.test(cls)) return "row";
  }
  return KINDS.find(([re]) => re.test(last))?.[1] ?? "box";
};
const colsOf = (cls: string) => Number(/\bgrid-cols-(\d+)/.exec(cls)?.[1] ?? /(?:md|lg|xl):grid-cols-(\d+)/.exec(cls)?.[1] ?? 0) || undefined;
const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);
/** t("billing.title") / $t('x') / i18n.t("x") → billing.title; {user.name} → {user.name} */
const exprLabel = (text: string): string | undefined => {
  const t = text.trim();
  const i18n = /\b(?:\$?t|i18n\.t|intl\.formatMessage|translate)\(\s*['"`]([^'"`]+)['"`]/.exec(t)?.[1];
  if (i18n) return i18n;
  const str = /^(['"`])([^'"`]*)\1$/.exec(t);
  if (str) return str[2].trim() || undefined;                      // {" "} / {'Save'}
  const head = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/.exec(t)?.[0];
  if (head && /^(\$?t|i18n\.t|intl\.formatMessage|translate)$/.test(head)) return undefined;   // t(item.key): a translated text, key unknown
  return head ? `{${head.replace(/\.(toLocaleString|toString|toFixed|trim|toUpperCase|toLowerCase|length)$/, "")}}` : undefined;   // {user.name.toUpperCase()} → {user.name}
};

const isEmpty = (el: UiEl) => (el.k === "box" || el.k === "row" || el.k === "col" || el.k === "grid") && !el.t && !el.act && !el.c?.length;

/** Collapse anonymous layout wrappers that only wrap one thing; drop empty ones (skeletons, spacers). */
function tidy(el: UiEl): UiEl {
  if (el.c) {
    el.c = el.c.map(tidy).filter((c) => !isEmpty(c));
    if (!el.c.length) delete el.c;
  }
  if ((el.k === "box" || el.k === "row" || el.k === "col") && !el.t && !el.act && el.c?.length === 1 && !el.rep && !el.opt) {
    const only = el.c[0];
    return { ...only, rep: only.rep ?? el.rep, opt: only.opt ?? el.opt };
  }
  return el;
}

// ---------- JSX ----------

type Jsx = JsxElement | JsxSelfClosingElement | JsxFragment;
const isJsx = (n: Node): n is Jsx => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n) || Node.isJsxFragment(n);
const isFnLike = (n: Node) => Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n);

/** Outermost JSX inside an expression: cond && <A/>, items.map(i => <Row/>), x ? <A/> : <B/> */
function jsxRoots(e: Node): Jsx[] {
  if (isJsx(e)) return [e];
  const out: Jsx[] = [];
  e.forEachDescendant((d, walk) => {
    if (isJsx(d)) { out.push(d); walk.skip(); }
  });
  return out;
}

export function jsxUi(ctx: FileContext, fn: FnInfo): UiEl | null {
  const body = fn.body;
  // the component function itself (body may be its block, its arrow, or memo(() => ...))
  const self = isFnLike(body) ? body
    : Node.isCallExpression(body) ? body.getArguments().find(isFnLike)
    : body.getParent();
  if (!self) return null;
  const nearestFn = (n: Node) => n.getFirstAncestor(isFnLike);

  // the component's own returns (not callbacks'); the largest is the main render, smaller ones are loading/empty states
  const roots: Jsx[] = [];
  const consider = (e: Node | undefined) => {
    let x = e;
    while (x && (Node.isParenthesizedExpression(x) || Node.isAsExpression(x))) x = x.getExpression();
    if (!x) return;
    if (isJsx(x)) roots.push(x);
    else if (Node.isConditionalExpression(x)) { consider(x.getWhenTrue()); consider(x.getWhenFalse()); }
  };
  for (const r of self.getDescendantsOfKind(SyntaxKind.ReturnStatement)) if (nearestFn(r) === self) consider(r.getExpression());
  if (Node.isArrowFunction(self)) consider(self.getBody());
  if (!roots.length) return null;
  const main = roots.reduce((a, b) => (b.getDescendants().length > a.getDescendants().length ? b : a));

  // handlers and render helpers declared in the component: const save = () => ..., function renderTab() { return <X/> }
  const locals = new Map<string, Node>();          // every local: const save = ..., const login = useGoogleLogin({...}), function x() {}
  const helpers = new Map<string, Node>();         // the function-like ones (render helpers)
  for (const d of self.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = d.getInitializer();
    if (!init) continue;
    if (Node.isIdentifier(d.getNameNode())) {
      locals.set(d.getName(), init);
      if (isFnLike(init)) helpers.set(d.getName(), init);
    } else for (const b of d.getNameNode().getDescendantsOfKind(SyntaxKind.BindingElement)) {
      if (Node.isIdentifier(b.getNameNode())) locals.set(b.getName(), init);          // const { login } = useAuth(): login runs what useAuth() set up
    }
  }
  for (const f of self.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (!f.getName()) continue;
    locals.set(f.getName()!, f);
    helpers.set(f.getName()!, f);
  }
  const span = (n: Node): [number, number, number, number] => [n.getStartLineNumber(), n.getEndLineNumber(), n.getStart(), n.getEnd()];
  // a handler plus the local helpers it calls (onClick={() => handleGoogleLogin()} → handleGoogleLogin's body), a few levels deep
  const reach = (start: Node, seen = new Set<string>(), depth = 0): [number, number, number, number][] => {
    const out = [span(start)];
    if (depth > 3) return out;
    for (const c of start.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = c.getExpression();
      const name = Node.isIdentifier(callee) ? callee.getText() : "";
      if (!locals.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(...reach(locals.get(name)!, seen, depth + 1));
    }
    return out;
  };
  // JSX a render helper returns (all branches: a switch over tabs shows every tab, each marked conditional)
  const inlined = new Set<string>();
  const helperJsx = (name: string): Jsx[] => {
    const h = helpers.get(name);
    if (!h || inlined.has(name)) return [];
    inlined.add(name);
    const out: Jsx[] = [];
    for (const r of h.getDescendantsOfKind(SyntaxKind.ReturnStatement)) if (r.getFirstAncestor(isFnLike) === h && r.getExpression()) out.push(...jsxRoots(r.getExpression()!));
    if (Node.isArrowFunction(h)) out.push(...jsxRoots(h.getBody()).filter((j) => j.getFirstAncestor(isFnLike) === h));
    return out;
  };

  const actOf = (attrs: JsxAttributeLike[]): UiEl["act"] => {
    for (const a of attrs) {
      if (!Node.isJsxAttribute(a)) continue;
      const name = a.getNameNode().getText();
      if (!/^(on[A-Z]\w*|action|formAction)$/.test(name) || /^on(Change|Input|Focus|Blur|Mouse|Key|Scroll|Hover|Pointer|Drag|Load|Error|Close|Open|Toggle)/.test(name)) continue;
      const init = a.getInitializer();
      const e = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
      if (!e) continue;
      // Formik onSubmit, Ant Design onFinish, <form action>: the submit buttons inside run this
      const submit = /^(onSubmit|onFinish|onValidSubmit|action|formAction)$/.test(name) ? { submit: 1 as const } : {};
      const ref = e.getText().replace(/^this\./, "");
      const start = Node.isArrowFunction(e) || Node.isFunctionExpression(e) || Node.isCallExpression(e) ? e : locals.get(ref);
      if (start) return { r: reach(start, new Set([ref])), ...submit };
      if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) return { fn: ref.split(".").pop()!, ...submit };
    }
    return undefined;
  };
  const attrText = (attrs: JsxAttributeLike[], name: string) => {
    const a = attrs.find((x) => Node.isJsxAttribute(x) && x.getNameNode().getText() === name);
    const init = a && Node.isJsxAttribute(a) ? a.getInitializer() : undefined;
    if (!init) return "";
    if (Node.isStringLiteral(init)) return init.getLiteralValue();
    const e = Node.isJsxExpression(init) ? init.getExpression() : undefined;
    if (!e) return "";
    if (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) return e.getLiteralValue();
    return exprLabel(e.getText()) ?? "";
  };

  let count = 0;
  const children = (nodes: Node[], flags: Pick<UiEl, "rep" | "opt">): { els: UiEl[]; text: string } => {
    const els: UiEl[] = [];
    const texts: string[] = [];
    for (const ch of nodes) {
      if (count > MAX_ELEMENTS) break;
      if (Node.isJsxText(ch)) {
        const t = clean(ch.getText());
        if (t) texts.push(t);
      } else if (Node.isJsxExpression(ch)) {
        const e = ch.getExpression();
        if (!e) continue;
        const call = Node.isCallExpression(e) && Node.isIdentifier(e.getExpression()) ? e.getExpression().getText() : null;
        if (call && helpers.has(call)) {
          const parts = helperJsx(call);
          for (const j of parts) els.push(...element(j, { rep: flags.rep, opt: parts.length > 1 ? 1 : flags.opt }));
          continue;
        }
        const inner = jsxRoots(e);
        if (!inner.length) {
          const label = exprLabel(e.getText());
          if (label) texts.push(label);
          continue;
        }
        const loop = !isJsx(e) && /\.(map|flatMap)\(/.test(e.getText());
        const cond = Node.isConditionalExpression(e) || Node.isBinaryExpression(e);
        for (const j of inner) els.push(...element(j, { rep: loop ? 1 : flags.rep, opt: cond ? 1 : flags.opt }));
      } else if (isJsx(ch)) {
        els.push(...element(ch, flags));
      }
    }
    const text = texts.join(" ").slice(0, 60);
    if (text && els.length) els.unshift({ k: "text", t: text, line: nodes[0]?.getStartLineNumber() ?? 0 });
    return { els, text: els.length ? "" : text };
  };

  const element = (n: Jsx, flags: Pick<UiEl, "rep" | "opt">): UiEl[] => {
    count++;
    if (Node.isJsxFragment(n)) return children(n.getJsxChildren(), flags).els;
    const open = Node.isJsxElement(n) ? n.getOpeningElement() : n;
    const tag = open.getTagNameNode().getText();
    const attrs = open.getAttributes();
    const kids = Node.isJsxElement(n) ? children(n.getJsxChildren(), {}) : { els: [], text: "" };
    if (SKIP.test(tag.split(".").pop()!)) return kids.els;
    const head = tag.split(".")[0];
    const local = /^[A-Z]/.test(head) && (ctx.fns.some((f) => f.node.name === tag) || !!ctx.imports.get(head)?.resolved);
    const cls = attrText(attrs, "className") || attrText(attrs, "class");
    let k: UiKind = local ? "component" : kindOf(tag, cls);
    if (k === "col" && /^stack$/i.test(tag) && /row/.test(attrText(attrs, "direction"))) k = "row";
    if (k === "text" && /^h[1-6]$/.test(attrText(attrs, "variant"))) k = "heading";
    if (k === "input" && /checkbox|radio/.test(attrText(attrs, "type"))) k = "checkbox";
    const label = kids.text || LABEL_ATTRS.map((a) => attrText(attrs, a)).find(Boolean);
    const el: UiEl = { k, line: open.getStartLineNumber(), ...(label ? { t: clean(label) } : {}), ...(/^[A-Z]/.test(tag) ? { tag } : {}) };
    const act = actOf(attrs);
    if (act) el.act = act;
    if (flags.rep) el.rep = 1;
    if (flags.opt) el.opt = 1;
    const cols = k === "grid" ? colsOf(cls) : undefined;
    if (cols) el.cols = cols;
    if (kids.els.length) el.c = kids.els.slice(0, 30);
    return [el];
  };

  const top = element(main, {});
  if (!top.length) return null;
  return tidy(top.length === 1 ? top[0] : { k: "col", line: main.getStartLineNumber(), c: top });
}

// ---------- templates (.vue / .svelte / .astro) ----------

const TOKEN = /(?<comment><!--[\s\S]*?-->)|<\/(?<close>[A-Za-z][\w.:-]*)\s*>|<(?<open>[A-Za-z][\w.:-]*)(?<attrs>(?:\s+(?:[^\s"'=<>`/]+|\/(?!>))(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+))?)*)\s*(?<self>\/?)>|(?<block>\{[#:/][^}]*\})|\{\{(?<mustache>[^}]*)\}\}|\{(?<expr>[^}]*)\}|(?<text>[^<{]+)/g;
const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;

export function templateUi(tpl: Template, importsComponent: (tag: string) => boolean): UiEl | null {
  const root: UiEl = { k: "col", line: 1, c: [] };
  const stack: { el: UiEl; tag: string; texts: string[] }[] = [{ el: root, tag: "#root", texts: [] }];
  const blocks: ("each" | "if")[] = [];
  let count = 0;
  const pascal = (t: string) => (t.includes("-") ? t.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("") : t);
  const attr = (raw: string, name: RegExp) => {
    const m = new RegExp(`(?:^|\\s)(?:${name.source})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`).exec(raw);
    return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
  };
  for (const m of tpl.text.matchAll(TOKEN)) {
    if (count > MAX_ELEMENTS) break;
    const { close, open, attrs: rawAttrs = "", self: selfClose, block, mustache, expr, text, comment } = m.groups!;
    const top = stack[stack.length - 1];
    if (comment) continue;
    if (block) {
      if (/^\{#each\b/.test(block)) blocks.push("each");
      else if (/^\{#(if|await)\b/.test(block)) blocks.push("if");
      else if (/^\{\/(each|if|await)\b/.test(block)) blocks.pop();
      continue;
    }
    if (text !== undefined) { const t = clean(text); if (t) top.texts.push(t); continue; }
    if (mustache !== undefined || expr !== undefined) { const l = exprLabel((mustache ?? expr).trim()); if (l) top.texts.push(l); continue; }
    if (close) {
      const i = stack.map((s) => s.tag).lastIndexOf(close);
      if (i <= 0) continue;
      while (stack.length > i) finish(stack.pop()!);
      continue;
    }
    if (!open || /^(script|style)$/i.test(open)) continue;
    count++;
    const tag = pascal(open);
    const isComp = /^[A-Z]/.test(tag) && importsComponent(tag);
    let k: UiKind = isComp ? "component" : SKIP.test(open) ? "box" : kindOf(tag, attr(rawAttrs, /:?class/));
    if (k === "input" && /checkbox|radio/.test(attr(rawAttrs, /type/))) k = "checkbox";
    const el: UiEl = { k, line: tpl.line(m.index!), ...(isComp || /^[A-Z]/.test(tag) ? { tag } : {}) };
    const label = ["placeholder", "label", "title", "alt", "aria-label"].map((a) => attr(rawAttrs, new RegExp(`:?${a}`))).find(Boolean);
    if (label) el.t = clean(exprLabel(label) ?? label);
    const click = attr(rawAttrs, /@click(?:\.\w+)*|v-on:click|on:click|onclick/);
    const submit = attr(rawAttrs, /@submit(?:\.\w+)*|v-on:submit|on:submit|onsubmit/);
    const handler = submit || click;
    if (handler) {
      // the script's functions are their own nodes: resolve the handler by name
      const name = /^\(?\s*([\w$.]+)/.exec(handler.replace(/^\(\)\s*=>\s*/, ""))?.[1]?.split(".").pop();
      if (name) el.act = { fn: name, ...(submit ? { submit: 1 as const } : {}) };
    }
    if (/\bv-for\s*=/.test(rawAttrs) || blocks.includes("each")) el.rep = 1;
    if (/\bv-(if|else-if|else|show)\b/.test(rawAttrs) || blocks.includes("if")) el.opt = 1;
    if (selfClose || VOID.test(open)) { (top.el.c ??= []).push(el); continue; }
    stack.push({ el, tag: open, texts: [] });
  }
  while (stack.length > 1) finish(stack.pop()!);
  function finish(s: { el: UiEl; tag: string; texts: string[] }) {
    if (s.texts.length && !s.el.t && !s.el.c?.length) s.el.t = s.texts.join(" ").slice(0, 60);
    else if (s.texts.length) (s.el.c ??= []).unshift({ k: "text", t: s.texts.join(" ").slice(0, 60), line: s.el.line });
    if (SKIP.test(s.tag) && s.el.k === "box") { (stack[stack.length - 1].el.c ??= []).push(...(s.el.c ?? [])); return; }
    (stack[stack.length - 1].el.c ??= []).push(s.el);
  }
  if (!root.c?.length) return null;
  return tidy(root.c.length === 1 ? root.c[0] : root);
}
