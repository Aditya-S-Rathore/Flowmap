import { flags, type FlowMapPlugin } from "@flowmap/core";
import { deco, literal } from "./util.ts";

// "email" → email; QUEUE_NAME → {const:QUEUE_NAME}, resolved by the linker (producer and worker may spell it differently)
const queueName = (arg: string | undefined) => literal(arg) ?? (arg && /^[\w.]+$/.test(arg) ? `{const:${arg}}` : arg);

export const bullmq: FlowMapPlugin = {
  id: "bullmq",
  detect: (pkg) => !!(pkg.dependencies?.bullmq ?? pkg.dependencies?.bull ?? pkg.dependencies?.["@nestjs/bullmq"] ?? pkg.dependencies?.["@nestjs/bull"]),

  extract(ctx) {
    for (const cls of ctx.classes.values()) {
      const proc = deco(cls.decorators, "Processor");
      if (!proc) continue;
      const name = queueName(proc.args[0]) ?? cls.name;
      const id = `${ctx.repo.name}:queue:${name}`;
      ctx.node({ id, kind: "Queue", name: `queue ${name}`, repo: ctx.repo.name, file: ctx.file, line: proc.line, keys: [`queue:${name}`], attrs: name.includes("{") ? { nameRef: `queue ${name}` } : {} });
      for (const fn of ctx.fns.filter((f) => f.cls === cls)) {
        if (deco(fn.decorators, "Process") || fn.methodName === "process") {
          ctx.edge({ src: id, kind: "triggers", dstKey: ctx.fnKey(fn.node.name), line: fn.node.line, attrs: { hint: ctx.file } });
        }
      }
    }
    for (const cs of ctx.calls) {
      const q = deco(cs.field?.decorators ?? [], "InjectQueue");
      if (!q || !/^add(Bulk)?$/.test(cs.method)) continue;
      ctx.edge({ src: cs.fn.node.id, kind: "enqueues", dstKey: `queue:${queueName(q.args[0])}`, line: cs.line, attrs: { ...flags(cs), method: cs.method } });
      cs.claimed = true;
    }
  },
};
