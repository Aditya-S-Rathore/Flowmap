import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_FILE, findWorkspace, Graph, indexWorkspace, initPython, Store, usesPython, type FlowMapConfig, type IndexStats, type Issue, type Workspace } from "@flowmap/core";
import { builtinPlugins, pluginRegistry } from "@flowmap/plugins";
import { rules } from "@flowmap/rules";

export interface RuleState { issues: Issue[]; suppressed: number }

// settings that don't change how code is parsed (so editing them never forces a re-index)
const parseKey = ({ rules, warnings, ...rest }: FlowMapConfig) => JSON.stringify({ ...rest, repos: rest.repos.map(({ screenshots, database, ...r }) => r) });

/** Fingerprint of FlowMap's own parsing code: when it changes (an update), existing indexes are rebuilt. */
let codeVersion: string | undefined;
function parserVersion() {
  if (codeVersion) return codeVersion;
  const h = createHash("sha1");
  for (const rel of ["../../core/src/", "../../plugins/src/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) h.update(f).update(readFileSync(join(dir, f)));
  }
  return (codeVersion = h.digest("hex"));
}

/** One workspace: its index, in-memory graph and current issues. Shared by CLI, MCP server and dashboard server. */
export class Engine {
  ws: Workspace;
  store: Store;
  graph!: Graph;
  issues: Issue[] = [];
  suppressed = 0;
  baseline = new Set<string>();
  baselineApis = new Set<string>();      // "repo\0operation name" recorded at the last baseline update
  lastStats: IndexStats | null = null;

  private constructor(ws: Workspace) {
    this.ws = ws;
    this.store = new Store(ws.dbPath);
  }

  static async open(workspaceFlag?: string, cwd = process.cwd()): Promise<Engine> {
    const e = new Engine(await findWorkspace(cwd, workspaceFlag));
    await e.prepareLanguages();
    e.loadBaseline();
    return e;
  }

  /** Python parsing needs its WebAssembly grammar loaded before indexing (only when a repo uses a Python plugin). */
  private async prepareLanguages() {
    if (this.ws.config.repos.some((r) => usesPython(r, pluginRegistry))) await initPython();
  }

  /** Incremental re-index (only changed files are parsed), then reload the graph and re-run rules. */
  refresh(full = false): IndexStats {
    const version = createHash("sha1").update(parserVersion()).update(parseKey(this.ws.config)).digest("hex");
    const stale = this.store.getMeta("indexVersion") !== version;
    this.lastStats = indexWorkspace(this.ws, pluginRegistry, { full: full || stale, store: this.store });
    this.store.setMeta("indexVersion", version);
    this.load();
    return this.lastStats;
  }

  /** Re-read the config and baselines. Re-index fully only when something that affects parsing changed; rule settings just re-run the rules. */
  async reload(): Promise<IndexStats | null> {
    const before = parseKey(this.ws.config);
    this.ws = await findWorkspace(this.ws.dir, this.ws.dir);
    await this.prepareLanguages();
    this.baseline.clear();
    this.baselineApis.clear();
    this.loadBaseline();
    if (parseKey(this.ws.config) !== before) return this.refresh();
    this.load();
    return null;
  }

  load() {
    this.graph = Graph.load(this.store, builtinPlugins);
    const { issues, suppressed } = this.runRules();
    this.issues = issues;
    this.suppressed = suppressed;
  }

  /** Each repo keeps its accepted issues in its own committed flowmap.baseline.json. */
  private loadBaseline() {
    for (const r of this.ws.config.repos) {
      const file = join(r.path, BASELINE_FILE);
      if (!existsSync(file)) continue;
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const f of saved.fingerprints) this.baseline.add(f);
      for (const a of saved.apis ?? []) this.baselineApis.add(`${r.name}\0${a}`);
    }
  }

  /** Writes the baseline of this workspace's own repo(s); connected repos keep theirs. Returns the files written. */
  saveBaseline(): string[] {
    const written: string[] = [];
    for (const r of this.ws.config.repos.filter((x) => !x.connected)) {
      const mine = this.issues.filter((i) => i.repo === r.name);
      const file = join(r.path, BASELINE_FILE);
      const apis = [...new Set([...this.graph.nodes.values()].filter((n) => n.kind === "Operation" && n.repo === r.name).map((n) => n.name))].sort();
      writeFileSync(file, JSON.stringify({ version: 1, fingerprints: mine.map((i) => i.id).sort(), apis }, null, 2) + "\n");
      for (const a of this.baselineApis) if (a.startsWith(`${r.name}\0`)) this.baselineApis.delete(a);
      for (const a of apis) this.baselineApis.add(`${r.name}\0${a}`);
      mine.forEach((i) => { this.baseline.add(i.id); i.status = "baseline"; });
      written.push(`${file} (${mine.length})`);
    }
    return written;
  }

  private runRules(): RuleState {
    const g = this.graph;
    const issues: Issue[] = [];
    let suppressed = 0;
    for (const rule of rules) {
      const configured = this.ws.config.rules[rule.id];
      if (configured === "off") continue;
      for (const f of rule.run(g, this.ws.config, { apis: this.baselineApis })) {
        const node = g.nodes.get(f.nodeId);
        const file = f.file ?? node?.file ?? "";
        const line = f.line ?? node?.line ?? 0;
        const repo = node?.repo ?? f.nodeId.split(":")[0];
        if (this.isSuppressed(rule.id, repo, file, line, node?.line)) {
          suppressed++;
          continue;
        }
        const severity = configured === "warn" ? "warn" : (f.severity ?? rule.severity);
        // file + name, no line numbers: stable when code moves inside a file; same-named handlers in different files stay distinct
        const id = fingerprint(rule.id, repo, node ? `${node.file}#${node.name}` : file, f.detail);
        issues.push({
          id, rule: rule.id, ruleTitle: rule.title, severity,
          status: this.baseline.has(id) ? "baseline" : "new",
          nodeId: f.nodeId, nodeName: node?.name ?? (file || f.detail), repo, file, line,
          message: f.message, why: rule.why, fix: rule.fix,
          path: (f.path ?? [f.nodeId]).map((pid) => {
            const n = g.nodes.get(pid);
            return { id: pid, kind: n?.kind ?? "Function", name: n?.name ?? pid, repo: n?.repo ?? repo, file: n?.file ?? "", line: n?.line ?? 0 };
          }),
        });
      }
    }
    issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.rule.localeCompare(b.rule));
    return { issues, suppressed };
  }

  /** `// flowmap-ignore <rule>: <reason>` on the line(s) above the finding or above the function. A reason is required. */
  private isSuppressed(rule: string, repo: string, file: string, line: number, nodeLine?: number) {
    const meta = this.graph.fileMeta.get(`${repo}\0${file}`);
    return (meta?.suppressions ?? []).some((s: { line: number; rule: string; reason: string }) =>
      (s.rule === rule || s.rule === "all") && s.reason &&
      ((s.line >= line - 3 && s.line <= line) || (nodeLine !== undefined && s.line >= nodeLine - 3 && s.line <= nodeLine)));
  }

  close() {
    this.store.close();
  }
}

export function fingerprint(rule: string, repo: string, subject: string, detail: string) {
  return createHash("sha1").update(`${rule}|${repo}|${subject}|${detail}`).digest("hex").slice(0, 16);
}

