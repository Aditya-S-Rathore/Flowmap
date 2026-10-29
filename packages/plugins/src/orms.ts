import { Node } from "ts-morph";
import { flags, type FlowMapPlugin } from "@flowmap/core";
import { BOUNDED, chainText } from "./util.ts";

const PRISMA_READ = new Set(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"]);
const PRISMA_WRITE = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const CLIENT = /^(prisma|db|tx|client|prismaClient|trx|database)$/;

const lcfirst = (s: string) => s[0].toLowerCase() + s.slice(1);

/** Prisma: schema.prisma models become tables; prisma.user.findMany() / tx.user.update() read and write them. */
export const prisma: FlowMapPlugin = {
  id: "prisma",
  detect: (pkg) => !!(pkg.dependencies?.["@prisma/client"] ?? pkg.devDependencies?.prisma),
  textExtensions: [".prisma"],

  extractText(file, text, ctx) {
    const models = new Set([...text.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]));
    for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const model = m[1];
      const table = /@@map\(\s*"([^"]+)"/.exec(m[2])?.[1] ?? model;
      const line = text.slice(0, m.index).split("\n").length;
      const id = `${ctx.repo.name}:table:${table}`;
      const relations = [...m[2].matchAll(/^\s*\w+\s+(\w+)\??\s+@relation\([^)]*fields:\s*\[(\w+)/gm)].map((r) => ({ to: r[1], column: r[2], indexed: new RegExp(`@@(index|unique|id)\\(\\[\\s*${r[2]}\\b|^\\s*${r[2]}\\s.*@(unique|id)\\b`, "m").test(m[2]) }));
      // fields whose type is another model are relations, not columns
      const columns = [...m[2].matchAll(/^\s*(\w+)\s+(\w+)(\[\])?(\?)?/gm)].filter((c) => !models.has(c[2])).map((c) => ({ name: c[1], type: `${c[2]}${c[3] ?? ""}${c[4] ?? ""}` })).slice(0, 200);
      ctx.node({ id, kind: "Table", name: table, repo: ctx.repo.name, file, line, keys: [`table:${table}`, `prisma:${lcfirst(model)}`, `entity:${model}`], attrs: { entity: model, relations, columns } });
      for (const r of relations) ctx.edge({ src: id, kind: "relates", dstKey: `entity:${r.to}`, line, attrs: { column: r.column } });
    }
  },

  extract(ctx) {
    for (const cs of ctx.calls) {
      // client API: prisma.$transaction(...), $connect(), $queryRaw`...` (the transaction callback is handled by core)
      if (cs.method.startsWith("$") && CLIENT.test(cs.segments.length > 1 ? cs.segments[cs.segments.length - 2] : cs.root ?? "")) cs.claimed = true;
      if (cs.claimed || cs.segments.length < 2) continue;
      const read = PRISMA_READ.has(cs.method);
      if (!read && !PRISMA_WRITE.has(cs.method)) continue;
      const model = cs.segments[cs.segments.length - 2];
      const client = cs.segments.length > 2 ? cs.segments[cs.segments.length - 3] : cs.root ?? "";
      if (!CLIENT.test(client) || !/^[a-z]\w*$/.test(model)) continue;
      const unbounded = cs.method === "findMany" && !BOUNDED.test(chainText(cs.call));
      ctx.edge({ src: cs.fn.node.id, kind: read ? "reads" : "writes", dstKey: `prisma:${model}`, line: cs.line, attrs: { ...flags(cs), method: cs.method, ...(unbounded ? { unbounded: true } : {}) } });
      cs.claimed = true;
    }
  },
};

const DRIZZLE_TABLE = /^(pgTable|mysqlTable|sqliteTable|singlestoreTable)$/;

/** Drizzle: pgTable("users", ...) defines a table; db.select().from(users), db.insert(users), db.query.users.findMany() use it. */
export const drizzle: FlowMapPlugin = {
  id: "drizzle",
  detect: (pkg) => !!pkg.dependencies?.["drizzle-orm"],

  extract(ctx) {
    for (const d of ctx.sf.getVariableDeclarations()) {
      const init = d.getInitializer();
      if (!init || !Node.isCallExpression(init) || !DRIZZLE_TABLE.test(init.getExpression().getText())) continue;
      const nameArg = init.getArguments()[0];
      const table = nameArg && Node.isStringLiteral(nameArg) ? nameArg.getLiteralValue() : d.getName();
      const shape = init.getArguments()[1];
      const columns = shape && Node.isObjectLiteralExpression(shape)
        ? shape.getProperties().flatMap((p) => (Node.isPropertyAssignment(p) ? [{ name: p.getName(), type: /^(\w+)/.exec(p.getInitializer()?.getText() ?? "")?.[1] ?? "" }] : [])).slice(0, 200) : [];
      ctx.node({ id: `${ctx.repo.name}:table:${table}`, kind: "Table", name: table, repo: ctx.repo.name, file: ctx.file, line: d.getStartLineNumber(), keys: [`table:${table}`, `drizzle:${d.getName()}`], attrs: { entity: d.getName(), relations: [], columns } });
    }
    for (const cs of ctx.calls) {
      if (cs.claimed) continue;
      const arg = cs.call.getArguments()[0];
      const target = arg && Node.isIdentifier(arg) ? arg.getText() : null;
      let kind: "reads" | "writes" | null = null;
      let table = target;
      if (/^(insert|update|delete)$/.test(cs.method) && cs.root && /^(db|tx|trx|database)$/.test(cs.root) && cs.segments.length === 1) kind = "writes";
      else if (cs.method === "from" && cs.chained && /^(db|tx|trx|database)$/.test(cs.root ?? "")) kind = "reads";
      else if (cs.segments[0] === "query" && cs.segments.length === 3 && /^(findMany|findFirst)$/.test(cs.method)) { kind = "reads"; table = cs.segments[1]; }
      if (!kind || !table) continue;
      const unbounded = kind === "reads" && !BOUNDED.test(chainText(cs.call));
      ctx.edge({ src: cs.fn.node.id, kind, dstKey: `drizzle:${table}`, line: cs.line, attrs: { ...flags(cs), method: cs.method, ...(unbounded ? { unbounded: true } : {}) } });
      cs.claimed = true;
    }
  },
};
