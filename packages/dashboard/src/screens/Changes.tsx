import { Copy, GitBranch, GitCompare } from "lucide-react";
import { useEffect, useState } from "react";
import { enc, useApi } from "../api";
import { IssueRow } from "../components/IssueRow";
import { KindIcon } from "../components/kind";
import { EditorLink, RefList } from "../components/refs";
import { Empty, ErrorState, PageHeader, SkeletonList, card, input } from "../components/ui";
import { useApp } from "../context";
import { ChangeGraph, DiffView, StatusPill } from "./ChangeGraph";
import type { ChangeSet, NodeKind } from "../types";

/** The review as text to paste in a PR or a chat: what changed, what it reaches, what is new. */
function review(d: ChangeSet, head: string) {
  const list = (title: string, refs: { name: string; file?: string; line?: number; change?: string }[]) => (refs.length ? `\n### ${title}\n${refs.map((r) => `- ${r.change ? `${r.change}: ` : ""}\`${r.name}\`${r.file ? ` (${r.file}${r.line ? `:${r.line}` : ""})` : ""}`).join("\n")}\n` : "");
  return `## Changes: ${head || "working folder"} vs ${d.base}\n${list("Changed code", d.changed)}${list("Screens affected", d.affected.screens)}${list("APIs affected", d.affected.operations)}${list("Tables touched", d.affected.tables)}${list("Outside services", d.affected.externals)}${d.migrations.length ? `\n### Migrations\n${d.migrations.map((m) => `- ${m}`).join("\n")}\n` : ""}${d.flags.length ? `\n### Behind feature flags\n- ${d.flags.join(", ")}\n` : ""}${d.issues.length ? `\n### New issues\n${d.issues.map((i) => `- **${i.severity}** ${i.ruleTitle}: ${i.message} (${i.file}:${i.line})`).join("\n")}\n` : "\nNo new issues in changed code.\n"}`;
}

export function Changes({ params }: { params: URLSearchParams }) {
  const { notify } = useApp();
  const { data: info } = useApi<{ branches: string[]; current: string | null; base: string }>("/api/branches");
  const [draft, setDraft] = useState<{ base: string; head: string } | null>(null);    // what is typed
  const [ref, setRef] = useState<{ base: string; head: string } | null>(null);        // what is compared
  // start from the link if it names branches (the agent opens it that way), else from the branch that is checked out
  // against the repo's base (`base` in the config, else its main branch)
  useEffect(() => {
    if (info && !ref) {
      const start = { base: params.get("base") || info.base || "origin/main", head: params.get("head") ?? info.current ?? "" };
      setDraft(start);
      setRef(start);
    }
  }, [info, ref, params]);
  const { data, error, reload } = useApi<ChangeSet>(ref ? `/api/changes?base=${enc(ref.base)}${ref.head ? `&head=${enc(ref.head)}` : ""}` : null);
  const noChanges = data && data.repos.every((r) => !r.files.length && !r.error);

  const affected: [string, NodeKind, keyof ChangeSet["affected"]][] = [
    ["APIs", "Operation", "operations"], ["Screens", "Route", "screens"], ["Tables", "Table", "tables"], ["Externals", "External", "externals"],
  ];

  return (
    <>
      <PageHeader title="Changes" description="What a branch touches compared to a base, and what that reaches. Pick any two branches: nothing is checked out, and the branch you are on is read as it is now (uncommitted edits included).">
        {draft && (
          <form onSubmit={(e) => { e.preventDefault(); setRef({ base: draft.base.trim() || info?.base || "origin/main", head: draft.head.trim() }); }} className="flex flex-wrap items-end gap-2">
            <datalist id="branches">{info?.branches.map((b) => <option key={b} value={b} />)}</datalist>
            <label className="text-xs text-fg-muted">Base <span className="text-fg-subtle">(compare against)</span>
              <input id="base-ref" list="branches" value={draft.base} onChange={(e) => setDraft({ ...draft, base: e.target.value })} className={`${input} mt-1 block w-48 font-mono`} placeholder={info?.base || "origin/main"} />
            </label>
            <label className="text-xs text-fg-muted">Branch <span className="text-fg-subtle">(to review)</span>
              <input id="head-ref" list="branches" value={draft.head} onChange={(e) => setDraft({ ...draft, head: e.target.value })} className={`${input} mt-1 block w-48 font-mono`} placeholder={info?.current ?? "your working folder"} />
            </label>
            <button type="submit" className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-muted">Compare</button>
            {data && <button type="button" onClick={() => navigator.clipboard.writeText(review(data, ref?.head ?? "")).then(() => notify("Review copied"), () => notify("Couldn't copy", true))} className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-muted"><Copy className="size-4" aria-hidden />Copy review</button>}
          </form>
        )}
      </PageHeader>
      {ref && <p className="mb-4 text-sm text-fg-muted">Reviewing <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-accent">{ref.head || "your working folder"}</span> against <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{ref.base}</span></p>}

      {error && !data ? <ErrorState error={error} onRetry={reload} />
        : !data ? <SkeletonList rows={4} />
        : noChanges ? (
          <Empty icon={GitCompare} title={`No changes vs ${data.base}`}>
            Your working tree matches the base ref. Commit or edit files, or compare against a different base.
          </Empty>
        ) : (
          <div className="space-y-6">
            {data.graph.nodes.length > 0 && (
              <section>
                <ChangeGraph graph={data.graph} diffs={data.diffs} />
              </section>
            )}

            {(data.migrations.length > 0 || data.flags.length > 0) && (
              <section className={`${card} space-y-2 p-4 text-sm`}>
                <h2 className="font-semibold">Before you release</h2>
                {data.migrations.length > 0 && <p><span className="font-medium">Migrations ({data.migrations.length}):</span> <span className="font-mono text-xs text-fg-muted">{data.migrations.join(", ")}</span></p>}
                {data.flags.length > 0 && <p><span className="font-medium">Behind feature flags:</span> <span className="font-mono text-xs text-accent">{data.flags.join(", ")}</span> <span className="text-fg-subtle">· with a flag off, this code is not reached</span></p>}
              </section>
            )}

            {data.changed.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold">Changed code <span className="font-normal text-fg-subtle">· open one to see what changed in it</span></h2>
                <ul className={`${card} divide-y divide-line`}>
                  {data.changed.map((r) => (
                    <li key={r.id} className="px-4 py-2">
                      <details>
                        <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                          <StatusPill change={r.change} /><KindIcon kind={r.kind} /><span className="font-medium">{r.name}</span><EditorLink repo={r.repo} file={r.file} line={r.line} />
                        </summary>
                        <div className="mt-2 space-y-2">
                          <DiffView text={data.diffs[r.id]} />
                          <a href={`#/explore/${enc(r.id)}`} className="text-xs font-medium text-accent hover:underline">Open its flow</a>
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              </section>
            )}

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
          </div>
        )}
    </>
  );
}
