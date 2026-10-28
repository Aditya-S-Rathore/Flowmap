import { changesKeep, numberChanges, summarize, trim } from "../../../core/src/design-view";
import type { DesignView, NodeKind } from "../types";
import { EFFECT_WORD } from "./DesignGraph";
import { layout } from "./layout";

// The picture that goes into the RFC: the Changes view, drawn for a reader who has never seen the code.
// Light background whatever the theme, plain words first (what changes), the code name small, numbers that match the RFC's table.

const W = 252, H = 78, PAD = 28, HEAD = 84;
const GAP = { layers: 190, nodes: 34 };
const INK = "#0f172a", MUTED = "#64748b", LINE = "#e2e8f0";
const COLOR = { new: "#4f46e5", changed: "#d97706", removed: "#dc2626", existing: "#94a3b8" } as const;
const WORD = { new: "NEW", changed: "CHANGING", removed: "REMOVING", existing: "" } as const;
const KIND: Record<NodeKind, string> = {
  Route: "SCREEN", Component: "COMPONENT", ClientCall: "CLIENT CALL", Operation: "API", Schema: "SCHEMA", Function: "FUNCTION",
  Guard: "GUARD", Table: "TABLE", External: "OUTSIDE SERVICE", Job: "JOB", Queue: "QUEUE",
};
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Greedy word wrap into at most `lines` lines; the last one ends with "…" when the text is longer. */
function wrap(text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (line && (line + " " + word).length > max) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  const shown = out.join(" ").length;
  if (shown < text.replace(/\s+/g, " ").trim().length) out[out.length - 1] = out[out.length - 1].replace(/.{0,2}$/, "") + "…";
  return out.map((l) => (l.length > max ? l.slice(0, max - 1) + "…" : l));
}

export interface Diagram { svg: string; width: number; height: number }

