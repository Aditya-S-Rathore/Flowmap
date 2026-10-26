import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";
import { memo } from "react";
import { KIND, KindIcon } from "../components/kind";
import { SeverityBadge } from "../components/ui";
import type { NodeView } from "../types";

export type CardNode = Node<{ view: NodeView; hidden: number; isRoot: boolean; dir: "down" | "up"; onExpand: (id: string) => void }, "card">;

export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { view: n, hidden, isRoot, dir, onExpand } = data;
  const tx = n.transactional || n.inTx;
  const accent = n.kind === "Table" ? "border-l-4 border-l-table" : n.kind === "External" ? "border-l-4 border-l-external" : "";
  return (
    <div className={`relative flex h-20 w-64 flex-col justify-center gap-0.5 rounded-lg border px-3 ${tx ? "border-warn/40 bg-tx" : "border-line bg-bg"} ${accent} ${isRoot ? "ring-2 ring-accent/40" : ""} ${selected ? "ring-2 ring-accent" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />
      <div className="flex items-center gap-1.5 text-xs text-fg-muted">
        <KindIcon kind={n.kind} className="size-3.5" />
        <span>{KIND[n.kind].label}</span>
        {tx && <span className="rounded bg-warn/15 px-1 font-semibold text-warn" title={n.transactional ? "Opens a DB transaction" : "Runs inside a DB transaction"}>TX</span>}
        {n.issueCount > 0 && n.maxSeverity && (
          <span className="ml-auto"><SeverityBadge severity={n.maxSeverity}>{n.issueCount}</SeverityBadge></span>
        )}
      </div>
      <div className="truncate text-sm font-medium text-fg" title={n.name}>{n.name}</div>
      {typeof n.attrs.summary === "string"
        ? <div className="truncate text-xs text-table">{n.attrs.summary}</div>
        : <div className="truncate font-mono text-xs text-fg-subtle">{n.file ? `${n.repo}/${n.file}:${n.line}` : "external service"}</div>}
      <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />
      {hidden > 0 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onExpand(n.id); }}
          aria-label={`Show ${hidden} more ${dir === "down" ? "callees" : "callers"} of ${n.name}`}
          title={`Show ${hidden} more`}
          className={`nodrag absolute top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 rounded-full border border-line-strong bg-bg px-1.5 py-0.5 text-xs font-medium text-fg-muted shadow-sm hover:border-accent hover:text-accent ${dir === "down" ? "left-full ml-1" : "right-full mr-1"}`}>
          <Plus className="size-3" aria-hidden />{hidden}
        </button>
      )}
    </div>
  );
});
