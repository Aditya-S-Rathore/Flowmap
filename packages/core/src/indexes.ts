/**
 * Database indexes created (or dropped) anywhere in a repo: plain SQL (in .sql files or in strings inside migrations)
 * and the migration helpers of common tools. Model-level indexes (@Index, @@index, index=True) are read by the ORM plugins.
 * Rollback code (down(), downgrade(), *.down.sql) is skipped: it undoes the migration, it isn't the schema.
 */
export interface IndexFact {
  table: string | null;      // null = built at runtime ("${table}"), can't tell which
  columns: string[];
  name?: string;
  drop?: true;
  line: number;
}

type Raw = { t?: string; name?: string; columns: string[] };       // t: table as written ("users", this.tableName, "${schema}"."users")

// "a", "b DESC", "c(10)" (MySQL prefix) are columns; "lower(email)" is an expression, which never covers a column
const list = (s: string) => s.split(/,(?![^(]*\))/).map((c) => c.trim().replace(/["'`[\]]/g, "")).filter(Boolean)
  .map((c) => (/^\w+\s*\((?!\d+\))/.test(c) ? "(expr)" : c.split(/[\s(]/)[0]));
const name = (raw: string | undefined) => raw?.replace(/["'`[\]]/g, "").split(".").pop();
const opt = (body: string, key: string) => new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(body)?.[1] ?? "";
const nameOpt = (body: string) => name(/\bname\s*:\s*['"`]([^'"`]+)/.exec(body)?.[1]);

const CREATE: [RegExp, (m: RegExpMatchArray) => Raw][] = [
  // SQL: CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] [schema.]table [USING x] (cols)
  [/\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:([^\s(]+)\s+)?on\s+(?:only\s+)?([^\s(]+)\s*(?:using\s+\w+\s*)?\(((?:[^()]|\([^()]*\))*)\)/gi, (m) => ({ name: name(m[1]), t: m[2], columns: list(m[3]) })],
  // SQL: ALTER TABLE t ADD [CONSTRAINT x] UNIQUE|PRIMARY KEY (cols)
  [/\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([^\s(]+)\s+add\s+(?:constraint\s+(\S+)\s+)?(?:unique|primary\s+key)\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (m) => ({ name: name(m[2]), t: m[1], columns: list(m[3]) })],
  // TypeORM: createIndex(t, new TableIndex({...})), createUniqueConstraint(t, new TableUnique({...})), createIndices / createPrimaryKey
  [/\bcreate(?:Index|Indices|UniqueConstraint|PrimaryKey)\(\s*([^,()]+?)\s*,([^;]*?columnNames\s*:\s*\[[^\]]*\][^;]*?)\)/g, (m) => ({ name: nameOpt(m[2]), t: m[1], columns: list(opt(m[2], "columnNames")) })],
  // Sequelize: addIndex(t, ["c"]) / addIndex(t, { fields: ["c"], name })
  [/\baddIndex\(\s*([^,()]+?)\s*,\s*(?:\[([^\]]*)\]|\{([\s\S]*?)\})/g, (m) => ({ name: nameOpt(m[3] ?? ""), t: m[1], columns: list(m[2] ?? opt(m[3] ?? "", "fields")) })],
  // Alembic: op.create_index("ix", "t", ["c"]) / op.create_index(op.f("ix"), "t", ["c"])
  [/\bop\.create_index\(\s*(?:op\.f\()?\s*['"](\w+)['"]\)?\s*,\s*([^,()]+?)\s*,\s*\[([^\]]*)\]/g, (m) => ({ name: m[1], t: m[2], columns: list(m[3]) })],
];

const DROP: RegExp[] = [
  /\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([^\s;,)]+)/gi,
  /\bdropIndex\(\s*[^,()]+,\s*['"`]([^'"`]+)['"`]/g,      // TypeORM
  /\bremoveIndex\(\s*[^,()]+,\s*['"`]([^'"`]+)['"`]/g,    // Sequelize
  /\bop\.drop_index\(\s*(?:op\.f\()?\s*['"](\w+)['"]/g,   // Alembic
];

// Knex: knex.schema.createTable("t", (t) => { t.index(["c"]); t.integer("user_id").index(); })
const KNEX_TABLE = /\b(?:createTable|alterTable|table)\(\s*['"`](\w+)['"`]/g;
const KNEX_INDEX = /\.(?:index|unique|primary)\(\s*(?:\[([^\]]*)\]|['"`](\w+)['"`])|\(\s*['"`](\w+)['"`]\s*\)(?:\.\w+\([^)]*\))*?\.(?:index|unique|primary)\(\s*\)/g;

// SQL: CREATE TABLE t (..., "email" text UNIQUE, CONSTRAINT x UNIQUE ("a", "b"), PRIMARY KEY ("id")): constraints are indexes too
const SQL_TABLE = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*\(/gi;
const KEY_CONSTRAINT = /^(?:constraint\s+(\S+)\s+)?(?:unique|primary\s+key)\s*\(((?:[^()]|\([^()]*\))*)\)/i;
const KEY_COLUMN = /^["`[]?(\w+)["`\]]?\s.*\b(?:unique|primary\s+key)\b/i;

// TypeORM: createTable(new Table({ name: t, columns: [{ name: "c", isUnique: true }], indices: [...], uniques: [...] }))
const TYPEORM_TABLE = /\bnew\s+Table\(\s*\{/g;

/** Text inside the bracket at `open` ((, [ or {), up to its matching close. */
function inside(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Splits at top-level commas; `top` keeps only the text outside nested brackets. */
function parts(s: string): { all: string[]; top: string } {
  const all: string[] = [];
  let depth = 0, start = 0, top = "";
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c === "," && depth === 0 || i === s.length) { all.push(s.slice(start, i).trim()); start = i + 1; }
    if (c && "([{".includes(c)) depth++;
    else if (c && ")]}".includes(c)) depth--;
    else if (depth === 0 && c) top += c;
  }
  return { all, top };
}

const DOWN = /\b(?:async\s+)?down\s*\(|\bdef\s+downgrade\s*\(|\bdown\s*:|exports\.down\s*=/g;
const UP = /\b(?:async\s+)?up\s*\(|\bdef\s+upgrade\s*\(|\bup\s*:|exports\.up\s*=/g;

/** Blanks out rollback sections (from a down marker to the next up marker), keeping offsets and line numbers. */
export function withoutRollback(text: string) {
  const ups = [...text.matchAll(UP)].map((m) => m.index!);
  let out = text;
  for (const m of text.matchAll(DOWN)) {
    const end = ups.find((u) => u > m.index!) ?? text.length;
    out = out.slice(0, m.index!) + out.slice(m.index!, end).replace(/[^\n]/g, " ") + out.slice(end);
  }
  return out;
}

export function indexFacts(file: string, raw: string): IndexFact[] {
  if (!/index|unique|primary/i.test(raw) || /\.down\.sql$/i.test(file)) return [];
  const text = withoutRollback(raw);
  const line = (at: number) => text.slice(0, at).split("\n").length;
  // table names kept in constants or fields of this file: TABLE = "users", private readonly tableName = "users"
  const consts = new Map<string, string>();
  for (const m of text.matchAll(/\b(\w+)\s*[:=]\s*['"`](\w+)['"`]/g)) if (!consts.has(m[1])) consts.set(m[1], m[2]);
  const table = (t: string) => {
    const v = t.trim().replace(/\$\{\s*(?:this\.)?(\w+)\s*\}|^(?:this\.)?(\w+)$/g, (s, a, b) => consts.get(a ?? b) ?? s).replace(/["'`[\]]/g, "").split(".").pop()!;
    return /^\w+$/.test(v) ? v : null;
  };
  const out: IndexFact[] = [];
  const add = (r: Raw, at: number) => out.push({ ...(r.name ? { name: r.name } : {}), table: table(r.t ?? ""), columns: r.columns, line: line(at) });

  for (const [re, fact] of CREATE) for (const m of text.matchAll(re)) add(fact(m), m.index!);
  for (const re of DROP) for (const m of text.matchAll(re)) out.push({ name: name(m[1]), table: null, columns: [], drop: true, line: line(m.index!) });
  for (const m of text.matchAll(SQL_TABLE)) {
    for (const p of parts(inside(text, m.index! + m[0].length - 1)).all) {
      const c = KEY_CONSTRAINT.exec(p);
      const col = !c && !/^(constraint|foreign|check|index|key)\b/i.test(p) ? KEY_COLUMN.exec(p) : null;
      if (c) add({ name: name(c[1]), t: m[1], columns: list(c[2]) }, m.index!);
      else if (col) add({ t: m[1], columns: [col[1]] }, m.index!);
    }
  }
  for (const m of text.matchAll(TYPEORM_TABLE)) {
    const body = inside(text, m.index! + m[0].length - 1);
    const t = /\bname\s*:\s*([^,]+)/.exec(parts(body).top)?.[1] ?? "";
    const section = (key: string) => { const at = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(body); return at ? inside(body, at.index + at[0].length - 1) : ""; };
    for (const k of ["indices", "uniques"]) for (const c of section(k).matchAll(/columnNames\s*:\s*\[([^\]]*)\]/g)) add({ t, columns: list(c[1]) }, m.index!);
    for (const col of section("columns").matchAll(/\{[^{}]*\}/g)) {
      const n = /\bname\s*:\s*['"`](\w+)/.exec(col[0])?.[1];
      if (n && /\b(?:isUnique|isPrimary)\s*:\s*true/.test(col[0])) add({ t, columns: [n] }, m.index!);
    }
  }
  const tables = /\.schema\b/.test(text) ? [...text.matchAll(KNEX_TABLE)] : [];
  for (const m of tables.length ? text.matchAll(KNEX_INDEX) : []) {
    const t = tables.filter((x) => x.index! < m.index!).pop();
    if (t) add({ t: t[1], columns: m[1] ? list(m[1]) : [m[2] ?? m[3]] }, m.index!);
  }
  return out.sort((a, b) => a.line - b.line);
}
