import { Bot, Eye, Link2, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DetailPanel } from "../../components/DetailPanel";
import { KIND, KindIcon } from "../../components/kind";
import { EditorLink } from "../../components/refs";
import { Pill, input } from "../../components/ui";
import { useApp } from "../../context";
import type { Design, DesignEdge, DesignEdgeView, DesignItem, DesignNode, DesignNodeView, EdgeKind, NodeKind } from "../../types";
import { btn, danger, EDGE_KINDS, Field } from "./shared";

/** Everything the panel can do to the design; implemented by the editor. */
export interface DesignActions {
  modify(id: string): void;
  keep(id: string): void;
  removeCode(id: string): void;
  hide(id: string): void;
  note(id: string, text: string): void;
  patchNode(id: string, p: Partial<DesignNode>): void;
  patchEdge(id: string, p: Partial<DesignEdge>): void;
  deleteEdge(id: string): void;
  markEdgeRemoved(e: { src: string; dst: string; kind: EdgeKind }): void;
  decide(id: string, accept: boolean): void;
  setNoteText(id: string, text: string): void;
  deleteNote(id: string): void;
  link(id: string): void;               // replace a free box by real code (opens search)
}

/** One line per point (or column): a plain textarea, so adding many is just typing. Blank lines are dropped. */
function Points({ items, table, onChange }: { items: DesignItem[]; table: boolean; onChange: (items: DesignItem[] | undefined) => void }) {
  const [text, setText] = useState(items.map((i) => i.text).join("\n"));           // kept here so a new line you just typed is not dropped
  return (
    <Field label={table ? "Columns to add" : "Points"} hint={table ? "One per line, e.g. ai_job_id uuid" : "One per line"}>
      <textarea value={text} rows={4} maxLength={10000} className={`${input} w-full ${table ? "font-mono" : ""}`} placeholder={table ? "ai_job_id uuid" : "e.g. checks the balance"}
        onChange={(e) => {
          setText(e.target.value);
          const lines = e.target.value.split("\n").map((t) => t.trim().slice(0, 300)).filter(Boolean).slice(0, 100);
          onChange(lines.length ? lines.map((t) => (table ? { text: t, new: true } : { text: t })) : undefined);
        }} />
    </Field>
  );
}

/** The columns the code has today (a table's card shows the first few). */
function ColumnsToday({ columns }: { columns: { name: string; type?: string }[] }) {
  return (
    <details open={columns.length <= 8} className="text-sm">
      <summary className="cursor-pointer text-xs font-semibold tracking-wide text-fg-subtle uppercase">Columns today ({columns.length})</summary>
      <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-fg-muted">{columns.map((c) => <li key={c.name}>{c.name}{c.type ? ` ${c.type}` : ""}</li>)}</ul>
    </details>
  );
}

