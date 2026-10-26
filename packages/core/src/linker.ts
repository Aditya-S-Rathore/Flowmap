import type { Store } from "./store.ts";

interface Candidate { id: string; repo: string; file: string }

const VIRTUAL_KINDS: Record<string, string> = { ext: "External", table: "Table", queue: "Queue", guard: "Guard" };

/**
 * Canonical form of a screen path so links match routes from any router:
 * /users/:id, /users/[id], /users/$id, /users/{id}, /users/<int:id> → /users/:p; [...rest], $, ** → *.
 * Names that are not paths (mobile screen names) are kept as they are.
 */
export function normRoute(path: string): string {
  const p = path.replace(/#.*$/, "").replace(/(?<!:\w+)\?.*$/, "").trim();     // drop ?query, keep optional :param?
  if (!p.startsWith("/")) return p;
  const segs = p.split("/").filter(Boolean).map((s) =>
    /^\[\[?\.\.\./.test(s) || s === "$" || s === "**" || s === "*" ? "*"
      : /^:\w+\?$|^\[\[\w+\]\]$|^\(\$\w+\)$/.test(s) ? ":p?"              // optional: /chat/:sessionId?, [[lang]], ($lang)
      : /^(:|\[|\$|\{|<)/.test(s) ? ":p"
      : s);
  return "/" + segs.join("/");
}

/** Best route for a link path: exact segments win, `:p` matches one segment, `*` the rest. */
function matchRoute(routes: string[], key: string): string | undefined {
  const want = key.slice(6).split("/").filter(Boolean);
  let best: string | undefined;
  let bestScore = -1;
  for (const r of routes) {
    const have = r.slice(6).split("/").filter(Boolean);
    let score = 0;
    let ok = true;
    for (let i = 0; i < Math.max(want.length, have.length); i++) {
      const h = have[i];
      if (h === "*") break;
      const w = want[i];
      if (h === ":p?" && w === undefined) continue;
      if (h === undefined || w === undefined) { ok = false; break; }
      if (h === w) score += 2;
      else if (h === ":p" || h === ":p?" || w === ":p") score += 1;
      else { ok = false; break; }
    }
    if (ok && score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

/** Resolve every edge's symbolic dst_key to a node id. Runs over the whole graph; cheap enough to repeat after each change. */
export function link(store: Store) {
  const db = store.db;
  db.exec("DELETE FROM node_keys WHERE node_id IN (SELECT id FROM nodes WHERE virtual = 1); DELETE FROM nodes WHERE virtual = 1;");

  const consts = new Map<string, string>();
  for (const r of db.prepare("SELECT repo, key, value FROM constants").all() as any[]) {
    const k = `${r.repo}\0${r.key}`;
    if (!consts.has(k)) consts.set(k, r.value);
  }
  const constValue = (repo: string, name: string): string | null => {
    const v = consts.get(`${repo}\0${name}`);
    if (v === undefined) return null;
    return v.startsWith("gql:") ? v.slice(4).split(",")[0] : v;
  };
  // {const:X} must resolve; {param:X} falls back to a path parameter
  const resolveKey = (repo: string, key: string): string | null => {
    let ok = true;
    const out = key.replace(/\{(const|gql|param):([^}]+)\}/g, (_, kind, name) => {
      const v = constValue(repo, name);
      if (v === null && kind !== "param") ok = false;
      return v ?? ":p";
    });
    if (!ok || /^route:\w+:\/\//.test(out)) return null;     // a constant holding an absolute URL is not a screen
    return out.startsWith("route:") ? `route:${normRoute(out.slice(6))}` : out;
  };

  // display names that point at constants (e.g. route path PATHNAME.BILLING)
  const rename = db.prepare("UPDATE nodes SET name = ? WHERE id = ?");
  for (const n of db.prepare("SELECT id, repo, attrs FROM nodes WHERE attrs LIKE '%\"nameRef\"%'").all() as any[]) {
    const name = resolveKey(n.repo, JSON.parse(n.attrs).nameRef);
    if (name) rename.run(name, n.id);
  }
  // every screen is reachable by its canonical path (or name)
  db.exec("DELETE FROM node_keys WHERE key LIKE 'route:%'");
  const insKey = db.prepare("INSERT INTO node_keys (key, node_id) VALUES (?, ?)");
  for (const r of db.prepare("SELECT id, name FROM nodes WHERE kind = 'Route'").all() as any[]) insKey.run(`route:${normRoute(r.name)}`, r.id);

  const byKey = new Map<string, Candidate[]>();
  for (const r of db.prepare("SELECT k.key, n.id, n.repo, n.file FROM node_keys k JOIN nodes n ON n.id = k.node_id").all() as any[]) {
    const key = r.key.includes("{") ? resolveKey(r.repo, r.key) ?? r.key : r.key;      // queue:{const:QUEUE} → queue:email
    const list = byKey.get(key) ?? [];
    list.push({ id: r.id, repo: r.repo, file: r.file });
    byKey.set(key, list);
  }
  const restKeys = [...byKey.keys()].filter((k) => k.startsWith("op:rest:"));
  const routeKeys = [...byKey.keys()].filter((k) => k.startsWith("route:/"));

  const inherited = (repo: string, key: string): Candidate[] | undefined => {
    const m = /^fn:([^:]+):(\w+)\.(.+)$/.exec(key);
    if (!m) return undefined;
    let cls = m[2];
    for (let i = 0; i < 5; i++) {
      const parent = consts.get(`${repo}\0__extends:${cls}`);
      if (!parent) return undefined;
      const hit = byKey.get(`fn:${m[1]}:${parent}.${m[3]}`);
      if (hit) return hit;
      cls = parent;
    }
    return undefined;
  };

  const insVirtual = db.prepare("INSERT OR IGNORE INTO nodes (id, kind, name, repo, file, line, end_line, attrs, virtual) VALUES (?, ?, ?, '', '', 0, 0, '{}', 1)");
  const update = db.prepare("UPDATE edges SET dst = ?, confidence = ?, resolved_key = ? WHERE id = ?");

  for (const e of db.prepare("SELECT id, dst_key, repo, attrs FROM edges").all() as any[]) {
    const attrs = JSON.parse(e.attrs);
    const key = e.dst_key.includes("{") || e.dst_key.startsWith("route:") ? resolveKey(e.repo, e.dst_key) : e.dst_key;
    if (!key) {
      update.run(null, null, null, e.id);
      continue;
    }
    let cands = byKey.get(key) ?? inherited(e.repo, key);
    if (!cands && key.startsWith("op:rest:")) {
      // frontend URLs often carry a base prefix: match on path suffix with the same verb (or a catch-all handler)
      const [verb, path] = key.slice(8).split(" ");
      const hit = byKey.has(`op:rest:ALL ${path}`) ? `op:rest:ALL ${path}` : restKeys.find((k) => {
        const [v, p] = k.slice(8).split(" ");
        return (v === verb || v === "ALL") && (p.endsWith(path) || path.endsWith(p));
      });
      if (hit) cands = byKey.get(hit);
    }
    if (!cands && key.startsWith("route:/")) {
      const hit = matchRoute(routeKeys, key);
      if (hit) cands = byKey.get(hit);
    }
    if (!cands) {
      const prefix = key.split(":")[0];
      if (VIRTUAL_KINDS[prefix]) {
        const label = key.slice(prefix.length + 1);
        insVirtual.run(key, VIRTUAL_KINDS[prefix], label);
        cands = [{ id: key, repo: "", file: "" }];
        byKey.set(key, cands);
        insKey.run(key, key);
      }
    }
    if (!cands?.length) {
      update.run(null, null, key, e.id);
      continue;
    }
    let pick = cands[0];
    let confidence = cands.length === 1 ? "exact" : "inferred";
    if (cands.length > 1) {
      const byHint = cands.find((c) => c.repo === e.repo && c.file === attrs.hint);
      const sameRepo = cands.find((c) => c.repo === e.repo);
      if (byHint) { pick = byHint; confidence = "exact"; }
      else if (sameRepo) pick = sameRepo;
    }
    update.run(pick.id, confidence, key, e.id);
  }
}
