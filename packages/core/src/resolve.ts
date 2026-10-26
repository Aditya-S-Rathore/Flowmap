import { ts } from "ts-morph";
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const CANDIDATE_SUFFIXES = ["", ...EXTS, ...EXTS.map((e) => "/index" + e)];

export interface Resolver {
  resolve(fromFile: string, spec: string): string | null;  // repo-relative path or null (external package)
  looksInternal(spec: string): boolean;                     // relative or matches a path alias / baseUrl folder
}

/** Resolves import specifiers using the repo's tsconfig (baseUrl + paths) against the set of indexed files. */
export function createResolver(repoRoot: string, files: Set<string>, tsconfigPath?: string): Resolver {
  const cfgPath = tsconfigPath ? resolve(repoRoot, tsconfigPath) : ["tsconfig.json", "jsconfig.json"].map((f) => join(repoRoot, f)).find(existsSync);
  let baseUrl: string | null = null;
  let paths: Record<string, string[]> = {};
  if (cfgPath) {
    const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(cfgPath));
    if (parsed.options.baseUrl) baseUrl = relative(repoRoot, parsed.options.baseUrl);
    paths = parsed.options.paths ?? {};
    if (!baseUrl && Object.keys(paths).length) baseUrl = relative(repoRoot, (parsed.options as any).pathsBasePath ?? dirname(cfgPath));
  }
  const topDirs = new Set<string>();
  if (baseUrl !== null) {
    for (const f of files) {
      const rel = baseUrl ? (f.startsWith(baseUrl + "/") ? f.slice(baseUrl.length + 1) : null) : f;
      if (rel && rel.includes("/")) topDirs.add(rel.split("/")[0]);
    }
  }

  const probe = (base: string): string | null => {
    const clean = normalize(base).replace(/\\/g, "/").replace(/^\.\//, "");
    for (const s of CANDIDATE_SUFFIXES) if (files.has(clean + s)) return clean + s;
    return null;
  };

  const aliasTargets = (spec: string): string[] => {
    const out: string[] = [];
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf("*");
      if (star === -1 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))) {
        const mid = star === -1 ? "" : spec.slice(star, spec.length - (pattern.length - star - 1));
        for (const t of targets) out.push(join(baseUrl ?? "", t.replace("*", mid)));
      }
    }
    return out;
  };

  return {
    resolve(fromFile, spec) {
      if (spec.startsWith(".")) return probe(join(dirname(fromFile), spec));
      for (const t of aliasTargets(spec)) {
        const hit = probe(t);
        if (hit) return hit;
      }
      if (baseUrl !== null) return probe(join(baseUrl, spec));
      return null;
    },
    looksInternal(spec) {
      if (spec.startsWith(".")) return !spec.includes("node_modules");
      if (aliasTargets(spec).length) return true;
      return !spec.includes("node_modules") && baseUrl !== null && spec.includes("/") && topDirs.has(spec.split("/")[0]);
    },
  };
}
