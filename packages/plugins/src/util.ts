import { Node, type CallExpression } from "ts-morph";
import type { DecoratorInfo, FileContext } from "@flowmap/core";

/** "'users'" | '"users"' | "`users`" | "{ name: 'users' }" -> users */
export function literal(arg: string | undefined, prop = "name"): string | null {
  if (!arg) return null;
  const s = /^\s*['"`]([^'"`]*)['"`]\s*$/.exec(arg);
  if (s) return s[1];
  const o = new RegExp(`\\b${prop}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`).exec(arg);
  return o ? o[1] : null;
}

export function deco(list: DecoratorInfo[], names: string | string[]): DecoratorInfo | undefined {
  const set = Array.isArray(names) ? names : [names];
  return list.find((d) => set.includes(d.name));
}

/** Identifiers inside decorator args: UseGuards(JwtAuthGuard, AuthGuard('jwt')) -> ["JwtAuthGuard", "AuthGuard(jwt)"] */
export function guardNames(args: string[]): string[] {
  return args.map((a) => a.replace(/['"`\s]/g, "")).filter(Boolean);
}

export function snakeCase(s: string) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

/** Value of a call argument as a link-key fragment: literal text, or a {const:X} token the linker resolves. */
export function argRef(call: CallExpression, index: number, token: "const" | "gql" = "const"): string | null {
  const a = call.getArguments()[index];
  if (!a) return null;
  if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) return a.getLiteralValue();
  if (Node.isIdentifier(a) || Node.isPropertyAccessExpression(a)) return `{${token}:${a.getText()}}`;
  return null;
}

/** Key for an import/local identifier pointing at a function or component. */
export function identKey(ctx: FileContext, ident: string): { key: string; hint: string } | null {
  const head = ident.split(".")[0];
  if (ctx.fns.some((f) => f.node.name === ident)) return { key: ctx.fnKey(ident), hint: ctx.file };
  const imp = ctx.imports.get(head);
  if (!imp?.resolved) return null;
  const member = ident.includes(".") ? ident.split(".").slice(1).join(".") : null;
  if (imp.imported === "default") return { key: `default:${ctx.repo.name}:${imp.resolved}${member ? "#" + member : ""}`, hint: imp.resolved };
  return { key: ctx.fnKey(imp.imported === "*" ? member ?? "" : member ? `${imp.imported}.${member}` : imp.imported), hint: imp.resolved };
}

/** The whole chain a call sits in: `db.select().from(users).limit(10)` for the `.from(...)` call. */
export function chainText(call: Node): string {
  let n = call;
  for (let p = n.getParent(); p && (Node.isPropertyAccessExpression(p) || (Node.isCallExpression(p) && p.getExpression() === n)); p = n.getParent()) n = p;
  return n.getText();
}

// a list read with one of these somewhere in its chain or options is bounded (a page, a limit, a fixed set of ids)
export const BOUNDED = /\b(?:take|limit|first|last|top|skip|offset|cursor|paginat\w*|In)\s*[:(]|\bin\s*:/;

export function normalizeRestPath(p: string): string {
  const clean = p
    .replace(/\?.*$/, "")
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/\{[^}]*\}|<[^>]+>|\[[^\]]+\]/g, ":p")      // FastAPI {id}, Django <int:id>, file routes [id]
    .replace(/:[A-Za-z_]\w*\??/g, ":p")
    .replace(/^[^/]*?(?=\/)/, "")       // drop "${BASE}" / host prefix before the first slash
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  return clean.startsWith("/") ? clean : "/" + clean;
}
