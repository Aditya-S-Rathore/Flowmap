import { Project, ts } from "ts-morph";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative } from "node:path";
import { ALWAYS_IGNORE } from "./config.ts";
import { EMBED_EXT, splitComponent } from "./embedded.ts";
import { buildFileContext, DEFAULT_EXTERNALS, emitDefaultEdges } from "./extract.ts";
import { indexFacts } from "./indexes.ts";
import { emitPyDefaultEdges, extractPython } from "./python.ts";
import { createResolver } from "./resolve.ts";
import { link } from "./linker.ts";
import { Store } from "./store.ts";
import type { FlowMapPlugin, GraphEdge, GraphNode, RepoConfig, Workspace } from "./types.ts";
import type { UiEl } from "./ui.ts";

const TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PY_EXT = /\.py$/;
const SQL_EXT = /\.sql$/;     // read only for the indexes they create
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".flowmap", ".next", ".nuxt", ".svelte-kit", ".output", ".turbo", ".cache", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "site-packages"]);
const ROOT_MARKERS = new Set(["package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod"]);
const BATCH = 200;

export interface IndexStats {
  files: number;
  changed: number;
  removed: number;
  durationMs: number;
}

/** Source files to index, plus package roots (folders with package.json / pyproject.toml / ...) for monorepos. */
function discover(repo: RepoConfig, ignore: string[], exts: (name: string) => boolean): { files: string[]; roots: string[] } {
  const patterns = [...ALWAYS_IGNORE, ...ignore];
  const files: string[] = [];
  const roots = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile()) {
        const rel = relative(repo.path, join(dir, e.name));
        if (ROOT_MARKERS.has(e.name)) roots.add(dirname(rel) === "." ? "" : dirname(rel));
        if (exts(e.name) && !patterns.some((p) => matchesGlob(rel, p))) files.push(rel);
      }
    }
  };
  walk(repo.path);
  roots.add("");
  return { files, roots: [...roots].sort((a, b) => b.length - a.length) };
}

export function activePlugins(repo: RepoConfig, registry: Map<string, FlowMapPlugin>): FlowMapPlugin[] {
  return repo.plugins.map((id) => {
    const p = registry.get(id);
    if (!p) throw new Error(`Unknown plugin "${id}" in repo "${repo.name}". Available: ${[...registry.keys()].join(", ")}`);
    return p;
  });
}

/** A repo is read as Python too when one of its plugins handles Python files. */
export const usesPython = (repo: RepoConfig, registry: Map<string, FlowMapPlugin>) => repo.plugins.some((id) => !!registry.get(id)?.extractPy);

/**
 * Incremental by default: only files whose mtime/size changed are hashed, and only files whose hash changed are re-parsed.
 * `only` limits the scan to specific absolute paths (watch mode).
 */
