import { existsSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import type { FlowMapConfig, RepoConfig, Workspace } from "./types.ts";

export const CONFIG_NAMES = ["flowmap.config.mjs", "flowmap.config.js", "flowmap.config.ts", "flowmap.config.json"];
export const BASELINE_FILE = "flowmap.baseline.json";

export const DEFAULTS: Omit<FlowMapConfig, "name" | "repos" | "warnings"> = {
  clients: [],
  externals: {},
  afterCommit: ["runOnTransactionCommit", "runOnTransactionComplete", "on_commit"],
  ignore: [],
  rules: {},
  actorDecorators: ["GqlUser", "CurrentUser", "AuthUser", "User", "Req", "Request", "Context", "Ctx", "RestActor", "ApiClient", "Actor"],
  permissionDecorators: ["RequireOrgPermission", "RequirePermission", "Permissions", "Roles", "ApiScope", "OrgProtected", "AdminOnly"],
  publicOperations: "login|logout|signup|signin|register|auth|token|refresh|health|webhook|callback|oauth|verify|reset|forgot|public|confirm",
  authzGuards: "admin|role|permission|org|scope|owner|apikey|internal|secret|callback|signature",
};

// Never read, whatever the config says.
export const ALWAYS_IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.git/**", "**/.flowmap/**", "**/*.d.ts", "**/.env*", "**/*.pem", "**/*.key"];

export function expandHome(p: string) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function configIn(dir: string): string | null {
  return CONFIG_NAMES.map((n) => join(dir, n)).find((p) => existsSync(p)) ?? null;
}

async function readRaw(path: string): Promise<any> {
  return path.endsWith(".json")
    ? JSON.parse(readFileSync(path, "utf8"))
    : (await import(pathToFileURL(path).href + `?t=${Date.now()}`)).default;
}

/** One repo described by its own config file (the usual case: config committed at the repo root). */
function repoFrom(raw: any, dir: string): RepoConfig {
  return { name: raw.name ?? basename(dir), path: dir, plugins: raw.plugins ?? [], ignore: raw.ignore ?? [], tsconfig: raw.tsconfig, base: raw.base, database: raw.database, ...(raw.screenshots ? { screenshots: raw.screenshots } : {}) };
}

/**
 * Two shapes:
 *  - repo config:      { name, plugins, externals, clients, ignore, rules, connect: ["../other-repo"] }
 *  - workspace config: { name, repos: [{ name, path, plugins }], ... }  (several repos from one neutral folder)
 * `connect` loads each sibling repo's own config, so its plugins/externals are defined once, in that repo.
 */
async function loadConfigFile(path: string): Promise<FlowMapConfig> {
  const raw = await readRaw(path);
  const dir = dirname(path);
  const warnings: string[] = [];
  let repos: RepoConfig[];
  let externals = { ...raw.externals };
  let clients = [...(raw.clients ?? [])];

  if (raw.repos) {
    repos = raw.repos.map((r: RepoConfig) => ({ ...r, path: resolve(dir, expandHome(r.path)), plugins: r.plugins ?? [] }));
  } else {
    repos = [repoFrom(raw, dir)];
    for (const rel of raw.connect ?? []) {
      const other = resolve(dir, expandHome(rel));
      const otherConfig = existsSync(other) ? configIn(other) : null;
      if (!otherConfig) {
        warnings.push(`connect: ${rel} ${existsSync(other) ? "has no FlowMap config" : "is not checked out"} — cross-repo checks are skipped`);
        continue;
      }
      const o = await readRaw(otherConfig);
      repos.push({ ...repoFrom(o, other), connected: true });
      externals = { ...o.externals, ...externals };
      clients = [...clients, ...(o.clients ?? [])];
    }
  }
  repos = repos.map((r) => ({ ...r, database: r.database ?? detectDatabase(r.path) }));
  return { ...DEFAULTS, ...raw, name: raw.name ?? basename(dir), repos, externals, clients, warnings };
}

function findUp(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const hit = configIn(dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** --workspace <dir>, else the nearest flowmap.config.* above cwd. */
export async function findWorkspace(cwd = process.cwd(), flag?: string): Promise<Workspace> {
  const configPath = flag ? configIn(resolve(flag)) : findUp(cwd);
  if (!configPath) throw new Error(flag ? `No FlowMap config found in ${resolve(flag)}` : "No FlowMap config found. Run `flowmap init` in the repo root first.");
  const config = await loadConfigFile(configPath);
  const dir = dirname(configPath);
  return { dir, configPath, config, dbPath: join(dir, ".flowmap", "index.db") };
}

export function gitRoot(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Add `.flowmap/` (the local index) to the repo's .gitignore; config and baseline stay committable. */
export function ignoreIndex(dir: string): boolean {
  const file = join(dir, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === ".flowmap/" || l.trim() === ".flowmap")) return false;
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}\n# FlowMap local index\n.flowmap/\n`);
  return true;
}

/** The database a repo talks to, from its driver dependencies; undefined when unclear (none, or several). */
function detectDatabase(root: string): string | undefined {
  const deps = Object.keys(detectDeps(root).dependencies);
  const found = Object.entries(DRIVERS).filter(([, re]) => deps.some((d) => re.test(d))).map(([db]) => db);
  return found.length === 1 ? found[0] : undefined;
}

const DRIVERS: Record<string, RegExp> = {
  postgres: /^(pg|postgres|pg-promise|@neondatabase\/serverless|@vercel\/postgres|psycopg2?(-binary)?|psycopg|asyncpg)$/,
  mysql: /^(mysql2?|mariadb|mysqlclient|pymysql|aiomysql|mysql-connector-python)$/,
  sqlite: /^(sqlite3|better-sqlite3|aiosqlite)$/,
  mssql: /^(mssql|tedious|pyodbc|pymssql)$/,
};

const DEP_SKIP = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".svelte-kit", "coverage"]);

