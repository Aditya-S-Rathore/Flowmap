import { Background, Controls, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DesignEdgeView, DesignNodeView, DesignNote } from "../types";
import { boxKind, C, Legend, toEdge } from "./FlowGraph";
import { GroupBox, type GroupNode } from "./GroupBox";
import { layout, NODE_H, NODE_W, ROOMY } from "./layout";
import { NodeCard, type CardNode } from "./NodeCard";

export type IssueFilter = "all" | "issues" | "introduced";
export type Pos = { x: number; y: number };

type NoteNode = Node<{ text: string }, "note">;
type SummaryNode = Node<{ label: string; count: number; onOpen: () => void }, "summary">;
type AnyNode = CardNode | NoteNode | GroupNode | SummaryNode;

const NoteCard = memo(function NoteCard({ data, selected }: NodeProps<NoteNode>) {
  return (
    <div className={`w-56 whitespace-pre-wrap rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-fg ${selected ? "ring-2 ring-accent" : ""}`}>
      {data.text || <span className="text-fg-subtle">Empty note — select it to write</span>}
    </div>
  );
});

/** A collapsed repo / service box: one card standing for all its nodes. */
const SummaryCard = memo(function SummaryCard({ data }: NodeProps<SummaryNode>) {
  return (
    <button type="button" onClick={data.onOpen} aria-label={`Expand ${data.label}: ${data.count} nodes`}
      className="nodrag flex h-20 w-64 flex-col items-start justify-center gap-0.5 rounded-lg border-2 border-dashed border-line-strong bg-muted/50 px-3 text-left hover:border-accent">
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />
      <span className="text-xs text-fg-muted">Collapsed · click to expand</span>
      <span className="max-w-full truncate text-sm font-semibold">{data.label}</span>
      <span className="font-mono text-xs text-fg-subtle">{data.count} nodes</span>
      <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />
    </button>
  );
});

const nodeTypes = { card: NodeCard, note: NoteCard, "group-box": GroupBox, summary: SummaryCard };

const has = (n: { x?: number; y?: number; pinned?: boolean }) => !!n.pinned && n.x !== undefined && n.y !== undefined;
const edgeSig = (e: { src: string; dst: string; kind: string }) => `${e.src}|${e.dst}|${e.kind}`;
const PAD = { top: 48, side: 24, bottom: 24 };     // what the group box leaves around its nodes (as in the app's flow view)

/** The one word worth putting on an arrow: what code does to data and outside services. Plain calls get none (the line's style says enough). */
export const EFFECT_WORD: Record<string, string> = { reads: "reads", writes: "writes", calls_external: "calls out", enqueues: "queues" };

function designEdge(e: DesignEdgeView): Edge {
  const base = toEdge(e);
  const id = e.designId ?? `g${e.id}`;
  if (e.change === "new") {
    return {
      ...base, id, style: { stroke: C.request, strokeWidth: 1.5, strokeDasharray: "6 4" },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.request, width: 16, height: 16 },
      label: EFFECT_WORD[e.kind], labelStyle: { fill: C.request, fontSize: "0.6875rem", fontWeight: 500 },
    };
  }
  if (e.change === "removed") return { ...base, id, style: { stroke: C.external, strokeWidth: 1.5, strokeDasharray: "2 3", opacity: 0.7 }, label: "removed" };
  return { ...base, id };
}

/** The three states, always in view: the key to reading the picture. */
function Key() {
  const item = (swatch: string, label: string) => <span className="inline-flex items-center gap-1.5"><span className={`block h-3 w-5 rounded-sm border-2 ${swatch}`} aria-hidden />{label}</span>;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-bg/95 px-3 py-1.5 text-xs text-fg-muted" role="note" aria-label="Key">
      {item("border-dashed border-accent", "New")}
      {item("border-warn", "Changing")}
      {item("border-dashed border-error opacity-60", "Removing")}
    </div>
  );
}

