// Which of the nodes stored in a design are drawn. Generic on purpose: it only looks at what each node is *to the design*
// (changed, new, removed, suggested, added by hand) and how nodes are linked, never at names, kinds, repos or frameworks.

export type ViewMode = "changes" | "flow" | "full";

/** A free element of the drawing (a step, a decision, a text). It is not code, so checks, counts and the RFC's change table leave it out. */
export const isSketch = (n: { kind?: string }) => n.kind === "Box";

/** Lines a card can show before the rest fold into "+N more", and what each line adds to its height. */
export const MAX_LINES = 6;
const LINE_H = 18;

export interface Line { text: string; new?: boolean; column?: boolean }     // column: one the code has today

/** The lines inside a node, what this design adds first: its own points or new columns, then the columns the code has today. */
export function linesOf(n: { items?: Line[]; attrs?: Record<string, unknown> }): Line[] {
  const columns = Array.isArray(n.attrs?.columns) ? (n.attrs.columns as { name: string; type?: string }[]).map((c) => ({ text: c.type ? `${c.name} ${c.type}` : c.name, column: true })) : [];
  return [...(n.items ?? []), ...columns];
}

/** A card's height: `base`, plus a row per line shown (and one for "+N more"). */
export const cardHeight = (base: number, lines: number) => base + (Math.min(lines, MAX_LINES) + (lines > MAX_LINES ? 1 : 0)) * LINE_H;

export interface DesignNodeLike {
  id: string;
  change: "existing" | "new" | "changed" | "removed";
  pending?: boolean;
  keep?: boolean;           // you asked to see this one (added it from search): shown although it is unchanged
}

/** Something this design does, or that Claude suggested and is waiting for you. */
export const isChange = (n: Pick<DesignNodeLike, "change" | "pending">) => n.change !== "existing" || !!n.pending;

/**
 * The design nodes to draw. Always: the ones the design changes, suggestions waiting for review, and what you asked to see.
 * Also: nodes that belong to the real flow being shown, and nodes an arrow ties to one of the changes (so every arrow has both ends).
 * Anything else stored in the file (unchanged code Claude once listed for context) stays out of the way, so changing the
 * start point changes the picture.
 */
export function visibleDesignNodes<N extends DesignNodeLike>(nodes: N[], arrows: { src: string; dst: string }[], inFlow: ReadonlySet<string>): N[] {
  const changes = new Set(nodes.filter(isChange).map((n) => n.id));
  const tied = new Set<string>();
  for (const a of arrows) {
    if (changes.has(a.src)) tied.add(a.dst);
    if (changes.has(a.dst)) tied.add(a.src);
  }
  return nodes.filter((n) => isChange(n) || n.keep || inFlow.has(n.id) || tied.has(n.id));
}

