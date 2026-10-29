import { withoutRollback } from "./indexes.ts";

/**
 * What in a migration can lock a busy table or fail on one that has rows (PostgreSQL). Read from SQL, in .sql files or in strings
 * inside migrations; rollback code is skipped. A table the migration creates itself is empty, so it is never a risk.
 */
export interface MigrationRisk {
  rule: "index-locks" | "not-null-no-default" | "fk-validates" | "type-rewrite" | "concurrent-in-tx";
  table: string | null;
  line: number;
}

const bare = (t: string) => t.replace(/["'`[\]]/g, "").split(".").pop()!;
const ALTER = String.raw`\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w."]+)\s+`;

export function migrationRisks(file: string, raw: string): MigrationRisk[] {
  if (!/\b(index|alter\s+table)\b/i.test(raw) || /\.down\.sql$/i.test(file)) return [];
  const text = withoutRollback(raw);
  const line = (at: number) => text.slice(0, at).split("\n").length;
  const created = new Set([...text.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)].map((m) => bare(m[1])));
  const out: MigrationRisk[] = [];
  const add = (rule: MigrationRisk["rule"], t: string | null, at: number) => { if (!t || !created.has(t)) out.push({ rule, table: t, line: line(at) }); };

  for (const m of text.matchAll(/\bcreate\s+(?:unique\s+)?index\s+(?!concurrently\b)(?:if\s+not\s+exists\s+)?(?:\S+\s+)?on\s+(?:only\s+)?([\w."]+)/gi)) add("index-locks", bare(m[1]), m.index!);
  for (const m of text.matchAll(new RegExp(`${ALTER}add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?([^;]*)`, "gi"))) {
    const clause = m[2].split(/,\s*(?=add\b)/i)[0];
    if (/^(?:constraint|foreign|primary|unique|check)\b/i.test(clause.trim())) {
      if (/foreign\s+key/i.test(clause) && !/not\s+valid/i.test(clause)) add("fk-validates", bare(m[1]), m.index!);
    } else if (/\bnot\s+null\b/i.test(clause) && !/\bdefault\b/i.test(clause)) add("not-null-no-default", bare(m[1]), m.index!);
  }
  for (const m of text.matchAll(new RegExp(`${ALTER}alter\\s+column\\s+\\S+\\s+(?:set\\s+data\\s+)?type\\b`, "gi"))) add("type-rewrite", bare(m[1]), m.index!);
  // CONCURRENTLY can't run inside a transaction, and most migration tools wrap each migration in one unless told not to
  const concurrent = /\bconcurrently\b/i.exec(text);
  if (concurrent && !/\btransaction\s*[=:]\s*(?:false|["']none["'])|autocommit/i.test(text)) add("concurrent-in-tx", null, concurrent.index);
  return out;
}
