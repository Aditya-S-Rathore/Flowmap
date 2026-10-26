import type { FlowMapPlugin } from "@flowmap/core";

const TX_DECORATORS = ["Transactional"];

/** typeorm-transactional / plain TypeORM transaction boundaries. Call-site inTx/afterCommit flags come from core. */
export const typeormTransactional: FlowMapPlugin = {
  id: "typeorm-transactional",
  detect: (pkg) => !!(pkg.dependencies?.typeorm ?? pkg.devDependencies?.typeorm),

  extract(ctx) {
    for (const fn of ctx.fns) {
      if (fn.decorators.some((d) => TX_DECORATORS.includes(d.name))) fn.node.attrs.transactional = "decorator";
    }
    for (const cs of ctx.calls) {
      if (cs.method === "startTransaction") cs.fn.node.attrs.transactional ??= "queryRunner";
      if (ctx.config.afterCommit.includes(cs.method)) {
        cs.fn.node.attrs.usesAfterCommit = true;
        cs.claimed = true;
      }
    }
  },
};
