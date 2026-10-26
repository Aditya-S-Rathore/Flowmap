import { CircleCheck, OctagonAlert, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useApi } from "../api";
import { useApp } from "../context";
import { IssueRow } from "../components/IssueRow";
import { Empty, ErrorState, PageHeader, SkeletonList, card, input } from "../components/ui";
import type { Issue, IssueSummary, RuleInfo } from "../types";

type Filters = { rule: string; severity: string; status: string; repo: string; q: string };

export function Issues({ params }: { params: URLSearchParams }) {
  const { status } = useApp();
  const [f, setF] = useState<Filters>({
    rule: params.get("rule") ?? "", severity: params.get("severity") ?? "",
    status: params.get("status") ?? "new", repo: params.get("repo") ?? "", q: params.get("q") ?? "",
  });
  const [grouped, setGrouped] = useState(true);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, error, reload } = useApi<{ issues: Issue[]; summary: IssueSummary }>(`/api/issues?${qs}`);
  const { data: rules } = useApi<RuleInfo[]>("/api/rules");

  // Keep showing the previous result while a new filter loads, instead of flashing a skeleton.
  const last = useRef(data);
  if (data) last.current = data;
  const view = data ?? last.current;

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const groups = view ? [...Map.groupBy(view.issues, (i) => i.rule)] : [];

  return (
    <>
      <PageHeader title="Issues" description="Risky patterns found in the indexed code. New issues aren't in the baseline yet.">
        <div role="group" aria-label="Layout" className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
          {([true, false] as const).map((g) => (
            <button key={String(g)} type="button" aria-pressed={grouped === g} onClick={() => setGrouped(g)}
              className={`rounded-md px-2.5 py-1 ${grouped === g ? "bg-bg font-medium shadow-sm" : "text-fg-muted"}`}>
              {g ? "By rule" : "Flat"}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="mb-4 flex flex-wrap gap-2">
        <input type="search" value={f.q} onChange={set("q")} placeholder="Filter by text, file or symbol…" aria-label="Filter by text" className={`${input} min-w-56 flex-1`} />
        <select value={f.rule} onChange={set("rule")} aria-label="Rule" className={input}>
          <option value="">All rules</option>
          {rules?.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
        <select value={f.severity} onChange={set("severity")} aria-label="Severity" className={input}>
          <option value="">All severities</option><option value="error">Errors</option><option value="warn">Warnings</option>
        </select>
        <select value={f.status} onChange={set("status")} aria-label="Status" className={input}>
          <option value="">New + baseline</option><option value="new">New only</option><option value="baseline">Baseline only</option>
        </select>
        <select value={f.repo} onChange={set("repo")} aria-label="Repository" className={input}>
          <option value="">All repos</option>
          {status?.repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
        </select>
      </div>

      {view && (
        <p className="mb-3 flex gap-4 text-sm text-fg-muted" aria-live="polite">
          <span>{view.summary.total} issues</span>
          <span className="inline-flex items-center gap-1"><OctagonAlert className="size-4 text-error" aria-hidden />{view.summary.bySeverity.error} errors</span>
          <span className="inline-flex items-center gap-1"><TriangleAlert className="size-4 text-warn" aria-hidden />{view.summary.bySeverity.warn} warnings</span>
        </p>
      )}

      {error && !view ? <ErrorState error={error} onRetry={reload} />
        : !view ? <SkeletonList />
        : !view.issues.length ? (
          <Empty icon={CircleCheck} title={f.status === "new" ? "No new issues" : "No issues match these filters"}>
            {f.status === "new" ? "Everything flagged is already in the baseline." : "Try clearing a filter."}
            <button type="button" onClick={() => setF({ rule: "", severity: "", status: "", repo: "", q: "" })} className="mt-3 block w-full text-accent hover:underline">
              Clear filters and show all
            </button>
          </Empty>
        ) : (
          <div className={`space-y-4 ${data ? "" : "opacity-60"}`}>
            {grouped ? groups.map(([rule, list]) => (
              <section key={rule} className={`${card} overflow-hidden`}>
                <h2 className="flex items-center gap-2 border-b border-line bg-subtle px-4 py-2.5 text-sm font-semibold">
                  {list[0].ruleTitle}
                  <span className="rounded bg-muted px-1.5 font-mono text-xs font-normal text-fg-muted">{list.length}</span>
                </h2>
                {list.map((i) => <IssueRow key={i.id} issue={i} />)}
              </section>
            )) : (
              <div className={card}>{view.issues.map((i) => <IssueRow key={i.id} issue={i} />)}</div>
            )}
          </div>
        )}
    </>
  );
}