export function Selection({ id, draft, nodes, edges, act, onClose }: {
  id: string; draft: Design; nodes: DesignNodeView[]; edges: DesignEdgeView[]; act: DesignActions; onClose: () => void;
}) {
  const { status } = useApp();
  const head = (title: string, icon: ReactNode, badge?: ReactNode, sub?: ReactNode) => (
    <div className="flex items-start gap-2 px-5 py-3">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" title={title}>{title}</p>
        {sub}
      </div>
      {badge}
      <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-fg-muted hover:bg-muted"><X className="size-4" aria-hidden /></button>
    </div>
  );
  const suggestion = (item: { id: string; pending?: boolean }) => item.pending && (
    <div className="flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
      <Bot className="size-4" aria-hidden /> Suggested by Claude
      <button type="button" onClick={() => act.decide(item.id, true)} className="ml-auto rounded-md px-2 py-0.5 hover:bg-bg">Accept</button>
      <button type="button" onClick={() => act.decide(item.id, false)} className="rounded-md px-2 py-0.5 hover:bg-bg">Reject</button>
    </div>
  );

  // ---- a note ----
  if (id.startsWith("note:")) {
    const note = draft.notes.find((n) => `note:${n.id}` === id);
    if (!note) return null;
    return (
      <>
        {head("Note", <StickyNote className="size-4 text-warn" aria-hidden />)}
        <div className="space-y-3 px-5 pb-5">
          <textarea autoFocus value={note.text} rows={6} maxLength={2000} aria-label="Note" className={`${input} w-full`} onChange={(e) => act.setNoteText(note.id, e.target.value)} />
          <button type="button" onClick={() => act.deleteNote(note.id)} className={btn}><Trash2 className="size-4" aria-hidden /> Delete note</button>
        </div>
      </>
    );
  }

  // ---- an arrow ----
  if (id.startsWith("edge:")) {
    const rf = id.slice(5);
    const view = edges.find((e) => (e.designId ?? `g${e.id}`) === rf);
    if (!view) return null;
    const own = draft.edges.find((e) => e.id === view.designId);
    const name = (nid: string) => nodes.find((n) => n.id === nid)?.name ?? nid;
    return (
      <>
        {head(`${name(view.src)} → ${name(view.dst)}`, <span className="text-xs text-fg-subtle">Arrow</span>)}
        <div className="space-y-4 px-5 pb-5">
          {own && suggestion(own)}
          {own?.change === "new" ? (
            <>
              <Field label="What it means" hint="e.g. “calls”, “writes” (to a table), “requests” (an API from a screen)">
                <select value={own.kind} onChange={(e) => act.patchEdge(own.id, { kind: e.target.value as EdgeKind })} className={`${input} w-full`}>
                  {EDGE_KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}
                </select>
              </Field>
              <button type="button" onClick={() => act.deleteEdge(own.id)} className={btn}><Trash2 className="size-4" aria-hidden /> Delete arrow</button>
            </>
          ) : (
            <>
              <p className="text-sm text-fg-muted">In the code today: <span className="font-medium text-fg">{view.kind.replace("_", " ")}</span>{view.file && <> · <span className="font-mono text-xs">{view.file}:{view.line}</span></>}</p>
              {own
                ? <button type="button" onClick={() => act.deleteEdge(own.id)} className={btn}>Keep this call</button>
                : <button type="button" onClick={() => act.markEdgeRemoved(view)} className={danger}><Trash2 className="size-4" aria-hidden /> This design removes this call</button>}
            </>
          )}
        </div>
      </>
    );
  }

  const v = nodes.find((n) => n.id === id);
  const own = draft.nodes.find((n) => n.id === id);
  if (!v) return null;

  // ---- a free box: a step, a decision, a text ----
  if (own?.kind === "Box") {
    return (
      <>
        {head(own.name, <KindIcon kind="Box" />)}
        <div className="space-y-4 px-5 pb-5">
          {suggestion(own)}
          <Field label="Title">
            <input value={own.name} onChange={(e) => act.patchNode(own.id, { name: e.target.value })} maxLength={300} className={`${input} w-full`} />
          </Field>
          <Field label="Shape">
            <select value={own.shape ?? "box"} onChange={(e) => act.patchNode(own.id, { shape: e.target.value as DesignNode["shape"] })} className={`${input} w-full`}>
              <option value="box">Box</option><option value="decision">Decision</option><option value="text">Text</option>
            </select>
          </Field>
          <Points key={own.id} items={own.items ?? []} table={false} onChange={(items) => act.patchNode(own.id, { items })} />
          <button type="button" onClick={() => act.link(own.id)} title="Search the code and turn this box into the real function, table or API" className={btn}><Link2 className="size-4" aria-hidden /> Link to code…</button>
          <button type="button" onClick={() => act.hide(own.id)} className={danger}><Trash2 className="size-4" aria-hidden /> Delete this box</button>
        </div>
      </>
    );
  }

  // ---- something new that this design proposes ----
  if (own?.change === "new") {
    return (
      <>
        {head(own.name, <KindIcon kind={own.kind} />, <Pill tone="accent">new</Pill>)}
        <div className="space-y-4 px-5 pb-5">
          {suggestion(own)}
          <p className="text-xs text-fg-subtle">Double-click the node on the canvas (or press F2) to rename it there.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind">
              <select value={own.kind} onChange={(e) => act.patchNode(own.id, { kind: e.target.value as NodeKind })} className={`${input} w-full`}>
                {(Object.keys(KIND) as NodeKind[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
              </select>
            </Field>
            <Field label="Repo">
              <select value={own.repo} onChange={(e) => act.patchNode(own.id, { repo: e.target.value })} className={`${input} w-full`}>
                <option value="">—</option>
                {status?.repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Name" hint="Same style as your code, so the check can find it once it's built.">
            <input value={own.name} onChange={(e) => act.patchNode(own.id, { name: e.target.value })} maxLength={300} className={`${input} w-full`} />
          </Field>
          <Field label="Suggested file">
            <input value={own.file ?? ""} onChange={(e) => act.patchNode(own.id, { file: e.target.value || undefined })} placeholder="src/…" maxLength={300} className={`${input} w-full font-mono`} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!own.transactional} onChange={(e) => act.patchNode(own.id, { transactional: e.target.checked || undefined })} className="size-4 accent-accent" />
            Opens a DB transaction
          </label>
          <Field label="Auth guards (comma-separated)">
            <input value={own.guards?.join(", ") ?? ""} onChange={(e) => act.patchNode(own.id, { guards: e.target.value.trim() ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined })} placeholder="e.g. AuthGuard" className={`${input} w-full`} />
          </Field>
          <Points key={own.id} items={own.items ?? []} table={own.kind === "Table"} onChange={(items) => act.patchNode(own.id, { items })} />
          <Field label="Note">
            <textarea value={own.note ?? ""} onChange={(e) => act.patchNode(own.id, { note: e.target.value || undefined })} rows={2} maxLength={2000} className={`${input} w-full`} placeholder="Why, constraints, what to reuse…" />
          </Field>
          <button type="button" onClick={() => act.hide(own.id)} className={danger}><Trash2 className="size-4" aria-hidden /> Delete this node</button>
        </div>
      </>
    );
  }

  // ---- code that exists today ----
  const change = own?.change ?? "existing";
  return (
    <>
      {head(v.name, <KindIcon kind={v.kind} />, change === "changed" ? <Pill tone="tx">changing</Pill> : change === "removed" ? <Pill>removing</Pill> : undefined,
        <EditorLink repo={v.repo} file={v.file} line={v.line} className="mt-0.5" />)}
      <section className="space-y-3 border-y border-line px-5 py-4">
        {own && suggestion(own)}
        <p className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">In this design</p>
        {v.kind === "Table" && Array.isArray(v.attrs.columns) && v.attrs.columns.length > 0 && <ColumnsToday columns={v.attrs.columns as { name: string; type?: string }[]} />}
        {change === "existing" && (
          <>
            <p className="text-sm text-fg-muted">This code is only shown for context. Say what the design does to it:</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => act.modify(id)} className={btn}>{v.kind === "Table" ? <><Plus className="size-4" aria-hidden /> Add a column</> : <><Pencil className="size-4" aria-hidden /> Modify it</>}</button>
              <button type="button" onClick={() => act.removeCode(id)} className={danger}><Trash2 className="size-4" aria-hidden /> Remove it</button>
            </div>
          </>
        )}
        {change === "changed" && (
          <>
            <Field label="What changes?" hint="Goes into the RFC.">
              <textarea autoFocus value={own?.note ?? ""} onChange={(e) => act.note(id, e.target.value)} rows={3} maxLength={2000} className={`${input} w-full`} placeholder="e.g. also checks the user is not archived" />
            </Field>
            {own && <Points key={own.id} items={own.items ?? []} table={own.kind === "Table"} onChange={(items) => act.patchNode(own.id, { items })} />}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => act.keep(id)} className={btn}><Eye className="size-4" aria-hidden /> Not changing it after all</button>
              <button type="button" onClick={() => act.removeCode(id)} className={danger}><Trash2 className="size-4" aria-hidden /> Remove it instead</button>
            </div>
          </>
        )}
        {change === "removed" && (
          <>
            <Field label="Why, and what replaces it?" hint="Goes into the RFC. Callers of removed code are flagged under Impact.">
              <textarea value={own?.note ?? ""} onChange={(e) => act.note(id, e.target.value)} rows={3} maxLength={2000} className={`${input} w-full`} />
            </Field>
            <button type="button" onClick={() => act.keep(id)} className={btn}><Eye className="size-4" aria-hidden /> Keep it</button>
          </>
        )}
        <details className="text-xs text-fg-subtle">
          <summary className="cursor-pointer hover:text-fg-muted">What do these do?</summary>
          <p className="mt-1.5">Marking code as modified or removed tells FlowMap what your design touches. Impact then shows who depends on it and which checks would fire, it is listed under Changes in the RFC, and <code>flowmap check --design</code> verifies it after you build.</p>
        </details>
        {own && (
          <button type="button" onClick={() => act.hide(id)} title="Only takes it off this drawing. The code is not affected." className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline">
            Hide from this diagram
          </button>
        )}
      </section>
      <DetailPanel id={id} isRoot onClose={onClose} onFocus={() => {}} embedded />
    </>
  );
}
