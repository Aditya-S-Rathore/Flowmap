import { Bot, ChevronRight, CircleCheck, FileText, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { enc, get, getText } from "../../api";
import { Markdown } from "../../components/Markdown";
import { CollapseButton } from "../../components/Collapsible";
import { IssueRow } from "../../components/IssueRow";
import { RefList } from "../../components/refs";
import { Skeleton, input } from "../../components/ui";
import type { Design, DesignView } from "../../types";
import { DIAGRAM_MARKER, RFC_TEMPLATE } from "../../../../core/src/design-view";
import { diagramSvg } from "../../graph/diagramSvg";
import { btn, Field } from "./shared";

export type Tab = "selection" | "impact" | "doc";
export type Update = (fn: (d: Design) => Design, coalesce?: string) => void;

/** A section that folds: title, count, content. */
function Fold({ title, count, open = true, children }: { title: string; count?: number; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group border-b border-line last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        {title}
        {count !== undefined && <span className="rounded bg-muted px-1.5 font-mono text-fg-muted">{count}</span>}
      </summary>
      <div className="space-y-2 pb-4">{children}</div>
    </details>
  );
}

export function SidePanel({ slug, tab, setTab, hasSelection, view, draft, update, onSend, claudeBusy, flush, onCollapse, children }: {
  slug: string; tab: Tab; setTab: (t: Tab) => void; hasSelection: boolean; view?: DesignView; draft: Design;
  update: Update; onSend: (text: string) => void; claudeBusy: boolean; flush: () => Promise<void>; onCollapse: () => void; children: ReactNode;
}) {
  const impact = view?.impact;
  const tabs: [Tab, string][] = [...(hasSelection ? [["selection", "Selection"] as [Tab, string]] : []), ["impact", `Impact${impact?.introduced.length ? ` · ${impact.introduced.length}` : ""}`], ["doc", "RFC"]];
  return (
    <aside aria-label="Design details" className="hidden w-full flex-col border-l border-line bg-bg md:flex md:w-md">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <div role="tablist" className="flex min-w-0 flex-1 gap-1">
          {tabs.map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`rounded-md px-2.5 py-1 text-sm ${tab === t ? "bg-muted font-medium" : "text-fg-muted hover:text-fg"}`}>{label}</button>
          ))}
        </div>
        <CollapseButton side="right" onClick={onCollapse} label="panel" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === "selection" && children}
        {tab === "impact" && (!impact ? <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div> : (
          <div>
            <p className="border-b border-line px-5 py-3 text-xs text-fg-subtle">FlowMap builds the design on a copy of your code graph and runs the rules on it. Code-level checks (N+1, input validation…) run on the real code: <code>flowmap check --design {slug}</code>.</p>
            <Fold title="Would introduce" count={impact.introduced.length}>
              {impact.introduced.length ? impact.introduced.map((i) => <IssueRow key={i.id} issue={i} compact />) : <p className="flex items-center gap-2 px-5 text-sm text-fg-muted"><CircleCheck className="size-4 text-success" aria-hidden /> No new issues</p>}
            </Fold>
            {impact.resolved.length > 0 && (
              <Fold title="Would resolve" count={impact.resolved.length}>
                {impact.resolved.map((i) => <p key={i.id} className="px-5 text-sm text-fg-muted"><span className="text-success">✓</span> {i.ruleTitle}: {i.message}</p>)}
              </Fold>
            )}
            {impact.tables.length > 0 && (
              <Fold title="Tables touched" count={impact.tables.length}>
                {impact.tables.map((t) => (
                  <div key={t.id} className="px-5">
                    <p className="text-sm font-medium">{t.name} <span className="font-normal text-fg-subtle">· {t.readers.length} readers · {t.writers.length} writers</span></p>
                    <RefList refs={t.writers} empty="No other writers" />
                  </div>
                ))}
              </Fold>
            )}
            {impact.dependents.length > 0 && (
              <Fold title="Depends on what you change" count={impact.dependents.length}>
                {impact.dependents.map((x) => <div key={x.id} className="px-5"><p className="text-sm font-medium">{x.name}</p><RefList refs={x.refs} empty="" /></div>)}
              </Fold>
            )}
            {(view?.stale.length ?? 0) > 0 && (
              <Fold title="No longer in the code" count={view!.stale.length}>
                {view!.stale.map((id) => (
                  <p key={id} className="flex items-center gap-2 px-5 font-mono text-xs text-fg-muted">{id}
                    <button type="button" onClick={() => update((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.src !== id && e.dst !== id) }))}
                      aria-label={`Remove ${id} from the design`} className="rounded p-0.5 hover:bg-muted"><Trash2 className="size-3.5" aria-hidden /></button>
                  </p>
                ))}
              </Fold>
            )}
          </div>
        ))}
        {tab === "doc" && <Doc slug={slug} draft={draft} update={update} onSend={onSend} claudeBusy={claudeBusy} flush={flush} />}
      </div>
    </aside>
  );
}

const STATUSES: [NonNullable<Design["status"]>, string][] = [["draft", "Draft"], ["review", "In review"], ["approved", "Approved"], ["rejected", "Rejected"]];