export async function diagramSvg(v: DesignView): Promise<Diagram> {
  const arrows = v.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, change: e.change === "new" || e.change === "removed" ? e.change : undefined }));
  const { nodes } = trim(v.nodes, arrows, changesKeep(v.nodes, arrows));
  const shown = new Set(nodes.map((n) => n.id));
  const edges = v.edges.filter((e) => shown.has(e.src) && shown.has(e.dst));
  const numbers = numberChanges(v.nodes);
  const summary = summarize(v.design.nodes);

  const { pos } = await layout(nodes.map((n) => n.id), edges.map((e, i) => ({ id: i, src: e.src, dst: e.dst })), undefined, () => ({ width: W, height: H }), GAP);
  const xs = nodes.map((n) => pos.get(n.id)?.x ?? 0), ys = nodes.map((n) => pos.get(n.id)?.y ?? 0);
  const [x0, y0] = [Math.min(0, ...xs), Math.min(0, ...ys)];
  const width = Math.max(620, Math.max(0, ...xs) - x0 + W + 2 * PAD);
  const height = Math.max(0, ...ys) - y0 + H + HEAD + PAD;
  const at = (id: string) => ({ x: (pos.get(id)?.x ?? 0) - x0 + PAD, y: (pos.get(id)?.y ?? 0) - y0 + HEAD });

  const marker = (name: string, color: string) => `<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
  // a word on an arrow goes at the first point along it that is clear of the boxes and of the words already placed
  const boxes = nodes.map((n) => at(n.id));
  const words: { x: number; y: number; w: number }[] = [];
  const clear = (x: number, y: number, w: number) =>
    !words.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 + 4 && Math.abs(o.y - y) < 24) &&
    !boxes.some((b) => x + w / 2 > b.x - 4 && x - w / 2 < b.x + W + 4 && y + 10 > b.y - 4 && y - 10 < b.y + H + 4);

  const arrow = (e: (typeof edges)[number]) => {
    const [a, b] = [at(e.src), at(e.dst)];
    const [sx, sy, tx, ty] = [a.x + W, a.y + H / 2, b.x, b.y + H / 2];
    const dx = Math.max(40, Math.abs(tx - sx) / 2);
    const color = e.change === "new" ? COLOR.new : e.change === "removed" ? COLOR.removed : COLOR.existing;
    const dash = e.change === "new" ? ' stroke-dasharray="6 4"' : e.change === "removed" ? ' stroke-dasharray="2 4"' : "";
    const word = e.change === "removed" ? "removed" : EFFECT_WORD[e.kind];
    const on = (t: number) => {                                   // a point on the curve
      const u = 1 - t, c = [sx, sx + dx, tx - dx, tx], d = [sy, sy, ty, ty];
      return { x: u * u * u * c[0] + 3 * u * u * t * c[1] + 3 * u * t * t * c[2] + t * t * t * c[3], y: u * u * u * d[0] + 3 * u * u * t * d[1] + 3 * u * t * t * d[2] + t * t * t * d[3] };
    };
    let label = "";
    if (word) {
      const w = word.length * 6.8 + 14;
      const spot = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8].map(on).find((p) => clear(p.x, p.y, w)) ?? on(0.5);
      words.push({ ...spot, w });
      label = `<rect x="${spot.x - w / 2}" y="${spot.y - 10}" width="${w}" height="20" rx="10" fill="#fff" stroke="${LINE}"/><text x="${spot.x}" y="${spot.y + 4}" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(word)}</text>`;
    }
    return `<path d="M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}" fill="none" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#m-${e.change ?? "plain"})"/>${label}`;
  };

  const box = (n: (typeof nodes)[number]) => {
    const { x, y } = at(n.id);
    const c = COLOR[n.change];
    const note = n.change !== "existing" ? n.note?.trim() : "";
    const main = wrap(note || n.name, 32, 2);
    const kind = [KIND[n.kind], WORD[n.change]].filter(Boolean).join(" · ");
    const number = numbers.get(n.id);
    return `<g opacity="${n.change === "removed" ? 0.8 : 1}">
  <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10" fill="#fff" stroke="${c}" stroke-width="${n.change === "existing" ? 1.2 : 2}"${n.change === "new" ? ' stroke-dasharray="6 4"' : n.change === "removed" ? ' stroke-dasharray="3 3"' : ""}/>
  <text x="${x + 16}" y="${y + 20}" font-size="10" letter-spacing="0.6" font-weight="600" fill="${n.change === "existing" ? MUTED : c}">${esc(kind)}</text>
  ${main.map((l, i) => `<text x="${x + 16}" y="${y + 40 + i * 16}" font-size="13.5" font-weight="600" fill="${INK}"${n.change === "removed" ? ' text-decoration="line-through"' : ""}>${esc(l)}</text>`).join("\\n  ")}
  ${note ? `<text x="${x + 16}" y="${y + H - 9}" font-size="10.5" font-family="${MONO}" fill="${MUTED}">${esc(wrap(n.name, 38, 1)[0])}</text>` : ""}
  ${number ? `<circle cx="${x}" cy="${y}" r="12" fill="${c}"/><text x="${x}" y="${y + 4.5}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${number}</text>` : ""}
</g>`;
  };

  const KEY = [["new", "New", 24], ["changed", "Changing", 54], ["removed", "Removing", 58]] as const;
  let kx = width - PAD - KEY.reduce((n, [, , w]) => n + 22 + w + 18, -18);                // right-aligned, evenly spaced
  const key = KEY.map(([k, label, w]) => {
    const x = kx;
    kx += 22 + w + 18;
    return `<rect x="${x}" y="22" width="16" height="11" rx="3" fill="#fff" stroke="${COLOR[k]}" stroke-width="2"${k === "new" ? ' stroke-dasharray="4 3"' : k === "removed" ? ' stroke-dasharray="2 2"' : ""}/><text x="${x + 22}" y="31.5" font-size="11.5" fill="${MUTED}">${label}</text>`;
  }).join("");

  const body = nodes.length
    ? `${edges.map(arrow).join("\n")}\n${nodes.map(box).join("\n")}`
    : `<text x="${PAD}" y="${HEAD + 30}" font-size="14" fill="${MUTED}">Nothing has changed yet.</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${SANS}">
<defs>${marker("m-plain", COLOR.existing)}${marker("m-new", COLOR.new)}${marker("m-removed", COLOR.removed)}</defs>
<rect width="${width}" height="${height}" fill="#fff"/>
<text x="${PAD}" y="34" font-size="19" font-weight="700" fill="${INK}">What changes</text>
<text x="${PAD}" y="56" font-size="12.5" fill="${MUTED}">${esc(summary || "Nothing changed yet")}${nodes.length ? " · numbers match the “What changes” table" : ""}</text>
${key}
${body}
</svg>`;
  return { svg, width, height };
}

/** The picture as a PNG (twice the size, so it stays sharp in a document). A data: address, because the page's security policy only allows those for images. */
export async function pngBlob({ svg, width, height }: Diagram, scale = 2): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((ok, fail) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => fail(new Error("Couldn't draw the diagram"));
    i.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = Object.assign(document.createElement("canvas"), { width: width * scale, height: height * scale });
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't make the image"))), "image/png"));
}
