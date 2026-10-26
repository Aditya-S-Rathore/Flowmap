import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphEdge, GraphNode } from "./types.ts";

const SCHEMA_VERSION = "4";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
  repo TEXT, path TEXT, hash TEXT, mtime REAL, size INTEGER, meta TEXT,
  PRIMARY KEY (repo, path)
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, kind TEXT, name TEXT, repo TEXT, file TEXT,
  line INTEGER, end_line INTEGER, attrs TEXT, virtual INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS node_keys (key TEXT, node_id TEXT);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY, src TEXT, dst TEXT, dst_key TEXT, resolved_key TEXT, kind TEXT, repo TEXT,
  file TEXT, line INTEGER, confidence TEXT, attrs TEXT
);
CREATE TABLE IF NOT EXISTS constants (repo TEXT, file TEXT, key TEXT, value TEXT);
CREATE TABLE IF NOT EXISTS ui (repo TEXT, file TEXT, node_id TEXT PRIMARY KEY, tree TEXT);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes (repo, file);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes (name);
CREATE INDEX IF NOT EXISTS keys_key ON node_keys (key);
CREATE INDEX IF NOT EXISTS keys_node ON node_keys (node_id);
CREATE INDEX IF NOT EXISTS edges_src ON edges (src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges (dst);
CREATE INDEX IF NOT EXISTS edges_file ON edges (repo, file);
CREATE INDEX IF NOT EXISTS consts_key ON constants (repo, key);
CREATE INDEX IF NOT EXISTS consts_file ON constants (repo, file);
CREATE INDEX IF NOT EXISTS ui_file ON ui (repo, file);
`;

export interface FileRow { repo: string; path: string; hash: string; mtime: number; size: number; meta: string }

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    const version = this.tryMeta("schema");
    if (version && version !== SCHEMA_VERSION) {
      this.db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS node_keys; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS constants; DROP TABLE IF EXISTS ui;");
    }
    this.db.exec(SCHEMA);
    this.setMeta("schema", SCHEMA_VERSION);
  }

  private tryMeta(key: string): string | null {
    try {
      return this.getMeta(key);
    } catch {
      return null;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  files(repo: string): Map<string, FileRow> {
    const rows = this.db.prepare("SELECT * FROM files WHERE repo = ?").all(repo) as unknown as FileRow[];
    return new Map(rows.map((r) => [r.path, r]));
  }

  allFileMeta(): { repo: string; path: string; meta: any }[] {
    const rows = this.db.prepare("SELECT repo, path, meta FROM files").all() as unknown as FileRow[];
    return rows.map((r) => ({ repo: r.repo, path: r.path, meta: JSON.parse(r.meta || "{}") }));
  }

  deleteFile(repo: string, path: string) {
    this.db.prepare("DELETE FROM node_keys WHERE node_id IN (SELECT id FROM nodes WHERE repo = ? AND file = ?)").run(repo, path);
    this.db.prepare("DELETE FROM nodes WHERE repo = ? AND file = ?").run(repo, path);
    this.db.prepare("DELETE FROM edges WHERE repo = ? AND file = ?").run(repo, path);
    this.db.prepare("DELETE FROM constants WHERE repo = ? AND file = ?").run(repo, path);
    this.db.prepare("DELETE FROM ui WHERE repo = ? AND file = ?").run(repo, path);
    this.db.prepare("DELETE FROM files WHERE repo = ? AND path = ?").run(repo, path);
  }

  writeFile(row: FileRow, nodes: GraphNode[], edges: GraphEdge[], constants: [string, string][], ui: [string, unknown][] = []) {
    this.deleteFile(row.repo, row.path);
    this.db.prepare("INSERT INTO files (repo, path, hash, mtime, size, meta) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.repo, row.path, row.hash, row.mtime, row.size, row.meta);
    const insNode = this.db.prepare("INSERT OR REPLACE INTO nodes (id, kind, name, repo, file, line, end_line, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insKey = this.db.prepare("INSERT INTO node_keys (key, node_id) VALUES (?, ?)");
    for (const n of nodes) {
      insNode.run(n.id, n.kind, n.name, n.repo, n.file, n.line, n.endLine, JSON.stringify(n.attrs));
      for (const k of n.keys) insKey.run(k, n.id);
    }
    const insEdge = this.db.prepare("INSERT INTO edges (src, dst, dst_key, kind, repo, file, line, confidence, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of edges) insEdge.run(e.src, e.dst ?? null, e.dstKey, e.kind, e.repo, e.file, e.line, e.confidence ?? null, JSON.stringify(e.attrs));
    const insConst = this.db.prepare("INSERT INTO constants (repo, file, key, value) VALUES (?, ?, ?, ?)");
    for (const [k, v] of constants) insConst.run(row.repo, row.path, k, v);
    const insUi = this.db.prepare("INSERT OR REPLACE INTO ui (repo, file, node_id, tree) VALUES (?, ?, ?, ?)");
    for (const [id, tree] of ui) insUi.run(row.repo, row.path, id, JSON.stringify(tree));
  }

  /** A component's wireframe tree (kept out of the graph so normal queries stay light). */
  ui(nodeId: string): unknown | null {
    const r = this.db.prepare("SELECT tree FROM ui WHERE node_id = ?").get(nodeId) as { tree: string } | undefined;
    return r ? JSON.parse(r.tree) : null;
  }

  touchFile(repo: string, path: string, mtime: number, size: number) {
    this.db.prepare("UPDATE files SET mtime = ?, size = ? WHERE repo = ? AND path = ?").run(mtime, size, repo, path);
  }

  close() {
    this.db.close();
  }
}
