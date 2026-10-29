import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, Minus, Plus, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { cardHeight, isSketch, linesOf, MAX_LINES } from "../../../core/src/design-view";
import { KIND, KindIcon } from "../components/kind";
import { SeverityBadge } from "../components/ui";
import type { DesignNodeView, NodeView } from "../types";
import { NODE_H } from "./layout";

export type CardNode = Node<{
  view: NodeView | DesignNodeView; hidden: number; isRoot: boolean; dir: "down" | "up"; onExpand: (id: string) => void;
  connectable?: boolean; dimmed?: boolean; onDecide?: (id: string, accept: boolean) => void;   // design canvas
  editing?: boolean; onRename?: (id: string, name: string) => void; onStopEdit?: () => void;
  onResize?: (id: string, rect: { x: number; y: number; w: number; h: number }) => void;      // free boxes
  open?: boolean;                                   // design canvas: the unchanged nodes folded behind this one are showing
}, "card">;

// connection dots for the design canvas: big enough to find and grab
const HANDLE = "!size-3 !border-2 !border-accent !bg-bg";

// design changes, with the existing tokens: new = dashed accent, changed = warn, removed = faded + struck through
const CHANGE = { new: "border-dashed border-accent", changed: "border-warn", removed: "border-dashed border-error opacity-60", existing: "" };

