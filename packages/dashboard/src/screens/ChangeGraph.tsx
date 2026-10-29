import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { changesKeep, trim } from "../../../core/src/design-view";
import { enc } from "../api";
import { KindIcon } from "../components/kind";
import { EditorLink } from "../components/refs";
import { Pill } from "../components/ui";
import { DesignGraph, type Pos } from "../graph/DesignGraph";
import type { ChangeSet } from "../types";

const none = () => {};

/** The changed lines, as a diff: added in green, removed in red, the position in grey. */
export function DiffView({ text }: { text?: string }) {
  if (!text) return <p className="text-xs text-fg-subtle">No lines to show: the change is elsewhere in the file, or the file is new.</p>;
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-xs leading-relaxed">
      {text.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "bg-success-soft text-success" : l.startsWith("-") ? "bg-error-soft text-error" : "text-fg-subtle"}>{l || " "}</div>
      ))}
    </pre>
  );
}

export const StatusPill = ({ change }: { change?: string }) => (change === "new" ? <Pill tone="accent">new</Pill> : change === "changed" ? <Pill tone="tx">changed</Pill> : null);

/**
 * The changed code and what it reaches, drawn like a design's Changes view: about ten boxes, the rest folded behind a "+N".
 * Click a box to see what changed in it, next to the picture; double-click to follow it in the Explorer.
 */
export function ChangeGraph({ graph, diffs }: { graph: ChangeSet["graph"]; diffs: ChangeSet["diffs"] }) {
  const center = useRef<(() => Pos) | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);                // the picture on the whole screen
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  const shown = useMemo(() => {
    const arrows = graph.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind }));
    const { nodes, hidden } = trim(graph.nodes, arrows, changesKeep(graph.nodes, arrows));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => e.dst && ids.has(e.src) && ids.has(e.dst)), folded: new Map([...hidden].map(([id, list]) => [id, list.length] as const)) };
  }, [graph]);
  const node = graph.nodes.find((n) => n.id === selected);
  const open = (id: string) => { location.hash = `#/explore/${enc(id)}`; };
  return (
    <div className={full ? "fixed inset-0 z-40 grid grid-rows-[auto_minmax(0,1fr)] gap-3 bg-bg p-4" : ""}>
      <div className={`flex items-center justify-between ${full ? "" : "mb-3"}`}>
        <h2 className="text-sm font-semibold">What it reaches</h2>
        <button type="button" onClick={() => setFull(!full)} aria-pressed={full} title={full ? "Back to the page (Esc)" : "Fill the screen"}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:bg-muted">
          {full ? <><Minimize2 className="size-3.5" aria-hidden />Back</> : <><Maximize2 className="size-3.5" aria-hidden />Full screen</>}
        </button>
      </div>
      <div className={`grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] ${full ? "" : "h-[28rem]"}`}>
      <div className="min-h-0 overflow-hidden rounded-lg border border-line">
        <DesignGraph readOnly nodes={shown.nodes} edges={shown.edges} notes={[]} selected={selected} editing={null} filter="all" collapsed={new Set()}
          fitKey={`${shown.nodes.map((n) => n.id).join("|")}|${full}`} getCenter={center} folded={shown.folded} opened={new Set()} onReveal={none}
          onSelect={(id) => setSelected(id && !/^(edge|note|group):/.test(id) ? id : null)} onMove={none} onConnect={none} onDecide={none}
          onRename={none} onStopEdit={none} onToggleGroup={none} onEditNode={open} onQuickAdd={none} onContextMenu={none}
          tool="select" onTool={none} onDraw={none} onResize={none} />
      </div>
      <aside aria-label="What changed" className="min-h-0 overflow-y-auto rounded-lg border border-line p-4 text-sm">
        {node ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <KindIcon kind={node.kind} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={node.name}>{node.name}</p>
                <EditorLink repo={node.repo} file={node.file} line={node.line} />
              </div>
              {node.change === "existing" ? <Pill>not changed</Pill> : <StatusPill change={node.change} />}
            </div>
            {node.change === "existing"
              ? <p className="text-fg-muted">This code did not change. The change reaches it.</p>
              : <><p className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">What changed</p><DiffView text={diffs[node.id]} /></>}
            <button type="button" onClick={() => open(node.id)} className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-muted">Open its flow</button>
          </div>
        ) : <p className="text-fg-muted">Click a box to see what changed in it. Double-click to follow its flow.</p>}
      </aside>
      </div>
    </div>
  );
}
