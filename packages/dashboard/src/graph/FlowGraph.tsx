import { Background, Controls, MarkerType, MiniMap, Panel, ReactFlow, useNodesState, type Edge } from "@xyflow/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { EdgeView, NodeView } from "../types";
import { GroupBox, type BoxKind, type GroupNode } from "./GroupBox";
import { layout, NODE_H, NODE_W } from "./layout";
import { NodeCard, type CardNode } from "./NodeCard";

const nodeTypes = { card: NodeCard, "group-box": GroupBox };

// Mid-tone hex values read well on both light and dark canvases (SVG markers can't use CSS vars).
export const C = { neutral: "#a1a1aa", write: "#3b82f6", external: "#ef4444", afterCommit: "#22c55e", request: "#6366f1" };

export const boxKind = (group: string, members: NodeView[]): BoxKind =>
  group === "External services" ? "external" : group === "Database" ? "database" : group === "Queues" ? "queues"
    : members.some((n) => n.kind === "Route" || n.kind === "Component" || n.kind === "ClientCall") ? "ui" : "service";

export function toEdge(e: EdgeView): Edge {
  let color = C.neutral;
  let dash: string | undefined;
  const labels: string[] = [];
  if (e.kind === "writes") color = C.write;
  if (e.kind === "requests") color = C.request;
  if (e.kind === "calls_external") { color = C.external; if (e.attrs.method) labels.push(e.attrs.method); }
  if (e.confidence === "inferred") { color = C.neutral; dash = "6 4"; labels.push("inferred"); }
  if (e.attrs.afterCommit) { color = C.afterCommit; dash = "6 4"; labels.push("after commit"); }
  if (e.attrs.inLoop) labels.push("↻ in loop");
  return {
    id: String(e.id), source: e.src, target: e.dst,
    style: { stroke: color, strokeWidth: 1.5, strokeDasharray: dash },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    label: labels.join(" · ") || undefined,
    labelStyle: { fill: color === C.neutral ? undefined : color, fontSize: "0.6875rem", fontWeight: 500 },
    labelBgPadding: [6, 3], labelBgBorderRadius: 4,
  };
}

const swatch = (stroke: string, dash?: string) => (
  <svg width="24" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke={stroke} strokeWidth="2" strokeDasharray={dash} /></svg>
);

export function Legend() {
  const items: [ReactNode, string][] = [
    [<span className="block h-3 w-6 rounded border-2 border-dashed border-line-strong" />, "Repo / service"],
    [<span className="block h-3 w-6 rounded-sm border border-warn/40 bg-tx" />, "In DB transaction (TX)"],
    [<span className="block h-3 w-6 rounded-sm border border-line border-l-4 border-l-table" />, "Table"],
    [<span className="block h-3 w-6 rounded-sm border border-line border-l-4 border-l-external" />, "External service"],
    [swatch(C.request), "API request"],
    [swatch(C.write), "Writes"],
    [swatch(C.external), "External call"],
    [swatch(C.afterCommit, "4 3"), "After commit"],
    [swatch(C.neutral, "4 3"), "Inferred"],
    [<span className="text-xs">↻</span>, "In loop"],
  ];
  return (
    <details className="rounded-lg border border-line bg-bg/95 px-3 py-2 text-xs text-fg-muted">
      <summary className="cursor-pointer font-medium text-fg">Legend</summary>
      <ul className="mt-2 space-y-1.5">
        {items.map(([icon, label]) => <li key={label} className="flex items-center gap-2"><span className="flex w-6 justify-center">{icon}</span>{label}</li>)}
      </ul>
    </details>
  );
}

const NONE = new Set<string>();

