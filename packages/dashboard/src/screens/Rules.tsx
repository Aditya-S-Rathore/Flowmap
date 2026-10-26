import { useApi } from "../api";
import { ErrorState, PageHeader, Pill, SeverityBadge, SkeletonList, card } from "../components/ui";
import type { RuleInfo } from "../types";

export function Rules() {
  const { data, error, reload } = useApi<RuleInfo[]>("/api/rules");
  return (
    <>
      <PageHeader title="Rules" description="What each rule checks, why it matters and how to fix it. Change a rule's severity or turn it off under rules in flowmap.config.mjs." />
      {error && !data ? <ErrorState error={error} onRetry={reload} />
        : !data ? <SkeletonList />
        : (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.map((r) => (
              <section key={r.id} className={`${card} flex flex-col gap-3 p-4`}>
                <div className="flex flex-wrap items-center gap-2">
                  {r.severity === "off" ? <Pill>Off</Pill> : <SeverityBadge severity={r.severity} />}
                  <h2 className="text-sm font-semibold">{r.title}</h2>
                  <code className="ml-auto font-mono text-xs text-fg-subtle">{r.id}</code>
                </div>
                <p className="text-sm text-fg-muted">{r.description}</p>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Why it matters</h3>
                  <p className="mt-1 text-sm">{r.why}</p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">How to fix</h3>
                  <p className="mt-1 text-sm">{r.fix}</p>
                </div>
                <p className="mt-auto text-sm text-fg-muted">
                  {r.count
                    ? <a href={`#/issues?rule=${r.id}&status=`} className="text-accent hover:underline">{r.count} issues · {r.new} new</a>
                    : "No issues"}
                </p>
              </section>
            ))}
          </div>
        )}
    </>
  );
}
