import type { ReactNode } from "react";
import type { EdgeKind, NodeKind } from "../../types";

export const btn = "inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50";
export const primary = "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50";
export const danger = "inline-flex items-center gap-1.5 rounded-md border border-error/40 px-2.5 py-1.5 text-sm text-error hover:bg-error-soft";

export const key = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** Id of a proposed node: "new:" + lowercase key (the server's format). */
export const newId = () => `new:${key("n")}`;
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "design";

/** What can be added by hand: kind, the word developers use for it, and a starting name to type over. */
export const ADD_KINDS: [kind: NodeKind, label: string, name: string][] = [
  ["Route", "Screen", "/new-screen"],
  ["Component", "Component", "NewComponent"],
  ["Operation", "API", "mutation newAction"],
  ["Function", "Function", "newFunction"],
  ["Table", "Table", "new_table"],
  ["External", "External service", "New service"],
  ["Queue", "Queue", "new-queue"],
  ["Job", "Job", "newJob"],
];

export const EDGE_KINDS: EdgeKind[] = ["calls", "renders", "requests", "handles", "reads", "writes", "calls_external", "enqueues", "triggers", "navigates"];

/** What an arrow between two kinds most likely means; changeable in the side panel. */
export function guessEdge(a: NodeKind, b: NodeKind): EdgeKind {
  if (b === "Table") return "writes";
  if (b === "External") return "calls_external";
  if (b === "Queue") return "enqueues";
  if (a === "Queue") return "triggers";
  if (a === "Operation") return "handles";
  if (b === "Operation") return "requests";
  if (b === "Route") return "navigates";
  return a === "Route" || (a === "Component" && b === "Component") ? "renders" : "calls";
}

export function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return !iso ? "" : s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
}

export function download(name: string, data: Blob | string, type = "text/plain") {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
    </label>
  );
}
