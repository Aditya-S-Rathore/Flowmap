import type { FlowMapPlugin } from "@flowmap/core";

const ROOT = /\b(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b[^{]*\{/g;

/** Parses schema-first .graphql files: root fields become Schema nodes that "define" the matching Operation. */
export const graphqlSdl: FlowMapPlugin = {
  id: "graphql-sdl",
  textExtensions: [".graphql", ".gql"],
  // server-side GraphQL libraries (a client-only `graphql` dependency has no schema files to read)
  detect: (pkg) => ["@nestjs/graphql", "@apollo/server", "apollo-server", "apollo-server-express", "graphql-yoga", "mercurius", "@graphql-tools/schema", "type-graphql"].some((d) => !!pkg.dependencies?.[d]),

  extractText(file, text, ctx) {
    // blank out comments/descriptions but keep offsets so line numbers stay right
    const src = text.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
    for (const m of src.matchAll(ROOT)) {
      const type = m[1].toLowerCase();
      const open = m.index! + m[0].length;
      let depth = 1, end = open;
      while (end < src.length && depth) depth += src[end] === "{" ? 1 : src[end] === "}" ? -1 : 0, end++;
      let line = src.slice(0, open).split("\n").length;
      let buf = "", bufLine = line, paren = 0;
      for (const l of src.slice(open, end - 1).split("\n")) {
        if (!buf.trim()) bufLine = line;
        buf += l + "\n";
        for (const c of l) paren += c === "(" ? 1 : c === ")" ? -1 : 0;
        const fm = paren === 0 ? /^\s*(\w+)\s*(?:\(([\s\S]*)\))?\s*:\s*([^@\n]+)/.exec(buf) : null;
        if (fm) {
          const name = fm[1];
          const id = `${ctx.repo.name}:schema:${name}`;
          ctx.node({
            id, kind: "Schema", name: `${type} ${name}`, repo: ctx.repo.name, file, line: bufLine,
            keys: [`schema:graphql:${name}`],
            attrs: { type, args: (fm[2] ?? "").replace(/\s+/g, " ").trim(), returns: fm[3].trim() },
          });
          ctx.edge({ src: id, kind: "defines", dstKey: `op:graphql:${name}`, line: bufLine, attrs: {} });
          buf = "";
        } else if (paren === 0 && !buf.includes("(")) buf = buf.trim() ? buf : "";
        line++;
      }
    }
  },
};