/** The exported document as a reviewer will read it, with the diagram as the picture it will be. */
function Preview({ slug, flush, rev }: { slug: string; flush: () => Promise<void>; rev: number }) {
  const [doc, setDoc] = useState<{ before: string; after: string; image: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    flush().then(async () => {
      const [text, view] = await Promise.all([getText(`/api/designs/${enc(slug)}/export?format=md`), get<DesignView>(`/api/designs/${enc(slug)}`)]);
      const [before, after = ""] = text.split(DIAGRAM_MARKER);
      return { before, after, image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent((await diagramSvg(view)).svg)}` };
    }).then((d) => { if (live) { setDoc(d); setError(undefined); } }, (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [slug, rev]);                                        // eslint-disable-line react-hooks/exhaustive-deps -- `flush` only saves what is unsaved
  if (error) return <p className="p-5 text-sm text-error">Couldn't build the preview: {error}</p>;
  if (!doc) return <div className="space-y-3 p-5">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>;
  return (
    <div className="space-y-3 p-5">
      <Markdown text={doc.before} doc />
      <img src={doc.image} alt="What changes: the diagram" className="w-full rounded-md border border-line bg-white" />
      <Markdown text={doc.after} doc />
      <p className="border-t border-line pt-3 text-xs text-fg-subtle">This is what <b>Export → Copy RFC</b> gives you. Use <b>Copy diagram image</b> and paste the picture where the RFC says so.</p>
    </div>
  );
}

function Doc({ slug, draft, update, onSend, claudeBusy, flush }: { slug: string; draft: Design; update: Update; onSend: (text: string) => void; claudeBusy: boolean; flush: () => Promise<void> }) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const decisions = (fn: (list: Design["decisions"]) => Design["decisions"], key = "decision") => update((d) => ({ ...d, decisions: fn(d.decisions) }), key);
  const tabBtn = (m: "edit" | "preview", label: string) => (
    <button type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`rounded-md px-2.5 py-1 ${mode === m ? "bg-bg font-medium shadow-sm" : "text-fg-muted hover:text-fg"}`}>{label}</button>
  );
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
        <div role="group" aria-label="RFC" className="inline-flex rounded-lg bg-muted p-0.5 text-sm">{tabBtn("edit", "Write")}{tabBtn("preview", "Preview")}</div>
        <select value={draft.status ?? "draft"} onChange={(e) => update((d) => ({ ...d, status: e.target.value as Design["status"] }))} aria-label="Status" className={`${input} ml-auto py-1`}>
          {STATUSES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>
      {mode === "preview" ? <Preview slug={slug} flush={flush} rev={draft.version} /> : (
        <div className="space-y-6 p-5">
          <Field label="TL;DR" hint="Two or three lines: what changes, why, the impact, and what you need from reviewers. Numbers, not adjectives.">
            <textarea value={draft.summary} onChange={(e) => update((d) => ({ ...d, summary: e.target.value }), "summary")} rows={3} maxLength={600} className={`${input} w-full`} placeholder="e.g. Link each credit debit to its job with a real foreign key, so duplicate callbacks can't double-charge. Touches 2 tables; no API changes. Need a yes on the NOT VALID rollout." />
            <span className={`block text-right text-xs ${draft.summary.length > 400 ? "text-warn" : "text-fg-subtle"}`}>{draft.summary.length}/600{draft.summary.length > 400 ? " · keep it short" : ""}</span>
          </Field>

          <div className="space-y-2">
            <p className="text-xs font-medium text-fg-muted">Decisions <span className="font-normal text-fg-subtle">· shown as a table in the RFC</span></p>
            {draft.decisions.map((x, i) => (
              <div key={i} className="space-y-1 rounded-md border border-line p-2">
                <div className="flex gap-2">
                  <input value={x.question} onChange={(e) => decisions((l) => l.map((y, j) => (j === i ? { ...y, question: e.target.value } : y)), `q${i}`)} placeholder="Decision" aria-label="Decision" className={`${input} min-w-0 flex-1`} />
                  <button type="button" onClick={() => decisions((l) => l.filter((_, j) => j !== i))} aria-label="Remove decision" className="rounded-md p-1 text-fg-muted hover:bg-muted"><Trash2 className="size-4" aria-hidden /></button>
                </div>
                <textarea value={x.answer} onChange={(e) => decisions((l) => l.map((y, j) => (j === i ? { ...y, answer: e.target.value } : y)), `a${i}`)} rows={2} placeholder="What we chose, and why" aria-label="Choice" className={`${input} w-full`} />
              </div>
            ))}
            <button type="button" onClick={() => decisions((l) => [...l, { question: "", answer: "" }])} className={btn}><Plus className="size-4" aria-hidden /> Add decision</button>
          </div>

          <Field label={`The reasoning${draft.rfcBy ? ` · last edited by ${draft.rfcBy === "claude" ? "Claude" : "you"}` : ""}`}>
            {!draft.rfc.trim() && (
              <button type="button" onClick={() => update((d) => ({ ...d, rfc: RFC_TEMPLATE }), "rfc")} className={`${btn} mb-2`}><FileText className="size-4" aria-hidden /> Start from the template</button>
            )}
            <textarea value={draft.rfc} onChange={(e) => update((d) => ({ ...d, rfc: e.target.value }), "rfc")} maxLength={100000} spellCheck
              placeholder={"## Problem\n## Goals and non-goals\n## Proposal\n## Alternatives considered\n## Risks and impact\n## Rollout"}
              className={`${input} min-h-72 w-full font-mono text-xs leading-relaxed`} />
            <span className="block text-xs text-fg-subtle">Write only the reasoning. FlowMap adds the At a glance numbers, the diagram, What changes, Decisions and Impact when you export: leave those out.</span>
          </Field>

          <button type="button" disabled={claudeBusy} onClick={() => onSend(draft.rfc.trim() ? "Update the RFC to match the current design. Keep my edits. Use the TL;DR field for the summary and don't write the sections FlowMap adds itself." : "Write the TL;DR and the RFC text for this design, in the template sections only.")} className={btn}>
            <Bot className="size-4" aria-hidden /> {draft.rfc.trim() ? "Ask Claude to update the RFC" : "Ask Claude to write the RFC"}
          </button>
        </div>
      )}
    </div>
  );
}