export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { view: n, hidden, isRoot, dir, onExpand, connectable, dimmed, onDecide, editing, onRename, onStopEdit, onResize, open } = data;
  const design = connectable !== undefined;
  const d = n as Partial<DesignNodeView>;
  const tx = n.transactional || n.inTx;
  const sketch = isSketch(n);                 // a free box: no code, no proposal styling
  const lines = linesOf(n as DesignNodeView);
  const label = sketch ? (d.shape === "decision" ? "Decision" : d.shape === "text" ? "Text" : "Box") : KIND[n.kind].label;
  const name = useRef<HTMLInputElement>(null);
  const done = useRef(false);                 // Enter / Escape / leaving the field each end the edit once
  const finish = (value?: string) => {
    if (done.current) return;
    done.current = true;
    if (value !== undefined) onRename?.(n.id, value.trim() || n.name);
    onStopEdit?.();
  };
  // a new node stays hidden until React Flow has measured it, and a hidden input can't take focus: try again for a few frames
  useEffect(() => {
    if (!editing) return;
    done.current = false;
    let tries = 0, raf = 0;
    const focus = () => {
      const el = name.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el && tries++ < 30) raf = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(raf);
  }, [editing]);
  const accent = n.kind === "Table" ? "border-l-4 border-l-table" : n.kind === "External" ? "border-l-4 border-l-external" : "";
  return (
    <div style={sketch ? undefined : { height: cardHeight(NODE_H, lines.length) }} className={`relative flex flex-col rounded-lg border ${sketch ? "size-full" : "w-64"} px-3 ${tx ? "border-warn/40 bg-tx" : "border-line bg-bg"} ${d.shape === "text" ? "border-transparent bg-transparent" : ""} ${d.shape === "decision" ? "rounded-3xl border-warn/60" : ""} ${accent} ${sketch ? "" : CHANGE[d.change ?? "existing"]} ${dimmed ? "opacity-40" : ""} ${isRoot ? "ring-2 ring-accent/40" : ""} ${selected ? "ring-2 ring-accent" : ""}`}>
      {sketch && <NodeResizer minWidth={96} minHeight={48} isVisible={selected} lineClassName="!border-accent" handleClassName="!size-2.5 !rounded-sm !border-accent !bg-bg"
        onResizeEnd={(_, p) => onResize?.(n.id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })} />}
      <Handle type="target" position={Position.Left} isConnectable={!!connectable} className={connectable ? HANDLE : "invisible"} />
      <div className={`flex shrink-0 flex-col justify-center gap-0.5 ${sketch ? "min-h-12 py-1.5" : "h-[4.875rem]"}`}>
      <div className="flex items-center gap-1.5 text-xs text-fg-muted">
        <KindIcon kind={n.kind} className="size-3.5" />
        <span>{label}</span>
        {tx && <span className="rounded bg-warn/15 px-1 font-semibold text-warn" title={n.transactional ? "Opens a DB transaction" : "Runs inside a DB transaction"}>TX</span>}
        {Array.isArray(n.attrs.flags) && n.attrs.flags.length > 0 && (
          <span className="max-w-24 truncate rounded bg-accent-soft px-1 font-medium text-accent" title={`Behind the feature flag: ${(n.attrs.flags as string[]).join(", ")}`}>⚑ {(n.attrs.flags as string[])[0]}{n.attrs.flags.length > 1 ? ` +${n.attrs.flags.length - 1}` : ""}</span>
        )}
        {d.change && d.change !== "existing" && !sketch && <span className={`font-medium ${d.change === "new" ? "text-accent" : d.change === "changed" ? "text-warn" : "text-error"}`}>{d.change}</span>}
        {n.issueCount > 0 && n.maxSeverity && (
          <span className="ml-auto" title={d.introduced ? `${d.introduced} issue(s) this design would introduce` : undefined}>
            <SeverityBadge severity={n.maxSeverity}>{d.introduced ? `+${d.introduced}${n.issueCount > d.introduced ? ` · ${n.issueCount - d.introduced}` : ""}` : n.issueCount}</SeverityBadge>
          </span>
        )}
      </div>
      {editing && d.change === "new" ? (
        <input ref={name} defaultValue={n.name} aria-label="Name" maxLength={300} onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finish(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") finish(e.currentTarget.value); if (e.key === "Escape") finish(); }}
          className="nodrag nopan -mx-1 rounded border border-accent bg-bg px-1 text-sm font-medium text-fg outline-none" />
      ) : (
        <div className={`truncate text-sm font-medium text-fg ${d.change === "removed" ? "line-through" : ""}`} title={n.name}>{n.name}</div>
      )}
      {d.note && d.change && d.change !== "existing"
        ? <div className="truncate text-xs text-fg-muted" title={d.note}>{d.note}</div>
        : typeof n.attrs.summary === "string"
        ? <div className="truncate text-xs text-table">{n.attrs.summary}</div>
        : sketch ? null
        : <div className="truncate font-mono text-xs text-fg-subtle">{d.change === "new" ? (n.file ? `→ ${n.repo}/${n.file}` : "proposed") : n.file ? `${n.repo}/${n.file}:${n.line}` : "external service"}</div>}
      </div>
      {lines.length > 0 && (
        <ul className="min-h-0 flex-1 text-xs">
          {lines.slice(0, MAX_LINES).map((l, i) => (
            <li key={i} className={`h-[1.125rem] truncate ${l.new ? "text-accent" : l.column ? "font-mono text-fg-muted" : "text-fg"}`} title={l.text}>{l.new ? "+ " : l.column ? "" : "• "}{l.text}</li>
          ))}
          {lines.length > MAX_LINES && <li className="h-[1.125rem] text-fg-subtle">+{lines.length - MAX_LINES} more, click to see all</li>}
        </ul>
      )}
      <Handle type="source" position={Position.Right} isConnectable={!!connectable} className={connectable ? HANDLE : "invisible"} />
      {d.pending && onDecide && (
        <div className="nodrag absolute -top-3 right-2 flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-xs text-accent shadow-sm">
          Claude
          <button type="button" onClick={(e) => { e.stopPropagation(); onDecide(n.id, true); }} aria-label={`Accept ${n.name}`} title="Accept" className="rounded-full p-0.5 hover:bg-bg"><Check className="size-3" aria-hidden /></button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onDecide(n.id, false); }} aria-label={`Reject ${n.name}`} title="Reject" className="rounded-full p-0.5 hover:bg-bg"><X className="size-3" aria-hidden /></button>
        </div>
      )}
      {(hidden > 0 || open) && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onExpand(n.id); }}
          aria-label={design
            ? open ? `Hide the unchanged nodes shown around ${n.name}` : `Show ${hidden} unchanged node${hidden === 1 ? "" : "s"} linked to ${n.name}`
            : `Show ${hidden} more ${dir === "down" ? "callees" : "callers"} of ${n.name}`}
          title={design ? (open ? "Fold the unchanged nodes away again" : `${hidden} unchanged node${hidden === 1 ? "" : "s"} linked to this one are folded away. Click to show them.`) : `Show ${hidden} more`}
          className={`nodrag absolute top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 rounded-full border border-line-strong bg-bg px-1.5 py-0.5 text-xs font-medium text-fg-muted shadow-sm hover:border-accent hover:text-accent ${dir === "down" ? "left-full ml-1" : "right-full mr-1"}`}>
          {open ? <><Minus className="size-3" aria-hidden />hide</> : <><Plus className="size-3" aria-hidden />{hidden}</>}
        </button>
      )}
    </div>
  );
});
