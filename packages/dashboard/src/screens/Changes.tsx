import { GitBranch, GitCompare } from "lucide-react";
import { useState } from "react";
import { enc, useApi } from "../api";
import { IssueRow } from "../components/IssueRow";
import { KindIcon } from "../components/kind";
import { RefList } from "../components/refs";
import { Empty, ErrorState, PageHeader, SkeletonList, card, input } from "../components/ui";
import type { ChangeSet, NodeKind } from "../types";

export function Changes() {
  const [draft, setDraft] = useState("origin/main");
  const [base, setBase] = useState("origin/main");
  const { data, error, reload } = useApi<ChangeSet>(`/api/changes?base=${enc(base)}`);
  const noChanges = data && data.repos.every((r) => !r.files.length && !r.error);

  const affected: [string, NodeKind, keyof ChangeSet["affected"]][] = [
    ["APIs", "Operation", "operations"], ["Screens", "Route", "screens"], ["Tables", "Table", "tables"], ["Externals", "External", "externals"],
  ];

  return (
    <>
      <PageHeader title="Changes" description="What your branch touches compared to a base ref — and what that reaches.">
        <form onSubmit={(e) => { e.preventDefault(); setBase(draft.trim() || "origin/main"); }} className="flex gap-2">
          <label className="sr-only" htmlFor="base-ref">Base ref</label>
          <input id="base-ref" value={draft} onChange={(e) => setDraft(e.target.value)} className={`${input} font-mono`} placeholder="origin/main" />
          <button type="submit" className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-muted">Compare</button>
        </form>
      </PageHeader>

      {error && !data ? <ErrorState error={error} onRetry={reload} />
        : !data ? <SkeletonList rows={4} />
        : noChanges ? (
          <Empty icon={GitCompare} title={`No changes vs ${data.base}`}>
            Your working tree matches the base ref. Commit or edit files, or compare against a different base.
          </Empty>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              {data.repos.map((r) => (
                <section key={r.name} className={card}>
                  <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
                    {r.name}
                    {r.branch && <span className="inline-flex items-center gap-1 font-mono text-xs font-normal text-fg-muted"><GitBranch className="size-3.5" aria-hidden />{r.branch}</span>}
                    <span className="ml-auto text-xs font-normal text-fg-subtle">{r.files.length} files vs {r.base}</span>
                  </h2>
                  {r.error ? <p className="px-4 py-3 text-sm text-error">{r.error}</p>
                    : r.files.length ? (
                      <ul className="px-4 py-2">
                        {r.files.map((f) => <li key={f} className="truncate py-0.5 font-mono text-xs text-fg-muted" title={f}>{f}</li>)}
                      </ul>
                    ) : <p className="px-4 py-3 text-sm text-fg-subtle">No changes in this repo.</p>}
                </section>
              ))}
            </div>

            <section>
              <h2 className="mb-3 text-sm font-semibold">Affected</h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {affected.map(([label, kind, key]) => (
                  <div key={key} className={`${card} p-3`}>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium"><KindIcon kind={kind} />{label}<span className="ml-auto tabular-nums text-fg-muted">{data.affected[key].length}</span></h3>
                    <RefList refs={data.affected[key]} empty={`No ${label.toLowerCase()} affected.`} />
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-semibold">New issues in changed code</h2>
              {data.issues.length
                ? <div className={card}>{data.issues.map((i) => <IssueRow key={i.id} issue={i} />)}</div>
                : <p className="text-sm text-success">No new issues in changed code.</p>}
            </section>
          </div>
        )}
    </>
  );
}