export function FlowGraph({ nodes, edges, rootId, dir = "down", expanded = NONE, selected, onSelect, onExpand, expandable = true }: {
  nodes: NodeView[]; edges: EdgeView[]; rootId: string; dir?: "down" | "up"; expanded?: Set<string>;
  selected: string | null; onSelect: (id: string | null) => void; onExpand?: (id: string) => void; expandable?: boolean;
}) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<CardNode | GroupNode>([]);
  const rfEdges = useMemo(() => edges.map(toEdge), [edges]);
  const fit = useRef<((o: { nodes?: { id: string }[]; padding: number; maxZoom: number; minZoom?: number }) => void) | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  // Fit the whole graph when it stays readable; otherwise open on the start node and its neighbours (fit button / minimap show the rest).
  useEffect(() => {
    if (!rfNodes.length || fitted.current) return;     // once: expanding nodes later must not move the view
    const raf = requestAnimationFrame(() => {
      const fitView = fit.current;
      const box = wrap.current?.getBoundingClientRect();
      if (!fitView || !box) return;
      fitted.current = true;
      const offset = new Map(rfNodes.filter((n) => n.type === "group-box").map((n) => [n.id, n.position]));
      const abs = rfNodes.filter((n) => n.type === "card").map((n) => {
        const o = n.parentId ? offset.get(n.parentId) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
        return { id: n.id, x: n.position.x + o.x, y: n.position.y + o.y };
      });
      const minX = Math.min(...abs.map((a) => a.x)), maxX = Math.max(...abs.map((a) => a.x)) + NODE_W;
      const minY = Math.min(...abs.map((a) => a.y)), maxY = Math.max(...abs.map((a) => a.y)) + NODE_H;
      if (Math.min(box.width / (maxX - minX), box.height / (maxY - minY)) >= 0.55) { fitView({ padding: 0.15, maxZoom: 1 }); return; }
      const start = abs.find((a) => a.id === rootId) ?? abs[0];
      const w = box.width / 0.7, h = box.height / 0.7;
      const near = abs.filter((a) => a.x >= start.x - NODE_W && a.x <= start.x + w - NODE_W && Math.abs(a.y - start.y) <= h / 2);
      fitView({ nodes: near.map((a) => ({ id: a.id })), padding: 0.1, maxZoom: 1, minZoom: 0.6 });
    });
    return () => cancelAnimationFrame(raf);
  }, [rfNodes, rootId]);

  useEffect(() => {
    let live = true;
    const groups = new Map(nodes.map((n) => [n.id, n.group]));
    layout(nodes.map((n) => n.id), edges, groups).then(({ pos, boxes }) => {
      if (!live) return;
      const boxOf = (n: NodeView) => (boxes.length ? `group:${n.group}` : undefined);
      setRfNodes([
        // parents first: React Flow positions children relative to their box
        ...boxes.map((b): GroupNode => {
          const members = nodes.filter((n) => `group:${n.group}` === b.id);
          const label = b.id.slice(6);
          return {
            id: b.id, type: "group-box", position: { x: b.x, y: b.y }, style: { width: b.width, height: b.height },
            data: { label, count: members.length, kind: boxKind(label, members) }, selectable: false, zIndex: -1,
          };
        }),
        ...nodes.map((n): CardNode => {
          const shown = edges.filter((e) => (dir === "down" ? e.src : e.dst) === n.id).length;
          const total = dir === "down" ? n.outCount : n.inCount;
          return {
            id: n.id, type: "card", position: pos.get(n.id) ?? { x: 0, y: 0 }, parentId: boxOf(n),
            data: { view: n, isRoot: n.id === rootId, dir, onExpand: onExpand ?? (() => {}), hidden: !expandable || expanded.has(n.id) ? 0 : Math.max(0, total - shown) },
          };
        }),
      ]);
    });
    return () => { live = false; };
  }, [nodes, edges, rootId, dir, expanded, onExpand, expandable, setRfNodes]);

  // Selection is applied on top of the laid-out nodes so selecting never triggers a re-layout.
  const shownNodes = useMemo(() => rfNodes.map((n) => ({ ...n, selected: n.id === selected })), [rfNodes, selected]);

  return (
    <div ref={wrap} className="h-full w-full">
    <ReactFlow nodes={shownNodes} edges={rfEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onInit={(i) => { fit.current = (o) => void i.fitView(o); }}
      onNodeClick={(_, n) => { if (n.type === "card") onSelect(n.id); }} onPaneClick={() => onSelect(null)}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
      minZoom={0.1}>
      <Background gap={24} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.type === "group-box" ? "transparent" : (n as CardNode).data.view.transactional || (n as CardNode).data.view.inTx ? "#f59e0b" : C.neutral)} />
      <Panel position="top-right"><Legend /></Panel>
    </ReactFlow>
    </div>
  );
}
