import { Node } from "ts-morph";
import { flags, type FlowMapPlugin } from "@flowmap/core";
import { normalizeRestPath } from "./util.ts";

const VERBS = new Set(["get", "post", "put", "patch", "delete"]);
const FETCH_LIKE = /^(fetch|\$fetch|useFetch|useLazyFetch|ofetch)$/;
const INTERNAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|[\w-]+)(:\d+)?$/;

/**
 * URL-based HTTP calls: absolute URLs become External(HTTP host) edges, relative ones become REST requests
 * that the linker matches to backend operations. Type-based clients (Stripe, S3, axios instances) are handled by core.
 */
export const httpClients: FlowMapPlugin = {
  id: "http-clients",
  detect: (pkg) => !!(pkg.dependencies?.axios ?? pkg.dependencies?.["@nestjs/axios"]),

  extract(ctx) {
    for (const cs of ctx.calls) {
      if (cs.claimed) continue;
      const isFetch = FETCH_LIKE.test(cs.root ?? "") && cs.segments.length === 0;
      if (!isFetch && !VERBS.has(cs.method)) continue;
      const a = cs.call.getArguments()[0];
      if (!a) continue;
      let url: string | null = null;
      if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) url = a.getLiteralValue();
      else if (Node.isTemplateExpression(a)) url = a.getText().slice(1, -1);
      if (!url || !url.includes("/")) continue;

      const verb = isFetch ? fetchVerb(cs.call.getArguments()[1]?.getText()) : cs.method.toUpperCase();
      // http://billing:8000/x, http://localhost:3000/x: an internal service (container / k8s name), linked like a relative path
      const host = /^https?:\/\/([^/$]+)/.exec(url)?.[1];
      if (host && !INTERNAL_HOST.test(host)) {
        ctx.edge({ src: cs.fn.node.id, kind: "calls_external", dstKey: `ext:HTTP ${host}`, line: cs.line, attrs: { ...flags(cs), method: verb, write: verb !== "GET", label: `HTTP ${host}` } });
      } else {
        const path = normalizeRestPath(url.replace(/^https?:\/\/[^/]+/, ""));
        ctx.edge({ src: cs.fn.node.id, kind: "requests", dstKey: `op:rest:${verb} ${path}`, line: cs.line, attrs: { ...flags(cs), method: verb, label: `${verb} ${path}` } });
      }
      cs.claimed = true;
    }
  },
};

function fetchVerb(opts: string | undefined) {
  return /method\s*:\s*['"`](\w+)/i.exec(opts ?? "")?.[1].toUpperCase() ?? "GET";
}
