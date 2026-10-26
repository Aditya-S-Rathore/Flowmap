import { ArrowLeftRight, CornerDownRight, Heading, LayoutPanelTop, Link2, List, MousePointerClick, PanelTop, Rows3, Table2, TextCursorInput, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { mapHref } from "./refs";
import type { Ref, WireNode } from "../types";

/**
 * A screen as a plain outline: its parts (components, dialogs, tabs) and, inside each, the things a user can do
 * (buttons, links, inputs) with the API each one calls or the screen it opens. No layout guessing.
 */

export interface Row {
  depth: number;
  kind: "section" | "dialog" | "tabs" | "heading" | "action" | "link" | "field" | "table" | "list";
  label: string;
  node: WireNode;
  apis?: Ref[];
  to?: Ref;
  repeat?: boolean;
  optional?: boolean;
}

const humanize = (name: string) => name.split(/[/.]/).filter(Boolean).pop()!.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");

const hasButton = (n: WireNode): boolean => (n.children ?? []).some((c) => c.kind === "button" || hasButton(c));

export function outline(root: WireNode | null, max = 400): Row[] {
  const rows: Row[] = [];
  if (!root) return rows;
  // "×n" carries down to what's inside a repeated part; "sometimes" is shown where the condition starts, not on every row inside
  const flags = (n: WireNode, inherited: { repeat?: boolean }) => ({
    ...(n.repeat || inherited.repeat ? { repeat: true } : {}), ...(n.optional ? { optional: true } : {}),
  });
  const walk = (n: WireNode, depth: number, ctx: { repeat?: boolean }) => {
    if (rows.length >= max) return;
    const f = flags(n, ctx);
    const inner = { ...ctx, ...(f.repeat ? { repeat: true } : {}) };
    const group = (kind: Row["kind"], label: string, kids = n.children ?? []) => {
      // the same component used twice in a row (e.g. a popover for desktop and mobile) is listed once
      const prev = [...rows].reverse().find((r) => r.depth <= depth);
      if (prev && prev.depth === depth && n.component && prev.node.component?.id === n.component.id) return;
      const at = rows.length;
      rows.push({ depth, kind, label, node: n, ...(n.apis ? { apis: n.apis } : {}), ...(n.to ? { to: n.to } : {}), ...f });
      for (const c of kids) walk(c, depth + 1, inner);
      if (rows.length === at + 1 && !n.apis && !n.to && kind !== "tabs") rows.pop();          // nothing to show inside
    };
    switch (n.kind) {
      case "component": {
        const only = n.children?.length === 1 ? n.children[0] : undefined;
        if (only?.kind === "modal") return group("dialog", humanize(n.component?.name ?? n.label ?? "Dialog"), only.children ?? []);   // a component that is a dialog
        return group("section", humanize(n.component?.name ?? n.label ?? "Section"));
      }
      case "modal":
        return group("dialog", n.label ?? (n.component ? humanize(n.component.name) : "Dialog"));
      case "tabs":
        return group("tabs", n.label ? `Tabs: ${n.label}` : "Tabs");
      case "heading":
        if (n.label) rows.push({ depth, kind: "heading", label: n.label, node: n, ...f });
        return;
      case "button": case "link":
        if (!n.label && !n.apis && !n.to) return;          // an unlabeled icon button that leads nowhere we know: noise
        rows.push({ depth, kind: n.kind === "link" ? "link" : "action", label: n.label ?? (n.kind === "link" ? "Link" : "Button"), node: n, ...(n.apis ? { apis: n.apis } : {}), ...(n.to ? { to: n.to } : {}), ...f });
        return;
      case "input": case "select": case "checkbox":
        rows.push({ depth, kind: "field", label: n.label ?? (n.kind === "select" ? "Select" : n.kind === "checkbox" ? "Checkbox" : "Input"), node: n, ...(n.apis ? { apis: n.apis } : {}), ...f });
        return;
      case "table":
        rows.push({ depth, kind: "table", label: n.label ?? "Table", node: n, ...f });
        for (const c of n.children ?? []) walk(c, depth + 1, inner);
        return;
      case "form":
        if (n.apis && !hasButton(n)) rows.push({ depth, kind: "action", label: n.label ?? "Submit form", node: n, apis: n.apis, ...f });
        for (const c of n.children ?? []) walk(c, depth, inner);
        return;
      case "list":
        if (!n.children?.length) { rows.push({ depth, kind: "list", label: n.label ?? "List", node: n, ...f }); return; }
        for (const c of n.children) walk(c, depth, inner);
        return;
      default:
        // a container with its own handler (e.g. <div onClick>) is an action too; a form-like wrapper (Formik…) only when it has no buttons
        if ((n.apis && !(n.submits && hasButton(n))) || n.to) rows.push({ depth, kind: "action", label: n.label ?? "Action", node: n, ...(n.apis ? { apis: n.apis } : {}), ...(n.to ? { to: n.to } : {}), ...f });
        for (const c of n.children ?? []) walk(c, depth, inner);
    }
  };
  // the page component itself is the screen (its name is in the header); its parts are the sections
  if (root.kind === "component") for (const c of root.children ?? []) walk(c, 0, {});
  else walk(root, 0, {});
  return rows;
}

const ICON: Record<Row["kind"], LucideIcon> = {
  section: LayoutPanelTop, dialog: PanelTop, tabs: Rows3, heading: Heading, action: MousePointerClick, link: Link2, field: TextCursorInput, table: Table2, list: List,
};

export const sameElement = (a: WireNode | null | undefined, b: WireNode | null | undefined) => !!a && !!b && a.file === b.file && a.line === b.line && !!a.file;

export function OutlineView({ rows, selected, onPick, compact = false }: { rows: Row[]; selected?: WireNode | null; onPick?: (n: WireNode) => void; compact?: boolean }) {
  const active = useRef<HTMLLIElement>(null);
  useEffect(() => { active.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [selected]);
  if (!rows.length) return <p className="px-4 py-6 text-sm text-fg-subtle">Nothing found on this screen (no buttons, links or inputs in its code).</p>;
  return (
    <ul className={compact ? "space-y-0.5" : "space-y-0.5 p-2"} aria-label="Screen outline">
      {rows.map((r, i) => {
        const Icon = ICON[r.kind];
        const group = r.kind === "section" || r.kind === "dialog" || r.kind === "tabs";
        const isActive = sameElement(selected, r.node);
        return (
          <li key={i} ref={isActive ? active : undefined} style={{ paddingLeft: `${r.depth * (compact ? 0.75 : 1.25)}rem` }}>
            <div role={onPick ? "button" : undefined} tabIndex={onPick ? 0 : undefined}
              onClick={onPick ? (e) => { e.stopPropagation(); onPick(r.node); } : undefined}
              onKeyDown={onPick ? (e) => { if (e.key === "Enter") onPick(r.node); } : undefined}
              className={`flex min-w-0 items-center gap-2 rounded-md px-2 ${compact ? "py-0.5 text-[0.6875rem]" : "py-1.5 text-sm"} ${onPick ? "cursor-pointer hover:bg-muted" : ""} ${isActive ? "bg-accent-soft ring-1 ring-accent/40" : ""} ${r.optional ? "opacity-75" : ""}`}>
              <Icon className={`${compact ? "size-3" : "size-4"} shrink-0 ${group ? "text-accent" : r.apis?.length ? "text-accent" : "text-fg-subtle"}`} aria-hidden />
              <span className={`min-w-0 truncate ${group ? "font-semibold" : r.kind === "heading" ? "font-medium text-fg-muted" : ""}`} title={r.label}>{r.label}</span>
              {r.repeat && <span className="shrink-0 rounded bg-muted px-1 text-[0.625rem] text-fg-subtle" title="Repeated for each item">×n</span>}
              {r.optional && !compact && <span className="shrink-0 rounded border border-dashed border-line-strong px-1 text-[0.625rem] text-fg-subtle" title="Shown only in some states">sometimes</span>}
              {!compact && (r.apis?.length || r.to) ? (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
                  {r.apis?.slice(0, 2).map((a) => (
                    <a key={a.id} href={mapHref(a.id)} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-56 items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent hover:underline" title={a.name}>
                      <ArrowLeftRight className="size-3 shrink-0" aria-hidden /><span className="truncate">{a.name}</span>
                    </a>
                  ))}
                  {r.apis && r.apis.length > 2 && <span className="text-xs text-fg-subtle">+{r.apis.length - 2}</span>}
                  {r.to && (
                    <a href={mapHref(r.to.id)} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 font-mono text-xs text-fg-muted hover:border-accent hover:text-accent">
                      <CornerDownRight className="size-3" aria-hidden />{r.to.name}
                    </a>
                  )}
                </span>
              ) : compact && r.apis?.length ? <ArrowLeftRight className="ml-auto size-3 shrink-0 text-accent" aria-label="calls an API" /> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
