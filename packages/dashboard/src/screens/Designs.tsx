import { DraftingCompass, FileUp, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { post, useApi } from "../api";
import { Empty, ErrorState, PageHeader, Pill, SkeletonList, card, input } from "../components/ui";
import { useApp } from "../context";
import type { Design, DesignSummary } from "../types";
import { ClaudeSetup } from "./design/ClaudeSetup";
import { ago, btn, primary, slugify } from "./design/shared";

export { DesignEditor } from "./design/Editor";

const EMPTY: Omit<Design, "title"> = { version: 0, summary: "", rfc: "", nodes: [], edges: [], notes: [], decisions: [], updatedAt: "" };

// ---------- list ----------

export function Designs() {
  const { data, error, reload } = useApi<DesignSummary[]>("/api/designs");
  const { notify } = useApp();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const base = slugify(title);
    for (let i = 1; i < 50; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      try {
        await post(`/api/designs/${slug}`, { ...EMPTY, title: title.trim() });
        location.hash = `#/designs/${slug}`;
        return;
      } catch (err: any) {
        if (err.status !== 409) { notify(`Couldn't create: ${err.message}`, true); break; }
      }
    }
    setBusy(false);
  };

  const remove = async (slug: string) => {
    try {
      await post(`/api/designs/${slug}/delete`, { confirm: true });
      setConfirming(null);
      notify("Design deleted");
      reload();
    } catch (err: any) {
      notify(`Couldn't delete: ${err.message}`, true);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const { slug } = await post<{ slug: string }>("/api/designs", JSON.parse(await file.text()));
      location.hash = `#/designs/${slug}`;
    } catch (err: any) {
      notify(`Couldn't import: ${err.message}`, true);
    }
  };

  return (
    <>
      <PageHeader title="Designs" description="Plan a feature on top of your real code before building it: talk it through with Claude, draw it, see what it would affect, and write the RFC.">
        <label className={`${btn} cursor-pointer`}>
          <FileUp className="size-4" aria-hidden /> Import
          <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => importFile(e.target.files?.[0])} />
        </label>
      </PageHeader>

      <form onSubmit={create} className={`${card} mb-6 flex flex-wrap items-center gap-3 p-4`}>
        <DraftingCompass className="size-5 text-accent" aria-hidden />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New design: what's the feature? (e.g. Let admins archive users)"
          aria-label="Design title" maxLength={200} className={`${input} min-w-0 flex-1`} />
        <button type="submit" disabled={busy || !title.trim()} className={primary}><Plus className="size-4" aria-hidden /> Create</button>
      </form>

      <ClaudeSetup />

      {error && !data ? <ErrorState error={error} onRetry={reload} />
        : !data ? <SkeletonList rows={3} />
        : !data.length ? (
          <Empty icon={DraftingCompass} title="No designs yet">
            Create one above. Designs are saved locally in <code>.flowmap/designs</code> (never committed); share them with Export / Import, or publish the RFC to Notion or Linear.
          </Empty>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((d) => (
              <li key={d.slug} className="relative">
                <a href={`#/designs/${d.slug}`} className={`${card} flex h-full flex-col gap-2 p-4 hover:border-accent`}>
                  <span className="pr-16 font-medium">{d.title}</span>
                  {d.summary && <span className="line-clamp-2 text-sm text-fg-muted">{d.summary}</span>}
                  <span className="mt-auto flex items-center gap-2 pt-1 text-xs text-fg-subtle">
                    {ago(d.updatedAt)}
                    {d.pending > 0 && <Pill tone="accent">{d.pending} from Claude to review</Pill>}
                  </span>
                </a>
                <span className="absolute top-2.5 right-2.5 flex items-center gap-1">
                  {confirming === d.slug ? (
                    <>
                      <button type="button" onClick={() => remove(d.slug)} className="rounded-md bg-error-soft px-2 py-1 text-xs font-medium text-error">Delete for good?</button>
                      <button type="button" onClick={() => setConfirming(null)} aria-label="Keep it" className="rounded-md p-1 text-fg-muted hover:bg-muted"><X className="size-3.5" aria-hidden /></button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirming(d.slug)} aria-label={`Delete “${d.title}”`} title="Delete this design from your computer" className="rounded-md p-1.5 text-fg-subtle hover:bg-muted hover:text-error"><Trash2 className="size-4" aria-hidden /></button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}
