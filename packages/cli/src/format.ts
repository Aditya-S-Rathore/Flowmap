import { styleText } from "node:util";
import type { AppMap, Architecture, ChangeSet, Counts, ExplainCard, Issue, PathStep, Ref, Subgraph, Suggestion } from "@flowmap/core";

type Style = Parameters<typeof styleText>[0];
let color = process.stdout.isTTY && !process.env.NO_COLOR;
export const setColor = (on: boolean) => { color = on; };
const c = (s: Style, t: string) => (color ? styleText(s, t) : t);

const KIND_TAG: Record<string, string> = {
  Route: "screen", Component: "component", ClientCall: "client", Operation: "api", Schema: "schema", Function: "fn",
  Guard: "guard", Table: "table", External: "external", Job: "job", Queue: "queue",
};

const loc = (r: { repo: string; file: string; line: number }) => (r.file ? c("dim", `${r.repo}/${r.file}:${r.line}`) : "");
const ref = (r: Ref | PathStep) => `${c("cyan", `[${KIND_TAG[r.kind] ?? r.kind}]`)} ${r.name} ${loc(r)}`;
const sev = (i: Issue) => (i.severity === "error" ? c("red", "error") : c("yellow", "warn "));

/** Downstream/upstream tree. Nodes already printed are shown once and then referenced with ↺. */
export function formatTree(sg: Subgraph, dir: "down" | "up" = "down"): string {
  const nodes = new Map(sg.nodes.map((n) => [n.id, n]));
  const children = new Map<string, typeof sg.edges>();
  for (const e of sg.edges) {
    const from = dir === "down" ? e.src : e.dst;
    children.set(from, [...(children.get(from) ?? []), e]);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, prefix: string, edgeLabel: string, last: boolean, depth: number) => {
    const n = nodes.get(id);
    if (!n) return;
    const branch = depth === 0 ? "" : prefix + (last ? "└─ " : "├─ ");
    const tx = n.transactional ? c("yellow", " ▓TX opens") : n.inTx ? c("yellow", " ▓in TX") : "";
    const issues = n.issueCount ? c(n.maxSeverity === "error" ? "red" : "yellow", ` ⚠ ${n.issueCount}`) : "";
    const again = seen.has(id) ? c("dim", " ↺") : "";
    lines.push(`${branch}${edgeLabel}${c("cyan", `[${KIND_TAG[n.kind] ?? n.kind}]`)} ${c("bold", n.name)}${tx}${issues}${again} ${loc(n)}`);
    if (seen.has(id)) return;
    seen.add(id);
    const kids = children.get(id) ?? [];
    kids.forEach((e, i) => {
      const next = dir === "down" ? e.dst : e.src;
      const bits = [e.kind.replace("_", " ")];
      if (e.attrs.method) bits.push(e.attrs.method);
      if (e.attrs.inLoop) bits.push(c("magenta", "in loop"));
      if (e.attrs.afterCommit) bits.push(c("green", "after commit"));
      else if (e.attrs.inTx && (e.kind === "calls_external" || e.kind === "enqueues")) bits.push(c("red", "inside TX"));
      if (e.confidence === "inferred") bits.push(c("dim", "inferred"));
      walk(next, depth === 0 ? "" : prefix + (last ? "   " : "│  "), c("dim", `${bits.join(" · ")} → `), i === kids.length - 1, depth + 1);
    });
  };
  walk(sg.rootId, "", "", true, 0);
  return lines.join("\n");
}

export function formatExplain(card: ExplainCard): string {
  const n = card.node;
  const out: string[] = [`${c("bold", n.name)}  ${c("cyan", `[${KIND_TAG[n.kind]}]`)}  ${loc(n)}`];
  const section = (title: string, items: string[]) => {
    if (items.length) out.push("", c("bold", title), ...items.map((s) => `  ${s}`));
  };
  section("Used by (screens)", card.screens.map(ref));
  if (n.kind !== "Operation") section("APIs", card.operations.map(ref));
  if (card.hasActor !== null || card.guards.length) {
    const auth = [
      `guards: ${card.guards.join(", ") || c("red", "none")}`,
      `permissions: ${card.permissions.join(", ") || "none"}`,
      `caller check: ${card.hasActor ? "yes (receives current user)" : card.permissions.length ? "via permission" : c("red", "no")}`,
    ];
    section("Access", auth);
  }
  section("Input", card.input.map((i) => `${i.name}: ${i.type}${i.validated ? "" : c("yellow", "  (not validated)")}`));
  if (card.schema) section("Schema", [`(${card.schema.args}) → ${card.schema.returns}`]);
  section("Feature flags", card.flags);
  section("Writes", card.writes.map((r) => `${r.name} ${c("dim", r.detail ? `via ${r.detail}` : "")}`));
  section("Reads", card.reads.map((r) => `${r.name} ${c("dim", r.detail ? `via ${r.detail}` : "")}`));
  section("External calls", card.externals.map((x) => `${x.name} ${x.detail ?? ""}${x.write ? "" : c("dim", " (read)")}${x.inTx ? c("red", "  ⚠ inside transaction") : ""}`));
  const tx = card.transaction;
  if (tx.opens || tx.inTx) section("Transaction", [tx.opens ? "opens a transaction" : `runs inside a transaction opened by ${tx.roots.map((r) => r.name).join(", ")}`]);
  section("Issues", card.issues.map((i) => `${sev(i)} ${i.message}`));
  section("Calls", card.callees.slice(0, 15).map(ref));
  section("Called by", card.callers.slice(0, 15).map(ref));
  return out.join("\n");
}

