import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { AppWindow, Cloud, Layers, Network, Server } from "lucide-react";
import { memo, useEffect, useMemo } from "react";
import { exploreHref } from "../components/refs";
import { Empty, card } from "../components/ui";
import type { ArchLink, ArchNode, Architecture } from "../types";
import { layout } from "./layout";

type ServiceNode = Node<{ node: ArchNode }, "service">;

const SIZE = { service: { width: 240, height: 96 }, small: { width: 200, height: 44 } };
const LINK: Record<ArchLink["kind"], { color: string; label: string; one: string }> = {
  requests: { color: "#6366f1", label: "API calls", one: "API call" },
  enqueues: { color: "#a1a1aa", label: "jobs queued", one: "job queued" },
  calls_external: { color: "#ef4444", label: "calls", one: "call" },
  triggers: { color: "#a1a1aa", label: "triggers", one: "trigger" },
};

const ServiceCard = memo(function ServiceCard({ data }: NodeProps<ServiceNode>) {
  const n = data.node;
  const Icon = n.kind === "external" ? Cloud : n.kind === "queue" ? Layers : n.screens ? AppWindow : Server;
  const stats = [n.screens && `${n.screens} screens`, n.apis && `${n.apis} APIs`, n.tables && `${n.tables} tables`, n.jobs && `${n.jobs} jobs`].filter(Boolean).join(" · ");
  if (n.kind !== "service") {
    const tone = n.kind === "external" ? "border-external/40 bg-external-soft" : "border-line bg-muted";
    return (
      <div className={`flex h-11 w-50 items-center gap-2 rounded-lg border ${tone} px-3`} title={n.label}>
        <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />
        <Icon className={`size-4 shrink-0 ${n.kind === "external" ? "text-external" : "text-fg-muted"}`} aria-hidden />
        <span className="truncate text-sm font-medium">{n.label}</span>
        <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />
      </div>
    );
  }
  return (
    <div className="flex h-24 w-60 flex-col justify-center gap-1 rounded-xl border-2 border-dashed border-line-strong bg-bg px-4">
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Icon className={`size-4 shrink-0 ${n.screens ? "text-accent" : "text-fg-muted"}`} aria-hidden />
        <span className="truncate" title={n.label}>{n.label}</span>
      </p>
      <p className="truncate text-xs text-fg-muted">{stats || "No screens or APIs"}</p>
      {n.issues > 0 && <p className="text-xs text-warn">{n.issues} issues</p>}
      <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />
    </div>
  );
});

const nodeTypes = { service: ServiceCard };

/** Which service calls which: services as dashed boxes, outside services in red, edges counted. */
export function ArchGraph({ arch }: { arch: Architecture }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ServiceNode>([]);
  const edges = useMemo<Edge[]>(() => arch.links.map((l, i) => ({
    id: String(i), source: l.src, target: l.dst,
    label: `${l.count} ${l.count === 1 ? LINK[l.kind].one : LINK[l.kind].label}`,
    style: { stroke: LINK[l.kind].color, strokeWidth: Math.min(1.5 + Math.log2(l.count), 5) },
    markerEnd: { type: MarkerType.ArrowClosed, color: LINK[l.kind].color, width: 16, height: 16 },
    labelStyle: { fontSize: "0.6875rem", fontWeight: 500 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
  })), [arch]);

  useEffect(() => {
    let live = true;
    const kind = new Map(arch.nodes.map((n) => [n.id, n.kind]));
    layout(arch.nodes.map((n) => n.id), arch.links.map((l, i) => ({ id: i, src: l.src, dst: l.dst })), undefined, (id) => (kind.get(id) === "service" ? SIZE.service : SIZE.small)).then(({ pos }) => {
      if (live) setNodes(arch.nodes.map((n) => ({ id: n.id, type: "service", position: pos.get(n.id) ?? { x: 0, y: 0 }, data: { node: n } })));
    });
    return () => { live = false; };
  }, [arch, setNodes]);

  if (!arch.nodes.length) return <Empty icon={Network} title="Nothing indexed yet" />;
  const label = new Map(arch.nodes.map((n) => [n.id, n.label]));
  return (
    <div className="space-y-6">
      <div className={`${card} h-[68vh] min-h-[28rem] overflow-hidden`}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
          onNodeClick={(_, n) => { if (n.data.node.kind === "service") location.hash = `#/map?tab=apis&group=${encodeURIComponent(n.data.node.label)}`; }}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} fitView fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }} minZoom={0.2}>
          <Background gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
      <section className={card} aria-label="Connections">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Connections</h2>
        {arch.links.length ? (
          <ul className="divide-y divide-line">
            {[...arch.links].sort((a, b) => b.count - a.count).map((l, i) => (
              <li key={i} className="px-4 py-2.5 text-sm">
                <p><span className="font-medium">{label.get(l.src)}</span> <span className="text-fg-subtle">→</span> <span className="font-medium">{label.get(l.dst)}</span>
                  <span className="ml-2 text-xs text-fg-muted">{l.count} {l.count === 1 ? LINK[l.kind].one : LINK[l.kind].label}</span></p>
                <p className="mt-1 flex flex-wrap gap-1.5">
                  {l.samples.map((s) => <a key={s.id} href={exploreHref(s.id)} className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-fg-muted hover:border-accent hover:text-accent">{s.name}</a>)}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="px-4 py-3 text-sm text-fg-subtle">No calls between services found.</p>}
      </section>
    </div>
  );
}
