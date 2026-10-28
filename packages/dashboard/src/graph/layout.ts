import ELK, { type ElkNode } from "elkjs/lib/elk-api.js";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";

// ELK runs in its own Web Worker so layout never blocks the UI thread.
const elk = new ELK({ workerUrl });

export const NODE_W = 256;
export const NODE_H = 80;

export interface Box { id: string; x: number; y: number; width: number; height: number }

export interface Gap { layers: number; nodes: number }
const TIGHT: Gap = { layers: 80, nodes: 24 };
/** Room for the words on arrows (the design canvas and the RFC image). */
export const ROOMY: Gap = { layers: 130, nodes: 40 };

const options = (gap: Gap) => ({
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(gap.layers),
  "elk.spacing.nodeNode": String(gap.nodes),
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
});

/**
 * Left-to-right layout. With `groups` (node id → group name) and more than one group, each group becomes a box
 * (repo / service) laid out together with the edges that cross between boxes. Child positions are relative to their box.
 */
export async function layout(ids: string[], edges: { id: number; src: string; dst: string }[], groups?: Map<string, string>,
  size: (id: string) => { width: number; height: number } = () => ({ width: NODE_W, height: NODE_H }), gap: Gap = TIGHT) {
  const OPTIONS = options(gap);
  const names = groups ? [...new Set(ids.map((id) => groups.get(id) ?? ""))] : [];
  const grouped = names.length > 1;
  const leaf = (id: string): ElkNode => ({ id, ...size(id) });
  const children: ElkNode[] = grouped
    ? names.map((g) => ({
        id: `group:${g}`,
        layoutOptions: { ...OPTIONS, "elk.padding": "[top=48,left=24,bottom=24,right=24]" },
        children: ids.filter((id) => groups!.get(id) === g).map(leaf),
      }))
    : ids.map(leaf);
  const g = await elk.layout({
    id: "root",
    layoutOptions: { ...OPTIONS, ...(grouped ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN", "elk.spacing.nodeNode": "48" } : {}) },
    children,
    edges: edges.map((e) => ({ id: String(e.id), sources: [e.src], targets: [e.dst] })),
  });
  const pos = new Map<string, { x: number; y: number }>();
  const boxes: Box[] = [];
  for (const c of g.children ?? []) {
    if (grouped) {
      boxes.push({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 });
      for (const k of c.children ?? []) pos.set(k.id, { x: k.x ?? 0, y: k.y ?? 0 });
    } else pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  }
  return { pos, boxes };
}