/** "3 new · 5 changing": what a design does, in words. */
export function summarize(nodes: (Pick<DesignNodeLike, "change"> & { kind?: string })[]): string {
  const count = (c: DesignNodeLike["change"]) => nodes.filter((n) => n.change === c && !isSketch(n)).length;
  return [[count("new"), "new"], [count("changed"), "changing"], [count("removed"), "removing"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(" · ");
}

// ---------- keeping the picture small: what each view keeps, and what folds behind a "+N" ----------

/** An arrow between two nodes. `change` is set on the ones the design itself adds or removes. */
export interface Arrow { src: string; dst: string; kind?: string; change?: "new" | "removed" }

/** What code does to the outside world: the links a reviewer cares about. Plain "calls" arrows are the noisy ones. */
const EFFECTS = new Set(["reads", "writes", "calls_external", "enqueues"]);

/**
 * The Changes view keeps: what the design changes, suggestions waiting for review, what you asked to see, both ends of every
 * arrow the design adds or removes, and what changed code reads, writes or sends out (tables, queues, outside services).
 * Everything else that merely sits next to a change (the helpers it calls) folds away.
 */
export function changesKeep(nodes: DesignNodeLike[], arrows: Arrow[]): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  const changing = new Set(nodes.filter(isChange).map((n) => n.id));
  const keep = new Set(nodes.filter((n) => isChange(n) || n.keep).map((n) => n.id));
  for (const a of arrows) {
    if (a.change) { keep.add(a.src); keep.add(a.dst); }
    else if (a.kind && EFFECTS.has(a.kind) && changing.has(a.src)) keep.add(a.dst);
  }
  return new Set([...keep].filter((id) => ids.has(id)));
}

/**
 * The Flow view keeps what the Changes view keeps plus everything on the way to a change: the entry points and every step
 * between them and the changed code (`routes`: the arrows of the flow). Branches that lead nowhere near a change fold away.
 */
export function flowKeep(known: ReadonlySet<string>, design: DesignNodeLike[], arrows: Arrow[], routes: Arrow[] = arrows): Set<string> {
  const keep = changesKeep(design, arrows);
  // "leads to a change" is read from the routes of the flow itself, not from every arrow between stored nodes: a function that
  // merely reads a changed table, or is called by one, is not on the way to it
  const into = new Map<string, string[]>();
  for (const a of routes) into.set(a.dst, [...(into.get(a.dst) ?? []), a.src]);
  const queue = design.filter(isChange).map((n) => n.id);
  const seen = new Set(queue);
  while (queue.length) {
    for (const src of into.get(queue.pop()!) ?? []) if (!seen.has(src)) { seen.add(src); queue.push(src); }
  }
  for (const id of seen) if (known.has(id)) keep.add(id);
  return keep;
}

/**
 * Draws only `keep`. Each drawn node gets the list of nodes folded behind it (its "+N"). Opening one (`revealed`) brings its
 * folded neighbours into the picture, and they can be opened in turn.
 */
export function trim<N extends { id: string }>(nodes: N[], arrows: Arrow[], keep: ReadonlySet<string>, revealed: ReadonlySet<string> = new Set()): { nodes: N[]; hidden: Map<string, string[]> } {
  const ids = new Set(nodes.map((n) => n.id));
  const around = new Map<string, Set<string>>();
  const link = (a: string, b: string) => around.set(a, (around.get(a) ?? new Set()).add(b));
  for (const a of arrows) if (ids.has(a.src) && ids.has(a.dst) && a.src !== a.dst) { link(a.src, a.dst); link(a.dst, a.src); }

  const show = new Set([...keep].filter((id) => ids.has(id)));
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const id of revealed) if (show.has(id)) for (const other of around.get(id) ?? []) if (!show.has(other)) { show.add(other); grew = true; }
    if (!grew) break;
  }
  const hidden = new Map<string, string[]>();
  for (const id of show) {
    const folded = [...(around.get(id) ?? [])].filter((o) => !show.has(o));
    if (folded.length) hidden.set(id, folded);
  }
  return { nodes: nodes.filter((n) => show.has(n.id)), hidden };
}

const SECTION = {
  problem: "## Problem\n- What is wrong or missing today? Use numbers where you can.",
  goals: "## Goals and non-goals\n- Goal:\n- Non-goal:",
  proposal: "## Proposal\n1. First change: what, in one or two lines.",
  alternatives: "## Alternatives considered\n- Option: why not.",
  risks: "## Risks and impact\n- What could go wrong, and how it is limited.",
  rollout: "## Rollout\n- Order of deploys, flags and migrations, and how to roll back.",
};
const join = (...keys: (keyof typeof SECTION)[]) => `${keys.map((k) => SECTION[k]).join("\n\n")}\n`;

/** The sections people write. FlowMap writes the rest (TL;DR numbers, diagram, what changes, decisions, impact) from the design itself. */
export const RFC_TEMPLATE = join("problem", "goals", "proposal", "alternatives", "risks", "rollout");

/** For a small change (one layer, one team): four sections are enough. */
export const RFC_TEMPLATE_SHORT = join("problem", "proposal", "risks", "rollout");

/** The changes in the order the RFC lists them (by repo, then as stored): the number on each box of the diagram and each row of the table. */
export function numberChanges(nodes: { id: string; change: DesignNodeLike["change"]; repo: string; kind?: string }[]): Map<string, number> {
  const changed = nodes.filter((n) => n.change !== "existing" && !isSketch(n));
  const repos = [...new Set(changed.map((n) => n.repo || "Shared"))];
  return new Map(repos.flatMap((r) => changed.filter((n) => (n.repo || "Shared") === r)).map((n, i) => [n.id, i + 1] as const));
}

/** Where the diagram image goes in the exported RFC: pasted in by hand, or replaced by the dashboard's preview and bundle. */
export const DIAGRAM_MARKER = "_Diagram: paste the image here._";