export function indexWorkspace(ws: Workspace, registry: Map<string, FlowMapPlugin>, opts: { full?: boolean; store?: Store } = {}): IndexStats {
  const started = Date.now();
  const store = opts.store ?? new Store(ws.dbPath);
  let total = 0, changed = 0, removed = 0;
  const externals = { ...DEFAULT_EXTERNALS, ...ws.config.externals };

  // drop repos that are no longer in the config (e.g. removed from `connect`)
  const names = new Set(ws.config.repos.map((r) => r.name));
  for (const f of store.allFileMeta()) {
    if (!names.has(f.repo)) {
      store.deleteFile(f.repo, f.path);
      removed++;
    }
  }

  for (const repo of ws.config.repos) {
    const plugins = activePlugins(repo, registry);
    const textExts = plugins.flatMap((p) => p.textExtensions ?? []);
    const python = usesPython(repo, registry);
    const { files, roots } = discover(repo, [...ws.config.ignore, ...(repo.ignore ?? [])], (name) =>
      TS_EXT.test(name) || EMBED_EXT.test(name) || SQL_EXT.test(name) || (python && PY_EXT.test(name)) || textExts.some((x) => name.endsWith(x)));
    store.setMeta(`roots:${repo.name}`, JSON.stringify(roots));
    total += files.length;
    const known = store.files(repo.name);
    const fileSet = new Set(files);
    const resolver = createResolver(repo.path, fileSet, repo.tsconfig);

    for (const path of known.keys()) {
      if (!fileSet.has(path)) {
        store.deleteFile(repo.name, path);
        removed++;
      }
    }

    const todo: { path: string; text: string; hash: string; mtime: number; size: number }[] = [];
    for (const path of files) {
      const st = statSync(join(repo.path, path));
      const prev = known.get(path);
      if (!opts.full && prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue;
      const text = readFileSync(join(repo.path, path), "utf8");
      const hash = createHash("sha1").update(text).digest("hex");
      if (!opts.full && prev && prev.hash === hash) {
        store.touchFile(repo.name, path, st.mtimeMs, st.size);
        continue;
      }
      todo.push({ path, text, hash, mtime: st.mtimeMs, size: st.size });
    }
    changed += todo.length;

    for (let i = 0; i < todo.length; i += BATCH) {
      const project = new Project({
        useInMemoryFileSystem: true,
        skipLoadingLibFiles: true,
        compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, experimentalDecorators: true },
      });
      store.tx(() => {
        for (const f of todo.slice(i, i + BATCH)) {
          const hasFile = (p: string) => fileSet.has(p);
          const embedded = EMBED_EXT.test(f.path) ? splitComponent(f.path, f.text) : null;
          let out: { nodes: GraphNode[]; edges: GraphEdge[]; constants: [string, string][]; meta: Record<string, any>; ui?: [string, UiEl][] };
          if (PY_EXT.test(f.path)) {
            const { ctx, nodes, edges, constants, done } = extractPython(f.text, { repo, file: f.path, config: ws.config, hasFile, roots });
            try {
              for (const p of plugins) p.extractPy?.(ctx);
              emitPyDefaultEdges(ctx, externals);
            } finally {
              done();
            }
            out = { nodes, edges, constants, meta: ctx.meta };
          } else if (TS_EXT.test(f.path) || embedded) {
            const sf = embedded
              ? project.createSourceFile(`/${f.path}.${embedded.tsx ? "tsx" : "ts"}`, embedded.code, { overwrite: true })
              : project.createSourceFile("/" + f.path, f.text, { overwrite: true });
            const { ctx, ...rest } = buildFileContext(sf, {
              repo,
              file: f.path,
              config: ws.config,
              roots,
              hasFile,
              template: embedded?.template,
              resolveImport: (spec) => resolver.resolve(f.path, spec),
            }, embedded?.name);
            for (const p of plugins) p.extract?.(ctx);
            emitDefaultEdges(ctx, externals);
            out = { ...rest, meta: { ...ctx.meta, imports: (ctx.meta.imports as any[]).filter((imp) => resolver.looksInternal(imp.spec)) } };
            project.removeSourceFile(sf);
          } else {
            out = { nodes: [], edges: [], constants: [], meta: {} };
            const textCtx = {
              repo, file: f.path,
              node: (n: any) => { const full = { endLine: n.line, keys: [], attrs: {}, ...n }; out.nodes.push(full); return full; },
              edge: (e: any) => { out.edges.push({ ...e, repo: repo.name, file: e.file ?? f.path }); },
              constant: (k: string, v: string) => { out.constants.push([k, v]); },
            };
            for (const p of plugins) if (p.textExtensions?.some((x) => f.path.endsWith(x))) p.extractText?.(f.path, f.text, textCtx);
          }
          const indexes = indexFacts(f.path, f.text);
          if (indexes.length) out.meta.indexes = indexes;
          store.writeFile({ repo: repo.name, path: f.path, hash: f.hash, mtime: f.mtime, size: f.size, meta: JSON.stringify(out.meta) }, out.nodes, out.edges, out.constants, out.ui);
        }
      });
    }
  }

  store.tx(() => link(store));
  const durationMs = Date.now() - started;
  store.setMeta("indexedAt", new Date().toISOString());
  store.setMeta("lastDurationMs", String(durationMs));
  if (!opts.store) store.close();
  return { files: total, changed, removed, durationMs };
}
