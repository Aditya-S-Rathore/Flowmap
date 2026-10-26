import { Node, SyntaxKind } from "ts-morph";
import { flags, type CallSite, type FieldInfo, type FileContext, type FlowMapPlugin } from "@flowmap/core";
import { BOUNDED, chainText, deco, literal, snakeCase } from "./util.ts";

const WRITE = new Set(["save", "insert", "update", "upsert", "delete", "softDelete", "remove", "softRemove", "increment", "decrement", "restore", "recover", "clear"]);
const READ = new Set(["find", "findOne", "findOneBy", "findBy", "findAndCount", "findAndCountBy", "findOneOrFail", "findOneByOrFail", "count", "countBy", "exist", "exists", "existsBy", "findByIds", "sum", "average", "minimum", "maximum", "preload"]);
const QB_TERMINAL = new Set(["getMany", "getOne", "getRawMany", "getRawOne", "getCount", "getManyAndCount", "getExists", "execute", "stream", "getRawAndEntities", "getOneOrFail"]);
const MANAGER_ROOTS = new Set(["manager", "em", "entityManager", "queryRunner", "trx", "transactionalEntityManager", "tx", "m"]);
const RELATIONS = ["ManyToOne", "OneToOne"];
const MANY = new Set(["find", "findBy", "findAndCount", "findAndCountBy", "getMany", "getRawMany", "getManyAndCount", "getRawAndEntities", "stream"]);
const REPO_API = new Set(["create", "merge", "createQueryBuilder", "getId", "hasId", "extend", "metadata", "target", "manager"]);

export const typeorm: FlowMapPlugin = {
  id: "typeorm",
  detect: (pkg) => !!(pkg.dependencies?.typeorm ?? pkg.devDependencies?.typeorm),

  extract(ctx) {
    entities(ctx);
    for (const cls of ctx.classes.values()) {
      const m = /^(?:Repository|TreeRepository|MongoRepository)<\s*(\w+)\s*>/.exec(cls.extends ?? "");
      const er = deco(cls.decorators, "EntityRepository");
      const entity = m?.[1] ?? er?.args[0];
      if (entity) ctx.constant(`__repo:${cls.name}`, entity);
    }
    for (const cs of ctx.calls) if (!cs.claimed) dbAccess(ctx, cs);
  },
};