/**
 * The design canvas: the app's flow view (repo / service boxes, same cards and arrows) with the design drawn on top and editable.
 * Layout is automatic and re-runs by itself when the structure changes (nodes added, expanded, connected, boxes folded);
 * a node you drag keeps its place (it is "pinned": the design stores its x / y); Tidy un-pins everything.
 */
export function DesignGraph({
  nodes, edges, notes, selected, editing, filter, collapsed, fitKey, getCenter, folded, opened,
  onReveal, onSelect, onMove, onConnect, onDecide, onRename, onStopEdit, onToggleGroup, onEditNode, onQuickAdd, onContextMenu,
}: {
  nodes: DesignNodeView[]; edges: DesignEdgeView[]; notes: DesignNote[]; selected: string | null; editing: string | null;
  filter: IssueFilter; collapsed: Set<string>; fitKey: string; getCenter: React.MutableRefObject<(() => Pos) | null>;
  folded: ReadonlyMap<string, number>; opened: ReadonlySet<string>; onReveal: (id: string) => void;     // "+N" chips: how many are folded behind a node, which are opened
  onSelect: (id: string | null) => void; onMove: (id: string, pos: Pos) => void; onConnect: (src: string, dst: string) => void;
  onDecide: (id: string, accept: boolean) => void; onRename: (id: string, name: string) => void; onStopEdit: () => void;
  onToggleGroup: (group: string) => void; onEditNode: (id: string) => void;
  onQuickAdd: (at: { flow: Pos; client: Pos; from?: string; reverse?: boolean }) => void; onContextMenu: (id: string, client: Pos) => void;
}) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<AnyNode>([]);
  const [placed, setPlaced] = useState<Map<string, Pos>>();
  const [animating, setAnimating] = useState(false);
  const flow = useRef<ReactFlowInstance<AnyNode> | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const firstLayout = useRef(true);
  // fitting the view waits for a fresh layout (not the old one still on screen): `fitAfter` is the layout number to get past
  const layoutGen = useRef(0);
  const renderedGen = useRef(0);
  const fitAfter = useRef<number | null>(-1);

  // 1. what is drawn: nodes of a collapsed box stand in as one card; arrows follow
  const view = useMemo(() => {
    const groupOf = new Map(nodes.map((n) => [n.id, n.group]));
    const rep = (id: string) => { const g = groupOf.get(id); return g !== undefined && collapsed.has(g) ? `group:${g}` : id; };
    const shown = nodes.filter((n) => !collapsed.has(n.group));
    const summaries = [...collapsed].map((g) => ({ g, count: nodes.filter((n) => n.group === g).length })).filter((s) => s.count);
    const seen = new Set<string>();
    const drawn: DesignEdgeView[] = [];
    for (const e of edges) {
      const [src, dst] = [rep(e.src), rep(e.dst)];
      const key = src === e.src && dst === e.dst ? `${edgeSig(e)}|${e.designId ?? ""}` : `${src}|${dst}`;
      if (src === dst || seen.has(key)) continue;
      seen.add(key);
      drawn.push(src === e.src && dst === e.dst ? e : { ...e, src, dst, designId: undefined, change: undefined, pending: undefined, id: -(drawn.length + 1000) });
    }
    return { shown, summaries, drawn };
  }, [nodes, edges, collapsed]);

  // 2. when that structure changes, lay it out again (ELK in a worker); positions are not saved, only pins are
  const structure = useMemo(() => JSON.stringify([view.shown.map((n) => [n.id, n.group]).sort(), view.summaries.map((s) => s.g), view.drawn.map((e) => [e.src, e.dst]).sort()]), [view]);
  useEffect(() => {
    let live = true;
    const ids = [...view.shown.map((n) => n.id), ...view.summaries.map((s) => `group:${s.g}`)];
    const groups = new Map(view.shown.map((n) => [n.id, n.group]));
    for (const s of view.summaries) groups.set(`group:${s.g}`, `group:${s.g}`);       // a folded repo is laid out like any node (in a box of its own)
    layout(ids, view.drawn.map((e, i) => ({ id: i, src: e.src, dst: e.dst })), groups, undefined, ROOMY).then(({ pos, boxes }) => {
      if (!live) return;
      const box = new Map(boxes.map((b) => [b.id, b]));
      const abs = new Map<string, Pos>();
      for (const id of ids) {
        const p = pos.get(id) ?? { x: 0, y: 0 };
        const b = box.get(`group:${groups.get(id) ?? ""}`);       // ELK positions are relative to the node's box
        abs.set(id, { x: p.x + (b?.x ?? 0), y: p.y + (b?.y ?? 0) });
      }
      if (!firstLayout.current) { setAnimating(true); setTimeout(() => setAnimating(false), 450); }
      firstLayout.current = false;
      layoutGen.current++;
      setPlaced(abs);
    }, () => {});                                                  // an empty drawing has nothing to lay out
    return () => { live = false; };
  }, [structure, fitKey]);                                         // eslint-disable-line react-hooks/exhaustive-deps -- `view` is what `structure` describes

  useEffect(() => { fitAfter.current = layoutGen.current; }, [fitKey]);

  // 3. the React Flow nodes: laid-out position, unless the user pinned the node; boxes wrap whatever ends up where
  useEffect(() => {
    if (!placed) return;
    renderedGen.current = layoutGen.current;
    const at = (n: DesignNodeView): Pos => (has(n) ? { x: n.x!, y: n.y! } : placed.get(n.id) ?? { x: 0, y: 0 });
    const cards = view.shown.map((n) => ({ n, p: at(n) }));
    const names = new Set(view.shown.map((n) => n.group));
    const boxes: GroupNode[] = names.size + view.summaries.length > 1 ? [...names].map((g) => {
      const mine = cards.filter((c) => c.n.group === g);
      const [x0, y0] = [Math.min(...mine.map((c) => c.p.x)), Math.min(...mine.map((c) => c.p.y))];
      const [x1, y1] = [Math.max(...mine.map((c) => c.p.x)) + NODE_W, Math.max(...mine.map((c) => c.p.y)) + NODE_H];
      return {
        id: `group:${g}`, type: "group-box", position: { x: x0 - PAD.side, y: y0 - PAD.top },
        style: { width: x1 - x0 + 2 * PAD.side, height: y1 - y0 + PAD.top + PAD.bottom, pointerEvents: "none" },
        data: { label: g, count: mine.length, kind: boxKind(g, mine.map((c) => c.n)), onToggle: () => onToggleGroup(g) },
        selectable: false, draggable: false, zIndex: -1,
      };
    }) : [];
    setRfNodes([
      ...boxes,
      ...notes.map((n): NoteNode => ({ id: `note:${n.id}`, type: "note", position: { x: n.x, y: n.y }, data: { text: n.text }, selected: `note:${n.id}` === selected })),
      ...view.summaries.map((s): SummaryNode => ({ id: `group:${s.g}`, type: "summary", position: placed.get(`group:${s.g}`) ?? { x: 0, y: 0 }, data: { label: s.g, count: s.count, onOpen: () => onToggleGroup(s.g) } })),
      ...cards.map(({ n, p }): CardNode => ({
        id: n.id, type: "card", position: p, selected: n.id === selected,
        data: {
          view: n, isRoot: false, dir: "down", onExpand: onReveal, hidden: opened.has(n.id) ? 0 : folded.get(n.id) ?? 0, open: opened.has(n.id), onDecide, connectable: true, onRename, onStopEdit, editing: n.id === editing,
          dimmed: filter === "issues" ? !n.issueCount : filter === "introduced" ? !n.introduced : false,
        },
      })),
    ]);
  }, [placed, view, nodes, edges, notes, selected, editing, filter, folded, opened, onReveal, onDecide, onRename, onStopEdit, onToggleGroup, setRfNodes]);

  // 4. fit the view when the drawing is new (first open, another start point, detail level, Tidy), not on every edit.
  //    Like the app's flow view: everything if it stays readable, else the start node and what is next to it.
  useEffect(() => {
    if (fitAfter.current === null || renderedGen.current <= fitAfter.current || !flow.current) return;
    const cards = rfNodes.filter((n) => n.type === "card" || n.type === "summary");
    if (!cards.length) return;
    fitAfter.current = null;
    requestAnimationFrame(() => {
      const box = wrap.current?.getBoundingClientRect();
      const fit = flow.current;
      if (!box || !fit) return;
      const xs = cards.map((c) => c.position.x), ys = cards.map((c) => c.position.y);
      const [w, h] = [Math.max(...xs) + NODE_W - Math.min(...xs), Math.max(...ys) + NODE_H - Math.min(...ys)];
      if (Math.min(box.width / w, box.height / h) >= 0.55) { void fit.fitView({ padding: 0.15, maxZoom: 1 }); return; }
      const start = cards.reduce((a, c) => (c.position.x < a.position.x || (c.position.x === a.position.x && c.position.y < a.position.y) ? c : a));   // a flow reads from the left
      const [vw, vh] = [box.width / 0.7, box.height / 0.7];
      const near = cards.filter((c) => c.position.x >= start.position.x - NODE_W && c.position.x <= start.position.x + vw - NODE_W && Math.abs(c.position.y - start.position.y) <= vh / 2);
      void fit.fitView({ nodes: near.map((c) => ({ id: c.id })), padding: 0.1, maxZoom: 1, minZoom: 0.6 });
    });
  }, [rfNodes]);

  const rfEdges = useMemo(() => view.drawn.map((x): Edge => ({ ...designEdge(x), selected: `edge:${x.designId ?? `g${x.id}`}` === selected })), [view, selected]);
  const clientOf = (e: MouseEvent | TouchEvent | React.MouseEvent): Pos => {
    const p = "changedTouches" in e ? e.changedTouches[0] : (e as MouseEvent);
    return { x: p.clientX, y: p.clientY };
  };

  return (
    <div ref={wrap} className={`h-full w-full ${animating ? "design-animating" : ""}`}>
      <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
        onInit={(i) => {
          flow.current = i;
          getCenter.current = () => {
            const r = wrap.current!.getBoundingClientRect();
            return i.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          };
        }}
        onNodeClick={(_, n) => { if (n.type === "card" || n.type === "note") onSelect(n.id); }}
        onNodeDoubleClick={(_, n) => { if (n.type === "card") onEditNode(n.id); }}
        onNodeContextMenu={(e, n) => { if (n.type === "card" || n.type === "note") { e.preventDefault(); onSelect(n.id); onContextMenu(n.id, clientOf(e)); } }}
        onEdgeClick={(_, e) => onSelect(`edge:${e.id}`)} onPaneClick={() => onSelect(null)}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).classList.contains("react-flow__pane") || !flow.current) return;
          const client = clientOf(e);
          onQuickAdd({ flow: flow.current.screenToFlowPosition(client), client });
        }}
        onNodeDragStop={(_, n) => { if (n.type === "card" || n.type === "note") onMove(n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }); }}
        onConnect={(c) => onConnect(c.source, c.target)}
        isValidConnection={(c) => c.source !== c.target && !c.source.startsWith("note:") && !c.target.startsWith("note:") && !c.source.startsWith("group:") && !c.target.startsWith("group:")}
        onConnectEnd={(e, s) => {
          // released on empty canvas: offer to add a node there, connected from where the arrow started
          if (s.isValid || !s.fromNode || !flow.current) return;
          const client = clientOf(e);
          onQuickAdd({ flow: flow.current.screenToFlowPosition(client), client, from: s.fromNode.id, reverse: s.fromHandle?.type === "target" });
        }}
        nodesDraggable nodesConnectable elementsSelectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={0.1}>
        <Background gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.type === "group-box" ? "transparent" : n.type === "note" ? "#f59e0b" : n.type === "card" && (n as CardNode).data.view.issueCount ? C.external : C.neutral)} />
        <Panel position="top-right"><div className="flex flex-col items-end gap-2"><Key /><Legend /></div></Panel>
      </ReactFlow>
    </div>
  );
}