export function formatIssues(issues: Issue[], opts: { why?: boolean } = {}): string {
  if (!issues.length) return c("green", "No issues.");
  return issues.map((i) => {
    const head = `${sev(i)} ${c("dim", i.rule)}  ${i.message}\n      ${loc(i)}${i.status === "baseline" ? c("dim", "  (baseline)") : ""}`;
    const path = i.path.length > 1 ? `\n      path: ${i.path.map((p) => p.name).join(" → ")}` : "";
    const why = opts.why ? `\n      why: ${i.why}\n      fix: ${i.fix}` : "";
    return head + path + why;
  }).join("\n");
}

export function formatPaths(paths: PathStep[][]): string {
  return paths.map((p) => p.map((s) => `${c("cyan", `[${KIND_TAG[s.kind]}]`)} ${s.name}`).join(" → ")).join("\n");
}

export function formatRefs(groups: Record<string, Ref[]>): string {
  return Object.entries(groups).filter(([, v]) => v.length).map(([k, v]) => `${c("bold", k)} (${v.length})\n${v.map((r) => `  ${ref(r)}`).join("\n")}`).join("\n\n") || "Nothing upstream.";
}

export function formatChanges(cs: ChangeSet): string {
  const out = cs.repos.map((r) => `${c("bold", r.name)} ${r.branch ?? "?"} vs ${r.base}: ${r.error ? c("red", r.error) : `${r.files.length} files changed`}`);
  out.push("", formatRefs({ "Affected APIs": cs.affected.operations, "Affected screens": cs.affected.screens, "Tables touched": cs.affected.tables, "External services": cs.affected.externals }));
  out.push("", c("bold", `New issues in changed code (${cs.issues.length})`), formatIssues(cs.issues, { why: true }));
  return out.join("\n");
}

export function formatIssuesMarkdown(issues: Issue[]): string {
  if (!issues.length) return "✅ **FlowMap:** no new issues.";
  const rows = issues.map((i) => `| ${i.severity === "error" ? "🔴" : "🟡"} | \`${i.rule}\` | ${i.message.replace(/\|/g, "\\|")} | \`${i.repo}/${i.file}:${i.line}\` |`);
  return [`### FlowMap: ${issues.length} new issue${issues.length > 1 ? "s" : ""}`, "", "| | Rule | Problem | Where |", "|---|---|---|---|", ...rows].join("\n");
}

const stats = (x: Counts, apis = true) => [apis && x.apis && `${x.apis} api`, x.writes && `${x.writes} writes`, x.reads && `${x.reads} reads`, x.externals && `${x.externals} external`, x.issues && (x.maxSeverity === "error" ? c("red", `${x.issues} issues`) : c("yellow", `${x.issues} issues`))].filter(Boolean).join(" · ");

/** Screens, APIs, jobs or services, one line each. */
export function formatMap(map: AppMap, view: "screens" | "apis" | "jobs", filter = ""): string {
  const f = filter.toLowerCase();
  const keep = <T extends { name: string; repo: string }>(list: T[]) => list.filter((x) => !f || `${x.repo} ${x.name}`.toLowerCase().includes(f));
  if (view === "screens") {
    return keep(map.screens).map((s) => `${c("cyan", "[screen]")} ${s.name}  ${stats(s)}${s.auth ? " · auth" : ""}${s.flag ? ` · flag ${s.flag}` : ""}${s.unlinked ? c("dim", " · no links in code") : ""}  ${loc(s)}`).join("\n") || "No screens.";
  }
  if (view === "apis") {
    return keep(map.apis).map((a) => `${c("cyan", "[api]")} ${a.name}  ${stats(a, false)}${a.guarded ? "" : c("yellow", " · no guard")}${a.screens ? ` · ${a.screens} screens` : ""}  ${loc(a)}`).join("\n") || "No APIs.";
  }
  return keep(map.jobs).map((j) => `${c("cyan", `[${j.kind === "Job" ? "job" : "queue"}]`)} ${j.name}  ${stats(j)}  ${loc(j)}`).join("\n") || "No jobs or queues.";
}

export function formatArchitecture(a: Architecture): string {
  const label = new Map(a.nodes.map((n) => [n.id, n.label]));
  const svc = a.nodes.filter((n) => n.kind === "service").map((n) => `${c("bold", n.label)}  ${[n.screens && `${n.screens} screens`, n.apis && `${n.apis} APIs`, n.tables && `${n.tables} tables`, n.jobs && `${n.jobs} jobs/queues`, n.issues && `${n.issues} issues`].filter(Boolean).join(" · ")}`);
  const links = a.links.map((l) => `  ${label.get(l.src)} ${c("dim", `--${l.kind} ×${l.count}-->`)} ${label.get(l.dst)}`);
  return [...svc, "", ...links].join("\n");
}

export function formatSuggestions(list: Suggestion[]): string {
  return list.map((s) => `${c("bold", `• ${s.title}`)} ${c("dim", `(${s.repo})`)}\n  ${s.detail}${s.config ? `\n  ${c("green", s.config)}` : ""}`).join("\n") || "No suggestions.";
}
