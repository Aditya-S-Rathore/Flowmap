import { Node, SyntaxKind } from "ts-morph";
import { flags, type FlowMapPlugin } from "@flowmap/core";
import { argRef } from "./util.ts";

const HOOKS = new Set(["useQuery", "useLazyQuery", "useMutation", "useSubscription", "useSuspenseQuery"]);
const CLIENT_METHODS: Record<string, string> = { query: "query", mutate: "mutation", subscribe: "query", watchQuery: "query" };

/** Top-level field names of a GraphQL document: `mutation X($a: Int) { setNickname(a: $a) { id } }` → ["setNickname"]. */
export function rootFields(doc: string): string[] {
  const src = doc.replace(/\$\{[^}]*\}/g, " ").replace(/#[^\n]*/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const start = src.indexOf("{");
  if (start === -1) return [];
  const out: string[] = [];
  let depth = 0;
  let paren = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
    else if (depth === 1 && paren === 0 && /[A-Za-z_]/.test(c) && !/[\w.$]/.test(src[i - 1] ?? "")) {
      const m = /^([A-Za-z_]\w*)\s*(:\s*([A-Za-z_]\w*))?/.exec(src.slice(i));
      if (!m) continue;
      if (m[1] !== "on" && !src.slice(0, i).trimEnd().endsWith("...")) out.push(m[3] ?? m[1]);
      i += m[0].length - 1;
    }
  }
  return out;
}

export const apollo: FlowMapPlugin = {
  id: "apollo",
  detect: (pkg) => !!(pkg.dependencies?.["@apollo/client"] ?? pkg.dependencies?.["graphql-request"] ?? pkg.dependencies?.urql),

  extract(ctx) {
    // gql documents → constants the linker uses to find the operation name
    for (const tt of ctx.sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
      if (!/^(gql|graphql)$/.test(tt.getTag().getText())) continue;
      const decl = tt.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      if (!decl) continue;
      const fields = rootFields(tt.getTemplate().getText());
      if (fields.length) ctx.constant(decl.getName(), "gql:" + fields.join(","));
    }

    const clients = new Map(ctx.config.clients.map((c) => [c.call, c]));
    for (const cs of ctx.calls) {
      if (cs.claimed) continue;
      const callee = [cs.root, ...cs.segments].filter(Boolean).join(".");
      let op: string | null = null;
      const wrapper = clients.get(callee);
      if (wrapper) {
        op = (wrapper.opArg !== undefined ? argRef(cs.call, wrapper.opArg) : null) ?? (wrapper.docArg !== undefined ? argRef(cs.call, wrapper.docArg, "gql") : null);
      } else if (HOOKS.has(cs.method) && cs.segments.length === 0) {
        op = argRef(cs.call, 0, "gql");
      } else if (CLIENT_METHODS[cs.method] && cs.segments.length) {
        const opts = cs.call.getArguments()[0];
        if (opts && Node.isObjectLiteralExpression(opts)) {
          const p = opts.getProperty("query") ?? opts.getProperty("mutation");
          const v = p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
          if (v && (Node.isIdentifier(v) || Node.isPropertyAccessExpression(v))) op = `{gql:${v.getText()}}`;
        }
      }
      if (!op) continue;
      const head = /^\{\w+:([\w$]+)/.exec(op)?.[1];
      if (head && cs.fn.params.some((p) => p.name === head || p.name.includes(head))) continue;
      ctx.edge({ src: cs.fn.node.id, kind: "requests", dstKey: `op:graphql:${op}`, line: cs.line, attrs: { ...flags(cs), label: op.replace(/^\{\w+:/, "").replace(/\}$/, "") } });
      cs.claimed = true;
    }
  },
};
