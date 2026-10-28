import { CircleCheck, Crosshair, ShieldAlert, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { enc, useApi } from "../api";
import type { ExplainCard } from "../types";
import { IssueRow } from "./IssueRow";
import { KIND, KindIcon } from "./kind";
import { EditorLink, RefList } from "./refs";
import { ErrorState, Pill, Skeleton } from "./ui";

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        {title}
        {count !== undefined && <span className="rounded bg-muted px-1.5 font-mono text-fg-muted">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const none = (text: string) => <p className="text-sm text-fg-subtle">{text}</p>;

/** `embedded`: just the sections (the caller shows the header and does the scrolling), e.g. inside the design panel. */
export function DetailPanel({ id, isRoot, onClose, onFocus, embedded = false }: { id: string; isRoot: boolean; onClose: () => void; onFocus: () => void; embedded?: boolean }) {
  const { data: c, error, reload } = useApi<ExplainCard>(`/api/explain/${enc(id)}`);

  return (
    <aside aria-label="Node details" className={embedded ? "" : "flex h-full w-full flex-col overflow-hidden border-l border-line bg-bg md:w-md"}>
      {!embedded && <div className="flex items-start gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          {c ? (
            <>
              <p className="flex items-center gap-1.5 text-xs text-fg-muted">
                <KindIcon kind={c.node.kind} className="size-3.5" />
                {[KIND[c.node.kind].label, c.node.attrs.opType as string | undefined, c.node.repo].filter(Boolean).join(" · ")}
              </p>
              <h2 className="mt-1 break-words text-base font-semibold">{c.node.name}</h2>
              <EditorLink repo={c.node.repo} file={c.node.file} line={c.node.line} className="mt-1" />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.node.transactional && <Pill tone="tx">TX · opens transaction</Pill>}
                {c.node.inTx && <Pill tone="tx">TX · runs inside transaction</Pill>}
              </div>
            </>
          ) : !error && <div className="space-y-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-5 w-56" /></div>}
        </div>
        {!isRoot && (
          <button type="button" onClick={onFocus} title="Center the graph on this node" className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-muted">
            <Crosshair className="size-3.5" aria-hidden /> Focus
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close details (Esc)" className="rounded-md p-1 text-fg-muted hover:bg-muted">
          <X className="size-4" aria-hidden />
        </button>
      </div>}

      <div className={embedded ? "" : "flex-1 overflow-y-auto"}>
        {error && <div className="p-5"><ErrorState error={error} onRetry={reload} /></div>}
        {!c && !error && <div className="space-y-3 p-5">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>}
        {c && (
          <>
            <Section title="Issues" count={c.issues.length}>
              {c.issues.length
                ? <div className="-mx-5">{c.issues.map((i) => <IssueRow key={i.id} issue={i} compact />)}</div>
                : <p className="flex items-center gap-2 text-sm text-success"><CircleCheck className="size-4" aria-hidden /> No issues on this path</p>}
            </Section>

            <Section title="Used by screens" count={c.screens.length}>
              <RefList refs={c.screens} empty="No screen reaches this node (job, webhook, or unused)." />
            </Section>

            <Section title="Guards & permissions">
              {c.hasActor === false && !c.permissions.length && (
                <div role="note" className="mb-3 flex gap-2 rounded-md border border-error/30 bg-error-soft p-3 text-sm">
                  <ShieldAlert className="size-4 shrink-0 text-error" aria-hidden />
                  <div>
                    <p className="font-medium text-error">No caller check</p>
                    <p className="mt-0.5 text-fg-muted">The handler never reads the current user, so it can't verify the caller is allowed to touch this data.</p>
                  </div>
                </div>
              )}
              {c.guards.length || c.permissions.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {c.guards.map((g) => <Pill key={g}>{g}</Pill>)}
                  {c.permissions.map((p) => <Pill key={p} tone="accent">{p}</Pill>)}
                </div>
              ) : none("No guards or permissions on this path.")}
            </Section>

            <Section title="Input" count={c.input.length}>
              {c.schema && (
                <p className="mb-2 font-mono text-xs text-fg-muted">({c.schema.args}) → {c.schema.returns}</p>
              )}
              {c.input.length ? (
                <ul className="space-y-1">
                  {c.input.map((f) => (
                    <li key={f.name} className="flex items-center gap-2 text-sm">
                      <span className="font-mono">{f.name}</span>
                      <span className="font-mono text-xs text-fg-subtle">{f.type}</span>
                      {f.validated
                        ? <span className="ml-auto inline-flex items-center gap-1 text-xs text-success"><CircleCheck className="size-3.5" aria-hidden />validated</span>
                        : <span className="ml-auto inline-flex items-center gap-1 text-xs text-warn"><TriangleAlert className="size-3.5" aria-hidden />not validated</span>}
                    </li>
                  ))}
                </ul>
              ) : none("No input arguments.")}
            </Section>

            <Section title="Writes tables" count={c.writes.length}>
              <RefList refs={c.writes} empty="Writes no tables." />
            </Section>
            <Section title="Reads tables" count={c.reads.length}>
              <RefList refs={c.reads} empty="Reads no tables." />
            </Section>

            <Section title="External calls" count={c.externals.length}>
              {c.externals.length ? (
                <ul className="space-y-2">
                  {c.externals.map((x, i) => (
                    <li key={`${x.id}-${i}`} className="text-sm">
                      <div className="flex items-center gap-2">
                        <KindIcon kind="External" />
                        <span className="font-medium">{x.name}</span>
                        {x.detail && <span className="font-mono text-xs text-fg-muted">{x.detail}</span>}
                        <span className="ml-auto text-xs text-fg-subtle">{x.write ? "write" : "read"}</span>
                      </div>
                      {x.inTx && (
                        <p className="mt-1 ml-6 inline-flex items-center gap-1 text-xs text-error">
                          <TriangleAlert className="size-3.5" aria-hidden /> Inside a DB transaction
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : none("No external services called.")}
            </Section>

            <Section title="Transaction">
              {c.transaction.opens ? none("Opens a transaction. Everything it calls runs inside it until commit.")
                : c.transaction.inTx ? (
                  <>
                    <p className="mb-2 text-sm text-fg-muted">Runs inside a transaction opened by:</p>
                    <RefList refs={c.transaction.roots} empty="Opened upstream." />
                  </>
                ) : none("Not transactional.")}
            </Section>

            <Section title="Callers" count={c.callers.length}>
              <RefList refs={c.callers} empty="Nothing calls this directly." />
            </Section>
            <Section title="Callees" count={c.callees.length}>
              <RefList refs={c.callees} empty="Calls nothing else." />
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
