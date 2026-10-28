import type { Node, NodeProps } from "@xyflow/react";
import { AppWindow, ChevronDown, Cloud, Database, Layers, Server, type LucideIcon } from "lucide-react";
import { memo } from "react";

export type BoxKind = "ui" | "service" | "external" | "database" | "queues";
export type GroupNode = Node<{ label: string; count: number; kind: BoxKind; onToggle?: () => void }, "group-box">;

const STYLE: Record<BoxKind, { icon: LucideIcon; border: string; tint: string; text: string }> = {
  ui: { icon: AppWindow, border: "border-accent/35", tint: "bg-accent-soft/35", text: "text-accent" },
  service: { icon: Server, border: "border-line-strong", tint: "bg-muted/40", text: "text-fg-muted" },
  external: { icon: Cloud, border: "border-external/35", tint: "bg-external-soft/40", text: "text-external" },
  database: { icon: Database, border: "border-table/35", tint: "bg-table-soft/40", text: "text-table" },
  queues: { icon: Layers, border: "border-line-strong", tint: "bg-muted/40", text: "text-fg-muted" },
};

/** Dashed box around the nodes of one repo / service, so it's clear where a flow crosses from frontend to backend. */
export const GroupBox = memo(function GroupBox({ data }: NodeProps<GroupNode>) {
  const s = STYLE[data.kind];
  const Icon = s.icon;
  return (
    <div className={`h-full w-full rounded-2xl border-2 border-dashed ${s.border} ${s.tint}`} role="group" aria-label={`${data.label}: ${data.count} nodes`}>
      <div className={`absolute top-3 left-4 flex items-center gap-1.5 text-sm font-semibold ${s.text}`}>
        <Icon className="size-3.5" aria-hidden />
        <span className="max-w-72 truncate normal-case">{data.label}</span>
        <span className="rounded bg-bg/80 px-1.5 font-mono font-normal text-fg-subtle">{data.count}</span>
        {data.onToggle && (
          // the box itself ignores the pointer (so the canvas under it stays usable); only this button takes clicks
          <button type="button" onClick={data.onToggle} aria-label={`Collapse ${data.label}`} title="Collapse" className="nodrag pointer-events-auto rounded p-0.5 text-fg-subtle hover:bg-bg/80 hover:text-fg">
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
});
