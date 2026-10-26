import { SyntaxKind } from "ts-morph";
import { VALIDATES, type FlowMapPlugin, type FnInfo } from "@flowmap/core";
import { deco, guardNames, identKey, literal, normalizeRestPath } from "./util.ts";

const GQL_OPS: Record<string, string> = { Query: "query", Mutation: "mutation", Subscription: "subscription" };
const HTTP_VERBS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", All: "ALL", Head: "HEAD", Options: "OPTIONS" };
const INPUT_DECORATORS = ["Args", "Body", "Param", "Query", "Headers"];
const JOB_DECORATORS = ["Cron", "Interval", "Timeout"];

export const nestjs: FlowMapPlugin = {
  id: "nestjs",
  detect: (pkg) => !!(pkg.dependencies?.["@nestjs/core"] ?? pkg.devDependencies?.["@nestjs/core"]),

  extract(ctx) {
    const { repo, config } = ctx;
    const text = ctx.sf.getFullText();
    if (text.includes("APP_GUARD")) ctx.meta.globalGuard = true;

    // composite decorators: export function OrgProtected() { return applyDecorators(UseGuards(A, B), RequireX()) }
    for (const fn of ctx.fns) {
      if (fn.cls || !fn.body.getText().includes("applyDecorators(")) continue;
      const calls = fn.body.getDescendantsOfKind(SyntaxKind.CallExpression);
      const guards = calls.filter((c) => c.getExpression().getText() === "UseGuards").flatMap((c) => guardNames(c.getArguments().map((a) => a.getText())));
      const permissions = calls.map((c) => c.getExpression().getText()).filter((n) => config.permissionDecorators.includes(n));
      fn.node.attrs.composite = { guards, permissions };
    }

    for (const cls of ctx.classes.values()) {
      if (/Guard$/.test(cls.name)) {
        ctx.node({ id: `${repo.name}:guard:${cls.name}`, kind: "Guard", name: cls.name, repo: repo.name, file: ctx.file, line: cls.line, keys: [`guard:${cls.name}`] });
      }
      const resolver = deco(cls.decorators, "Resolver");
      const controller = deco(cls.decorators, "Controller");
      const processorLike = deco(cls.decorators, ["Injectable", "Processor"]) || resolver || controller;
      const methods = ctx.fns.filter((f) => f.cls === cls);

      if (processorLike) {
        for (const fn of methods) {
          const job = deco(fn.decorators, JOB_DECORATORS);
          const event = deco(fn.decorators, "OnEvent");
          if (job) {
            const id = `${repo.name}:job:${fn.node.name}`;
            ctx.node({ id, kind: "Job", name: `${job.name.toLowerCase()} ${literal(job.args[0]) ?? job.args[0] ?? ""}`.trim(), repo: repo.name, file: ctx.file, line: job.line, attrs: { schedule: job.args[0] ?? null } });
            ctx.edge({ src: id, kind: "triggers", dstKey: ctx.fnKey(fn.node.name), line: job.line, attrs: { hint: ctx.file } });
          }
          if (event) {
            const name = literal(event.args[0]) ?? event.args[0];
            ctx.node({ id: `${repo.name}:queue:event:${name}:${fn.node.name}`, kind: "Queue", name: `event ${name}`, repo: repo.name, file: ctx.file, line: event.line, keys: [`queue:event:${name}`] });
            ctx.edge({ src: `${repo.name}:queue:event:${name}:${fn.node.name}`, kind: "triggers", dstKey: ctx.fnKey(fn.node.name), line: event.line, attrs: { hint: ctx.file } });
          }
        }
        // this.eventEmitter.emit("x") -> enqueues event:x
        for (const cs of ctx.calls) {
          if (cs.fn.cls !== cls || cs.method !== "emit" || !/EventEmitter/.test(cs.field?.typeName ?? "")) continue;
          const name = literal(cs.call.getArguments()[0]?.getText());
          if (!name) continue;
          ctx.edge({ src: cs.fn.node.id, kind: "enqueues", dstKey: `queue:event:${name}`, line: cs.line, attrs: { method: "emit", ...(cs.inTx ? { inTx: true } : {}) } });
          cs.claimed = true;
        }
      }

      if (!resolver && !controller) continue;
      const classGuards = guardNames(deco(cls.decorators, "UseGuards")?.args ?? []);
      const classPerms = cls.decorators.filter((d) => config.permissionDecorators.includes(d.name)).map((d) => d.name);
      const basePath = controller ? literal(controller.args[0], "path") ?? "" : "";

      for (const fn of methods) {
        if (deco(fn.decorators, "ResolveField")) fn.node.attrs.resolveField = true;
        const gql = fn.decorators.find((d) => GQL_OPS[d.name]);
        const http = fn.decorators.find((d) => HTTP_VERBS[d.name]);
        if (!gql && !http) continue;
        markHandler(ctx, fn, classGuards, classPerms);

        if (gql) {
          const opName = literal(gql.args[0]) ?? fn.methodName;
          const id = `${repo.name}:op:graphql:${opName}`;
          ctx.node({
            id, kind: "Operation", name: `${GQL_OPS[gql.name]} ${opName}`, repo: repo.name, file: ctx.file, line: gql.line,
            keys: [`op:graphql:${opName}`], attrs: { protocol: "graphql", type: GQL_OPS[gql.name], operation: opName },
          });
          ctx.edge({ src: id, kind: "handles", dstKey: ctx.fnKey(fn.node.name), line: gql.line, attrs: { hint: ctx.file } });
        } else if (http) {
          const verb = HTTP_VERBS[http.name];
          const raw = `/${basePath}/${literal(http.args[0], "path") ?? ""}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
          const path = normalizeRestPath(raw);
          const id = `${repo.name}:op:rest:${verb} ${path}`;
          ctx.node({
            id, kind: "Operation", name: `${verb} ${raw}`, repo: repo.name, file: ctx.file, line: http.line,
            keys: [`op:rest:${verb} ${path}`], attrs: { protocol: "rest", type: verb, operation: path },
          });
          ctx.edge({ src: id, kind: "handles", dstKey: ctx.fnKey(fn.node.name), line: http.line, attrs: { hint: ctx.file } });
        }
      }
    }
  },
};

function markHandler(ctx: Parameters<NonNullable<FlowMapPlugin["extract"]>>[0], fn: FnInfo, classGuards: string[], classPerms: string[]) {
  const { config } = ctx;
  const guards = [...classGuards, ...guardNames(deco(fn.decorators, "UseGuards")?.args ?? [])];
  const permissions = [...classPerms, ...fn.decorators.filter((d) => config.permissionDecorators.includes(d.name)).map((d) => d.name)];
  const inputs = fn.params.filter((p) => deco(p.decorators, INPUT_DECORATORS));
  const argName = (p: (typeof inputs)[number]) => literal(deco(p.decorators, INPUT_DECORATORS)!.args[0]) ?? p.name;
  // checked by a pipe on the argument (@Body(new ZodValidationPipe(schema))) or by a schema in the body (schema.parse(body))
  const checked = (p: (typeof inputs)[number]) => /Pipe\b/.test(deco(p.decorators, INPUT_DECORATORS)!.args.join(",")) || VALIDATES.test(fn.body.getText());

  Object.assign(fn.node.attrs, {
    handler: true,
    guards,
    permissions,
    hasActor: fn.params.some((p) => p.decorators.some((d) => config.actorDecorators.includes(d.name))),
    idArgs: inputs.map(argName).filter((n) => /^id$|Id$|Ids$/.test(n)),
    inlineArgs: inputs.filter((p) => p.typeIsLiteral && !checked(p)).map(argName),
    input: inputs.map((p) => ({ name: argName(p), type: p.type, validated: checked(p) || (!p.typeIsLiteral && p.type !== "any") })),
  });

  for (const g of guards) {
    ctx.edge({ src: fn.node.id, kind: "guarded_by", dstKey: `guard:${g.replace(/\(.*$/, "")}`, line: fn.node.line, attrs: { label: g } });
  }
  // custom decorators defined in this repo (may wrap guards via applyDecorators)
  for (const d of fn.decorators) {
    const target = identKey(ctx, d.name);
    if (target) ctx.edge({ src: fn.node.id, kind: "decorated_by", dstKey: target.key, line: d.line, attrs: { hint: target.hint, label: d.name } });
  }
}