function entities(ctx: FileContext) {
  for (const cls of ctx.classes.values()) {
    const ent = deco(cls.decorators, ["Entity", "ViewEntity"]);
    if (!ent) continue;
    const table = literal(ent.args[0]) ?? snakeCase(cls.name);
    const id = `${ctx.repo.name}:table:${table}`;
    const classIndexed = cls.decorators.filter((d) => d.name === "Index").flatMap((d) => d.args.join(",").match(/['"`](\w+)['"`]/g) ?? []).map((s) => s.slice(1, -1));
    const fields = [...cls.fields.values()];
    const indexed = (col: string) =>
      classIndexed.includes(col) ||
      fields.some((f) => f.name === col && (deco(f.decorators, ["Index", "PrimaryColumn", "PrimaryGeneratedColumn"]) || f.decorators.some((d) => /index\s*:\s*true|unique\s*:\s*true/.test(d.args.join(",")))));
    const relations = fields.flatMap((f) => {
      const rel = deco(f.decorators, RELATIONS);
      if (!rel) return [];
      const target = /=>\s*(\w+)/.exec(rel.args[0] ?? "")?.[1] ?? "?";
      const join = deco(f.decorators, "JoinColumn");
      const column = literal(join?.args[0]) ?? `${f.name}Id`;
      return [{ to: target, prop: f.name, column, indexed: rel.name === "OneToOne" || indexed(column) || indexed(f.name) }];
    });
    ctx.node({ id, kind: "Table", name: table, repo: ctx.repo.name, file: ctx.file, line: cls.line, keys: [`table:${table}`, `entity:${cls.name}`], attrs: { entity: cls.name, relations } });
    for (const r of relations) ctx.edge({ src: id, kind: "relates", dstKey: `entity:${r.to}`, line: cls.line, attrs: { column: r.column } });
  }
}

function entityOfField(f: FieldInfo | null): string | null {
  if (!f) return null;
  const inject = deco(f.decorators, "InjectRepository");
  if (inject) return inject.args[0] ?? null;
  if (/^(Repository|TreeRepository|MongoRepository)$/.test(f.typeName ?? "")) return f.typeArgs[0] ?? null;
  if (/Repository$/.test(f.typeName ?? "")) return `{const:__repo:${f.typeName}}`;
  return null;
}

const firstEntityArg = (cs: CallSite) => {
  const a = cs.call.getArguments()[0];
  return a && Node.isIdentifier(a) && /^[A-Z]/.test(a.getText()) ? a.getText() : null;
};

function dbAccess(ctx: FileContext, cs: CallSite) {
  // const qb = this.repo.createQueryBuilder("u"); ... qb.getMany()
  const localQb = !/createQueryBuilder/.test(cs.call.getText()) && cs.root && cs.root !== "this"
    ? cs.fn.body.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((d) => d.getName() === cs.root)?.getInitializer()?.getText() ?? ""
    : "";
  const edge = (kind: "reads" | "writes", dstKey: string, extra = {}) => {
    // every row, no limit: the chain/options, or a local query builder (qb.take(10)), set none
    const unbounded = kind === "reads" && MANY.has(cs.method) && !BOUNDED.test(chainText(cs.call) + localQb)
      && !(cs.root && new RegExp(`\\b${cs.root}\\s*\\.\\s*(?:take|limit|skip|offset)\\(`).test(cs.fn.body.getText()));
    ctx.edge({ src: cs.fn.node.id, kind, dstKey, line: cs.line, attrs: { ...flags(cs), method: cs.method, ...(unbounded ? { unbounded: true } : {}), ...extra } });
    cs.claimed = true;
  };

  // raw SQL: anything.query("INSERT INTO ...")
  if (cs.method === "query") {
    const a = cs.call.getArguments()[0];
    if (a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a) || Node.isTemplateExpression(a))) {
      const sql = a.getText();
      if (/\b(select|insert|update|delete|with)\b/i.test(sql)) {
        for (const m of sql.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+["`]?(?:\w+["`]?\.["`]?)?(\w+)/gi)) edge("writes", `table:${m[1]}`, { raw: true });
        for (const m of sql.matchAll(/\b(?:from|join)\s+["`]?(?:\w+["`]?\.["`]?)?(\w+)/gi)) if (!/^(select|lateral|unnest)$/i.test(m[1])) edge("reads", `table:${m[1]}`, { raw: true });
        cs.claimed = true;
      }
    }
    return;
  }

  const getRepo = /getRepository\(\s*(\w+)\s*\)/.exec(cs.callee)?.[1] ?? null;
  const inRepoClass = cs.root === "this" && cs.segments.length === 1 && /^(?:Repository|TreeRepository)<\s*(\w+)/.exec(cs.fn.cls?.extends ?? "")?.[1];
  const viaManager = cs.segments.includes("manager") || MANAGER_ROOTS.has(cs.root ?? "") || /^(EntityManager|DataSource|QueryRunner)$/.test(cs.field?.typeName ?? "");
  const entity = getRepo ?? (viaManager ? firstEntityArg(cs) : null) ?? (inRepoClass || null) ?? entityOfField(cs.field);

  if (QB_TERMINAL.has(cs.method) && (/createQueryBuilder/.test(cs.call.getText()) || /createQueryBuilder/.test(localQb))) {
    const chain = localQb + cs.call.getText();
    const qbField = /^\s*(?:await\s+)?this\.(\w+)\s*\.\s*createQueryBuilder/.exec(localQb)?.[1];
    const fieldEntity = qbField ? entityOfField(cs.fn.cls?.fields.get(qbField) ?? null) : entity;
    const write = /\.(update|insert|delete|softDelete|restore)\s*\(/.test(chain);
    const qbEntity = /createQueryBuilder\(\s*([A-Z]\w*)/.exec(chain)?.[1] ?? /\.(?:from|update|into)\(\s*([A-Z]\w*)/.exec(chain)?.[1] ?? fieldEntity;
    if (qbEntity) edge(write ? "writes" : "reads", `entity:${qbEntity}`, { queryBuilder: true });
    return;
  }
  // repository API calls are never chained after another call, except getRepository(E).save()
  if (!entity || (cs.chained && !getRepo)) return;
  if (REPO_API.has(cs.method)) {
    cs.claimed = true;
    return;
  }
  if (WRITE.has(cs.method)) edge("writes", `entity:${entity}`);
  else if (READ.has(cs.method)) edge("reads", `entity:${entity}`);
}
