import { Database, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api";
import { EditorLink, RefList } from "../components/refs";
import { Empty, ErrorState, PageHeader, SkeletonList, card } from "../components/ui";
import type { TableInfo } from "../types";

export function Tables() {
  const { data, error, reload } = useApi<TableInfo[]>("/api/tables");
  const [selectedId, setSelectedId] = useState<string>();
  const t = data?.find((x) => x.id === selectedId) ?? data?.[0];

  return (
    <>
      <PageHeader title="Tables" description="Database tables, who reads and writes them, and their relations." />
      {error && !data ? <ErrorState error={error} onRetry={reload} />
        : !data ? <SkeletonList />
        : !t ? <Empty icon={Database} title="No tables indexed">FlowMap finds tables through ORM entities (e.g. TypeORM @Entity). Check that the backend plugin is enabled.</Empty>
        : (
          <div className="grid gap-6 lg:grid-cols-5">
            <div className={`${card} overflow-hidden lg:col-span-2`}>
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-xs text-fg-subtle">
                  <tr><th className="px-4 py-2 font-medium">Table</th><th className="px-3 py-2 text-right font-medium">Readers</th><th className="px-3 py-2 text-right font-medium">Writers</th><th className="px-3 py-2 text-right font-medium">Relations</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.map((x) => (

                      <tr key={x.id} className={x.id === t.id ? "bg-accent-soft" : "hover:bg-subtle"}>
                        <td className="px-4 py-2">
                          <button type="button" onClick={() => setSelectedId(x.id)} aria-current={x.id === t.id} className="flex items-center gap-1.5 text-left font-mono font-medium hover:text-accent">
                            {x.name}
                            {x.issues.length > 0 && <TriangleAlert className="size-3.5 text-warn" aria-label={`${x.issues.length} issue(s)`} />}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{x.readers.length}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{x.writers.length}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{x.relations.length}</td>
                      </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <section className={`${card} p-5 lg:col-span-3`} aria-label={`Table ${t.name}`}>
              <h2 className="font-mono text-base font-semibold">{t.name}</h2>
              <p className="mt-1 text-sm text-fg-muted">{t.entity ? `Entity ${t.entity}` : "No entity class"}</p>
              <EditorLink repo={t.repo} file={t.file} line={t.line} className="mt-1" />

              {t.issues.length > 0 && (
                <div role="note" className="mt-4 space-y-1 rounded-md border border-warn/40 bg-warn-soft p-3 text-sm">
                  {t.issues.map((i) => (
                    <p key={i.id} className="flex items-center gap-2">
                      <TriangleAlert className="size-4 shrink-0 text-warn" aria-hidden />
                      <span>{i.message}</span>
                    </p>
                  ))}
                  <p className="text-fg-muted">{t.issues[0].why}</p>
                </div>
              )}

              <div className="mt-5 grid gap-6 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Writers ({t.writers.length})</h3>
                  <RefList refs={t.writers} empty="Nothing writes this table." />
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Readers ({t.readers.length})</h3>
                  <RefList refs={t.readers} empty="Nothing reads this table." />
                </div>
              </div>

              <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Relations ({t.relations.length})</h3>
              {t.relations.length ? (
                <ul className="space-y-1 text-sm">
                  {t.relations.map((r) => (
                    <li key={r.column} className="flex items-center gap-2 font-mono text-xs">
                      {r.column} → {r.to}
                      <span className={`ml-auto font-sans ${r.indexed === false ? "text-warn" : "text-fg-subtle"}`}>{r.indexed ? "indexed" : r.indexed === null ? "can't tell" : "not indexed"}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-fg-subtle">No foreign keys.</p>}
            </section>
          </div>
        )}
    </>
  );
}