/**
 * Dependencies declared anywhere in a repo (package.json, requirements*.txt, pyproject.toml), merged, names lower-cased for Python.
 * Used to pick plugins in `flowmap init` and to suggest missing ones.
 */
export function detectDeps(root: string, maxDepth = 3): { dependencies: Record<string, string>; python: boolean } {
  const deps: Record<string, string> = {};
  let python = false;
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !DEP_SKIP.has(e.name) && !e.name.startsWith(".")) walk(p, depth + 1);
      } else if (e.name === "package.json") {
        try {
          const pkg = JSON.parse(readFileSync(p, "utf8"));
          Object.assign(deps, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies);
        } catch { /* not JSON */ }
      } else if (/^requirements.*\.txt$|^pyproject\.toml$|^Pipfile$|^setup\.py$/.test(e.name)) {
        python = true;
        const text = readFileSync(p, "utf8");
        const add = (name: string) => { deps[name.toLowerCase().replace(/_/g, "-")] = "*"; };
        if (e.name === "requirements.txt" || e.name.startsWith("requirements")) {
          for (const m of text.matchAll(/^\s*([A-Za-z][\w.-]*)/gm)) add(m[1]);
        } else {
          // pyproject [project] dependencies = [...], setup.py install_requires=[...], Poetry / Pipfile "name = version" sections
          for (const block of text.matchAll(/(?:dependencies|install_requires|requires)\s*=\s*\[([\s\S]*?)\]/g)) for (const m of block[1].matchAll(/["']([A-Za-z][\w.-]*)/g)) add(m[1]);
          for (const sec of text.matchAll(/^\[(?:tool\.poetry(?:\.group\.[\w-]+)?\.dependencies|packages|dev-packages)\]([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) for (const m of sec[1].matchAll(/^\s*([A-Za-z][\w.-]*)\s*=/gm)) add(m[1]);
        }
      }
    }
  };
  walk(root, 0);
  return { dependencies: deps, python };
}
