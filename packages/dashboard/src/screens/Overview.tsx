import { Check, Copy, Lightbulb, OctagonAlert, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { enc, useApi } from "../api";
import { KindIcon } from "../components/kind";
import { EditorLink, exploreHref } from "../components/refs";
import { ErrorState, PageHeader, Skeleton, card } from "../components/ui";
import type { NodeKind, Overview as OverviewData, Suggestion } from "../types";

function Tile({ label, kind, value, sub, href }: { label: string; kind?: NodeKind; value: ReactNode; sub?: string; href: string }) {
  return (
    <a href={href} className={`${card} block p-4 hover:border-line-strong`}>
      <p className="flex items-center gap-1.5 text-sm text-fg-muted">{kind && <KindIcon kind={kind} />}{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
    </a>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={card}>
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => {})}
      aria-label="Copy config line" className="rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg">
      {done ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

/** Config hints: frameworks whose plugin is off, packages that look like outside services, unused entries. */
function Suggestions() {
  const { data } = useApi<Suggestion[]>("/api/suggestions");
  const [all, setAll] = useState(false);
  if (!data?.length) return null;
  const shown = all ? data : data.slice(0, 3);
  return (
    <section className={`${card} mt-6`} aria-label="Setup suggestions">
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
        <Lightbulb className="size-4 text-warn" aria-hidden />Setup suggestions
        <span className="font-normal text-fg-subtle">· make the graph more complete</span>
      </h2>
      <ul className="divide-y divide-line">
        {shown.map((s, i) => (
          <li key={i} className="px-4 py-3">
            <p className="text-sm font-medium">{s.title} <span className="font-normal text-fg-subtle">· {s.repo}</span></p>
            <p className="mt-0.5 text-sm text-fg-muted">{s.detail}</p>
            {s.config && (
              <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{s.config}</code>
                <CopyButton text={s.config} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {data.length > 3 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-line px-4 py-2 text-left text-sm text-accent hover:bg-subtle">
          {all ? "Show fewer" : `Show all ${data.length} suggestions`}
        </button>
      )}
    </section>
  );
}

export function Overview() {
  const { data, error, reload } = useApi<OverviewData>("/api/overview");
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading overview">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
        <div className="grid gap-6 lg:grid-cols-2"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>
      </div>
    );
  }

  const k = data.status.counts.byKind;
  const { issues } = data;
  const max = Math.max(1, ...issues.byRule.map((r) => r.count));

  return (
    <>
      <PageHeader title="Overview" description={`${data.status.workspace} · ${data.status.repos.length} repos · ${data.status.counts.nodes.toLocaleString()} nodes, ${data.status.counts.edges.toLocaleString()} edges`} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Screens" kind="Route" value={k.Route ?? 0} href="#/map?tab=screens" />
        <Tile label="APIs" kind="Operation" value={k.Operation ?? 0} href="#/map?tab=apis" />
        <Tile label="Functions" kind="Function" value={k.Function ?? 0} href="#/explore" />
        <Tile label="Tables" kind="Table" value={k.Table ?? 0} href="#/tables" />
        <Tile label="Externals" kind="External" value={k.External ?? 0} href="#/map?tab=services" />
        <Tile label="Issues" value={<>{issues.new}<span className="text-base font-normal text-fg-subtle"> new / {issues.total}</span></>}
          sub={`${issues.bySeverity.error} errors · ${issues.bySeverity.warn} warnings`} href="#/issues" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Issues by rule">
          {issues.byRule.length ? (
            <ul className="divide-y divide-line">
              {issues.byRule.map((r) => (
                <li key={r.rule}>
                  <a href={`#/issues?rule=${enc(r.rule)}&status=`} className="block px-4 py-3 hover:bg-subtle">
                    <div className="flex items-center gap-2 text-sm">
                      {r.severity === "error"
                        ? <OctagonAlert className="size-4 text-error" aria-label="Error" />
                        : <TriangleAlert className="size-4 text-warn" aria-label="Warning" />}
                      <span className="truncate font-medium">{r.title}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-fg-muted">
                        {r.new > 0 && <span className="mr-2 text-accent">{r.new} new</span>}{r.count}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted" aria-hidden>
                      <div className={`h-full rounded-full ${r.severity === "error" ? "bg-error" : "bg-warn"}`} style={{ width: `${(r.count / max) * 100}%` }} />
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-8 text-center text-sm text-fg-muted">No issues found. Nice.</p>}
        </Panel>

        <div className="space-y-6">
          <Panel title="Hotspots">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-fg-subtle">
                <tr><th className="px-4 py-2 font-medium">File</th><th className="w-20 px-4 py-2 text-right font-medium">Issues</th><th className="w-20 px-4 py-2 text-right font-medium">Errors</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.hotspots.map((h) => (
                  <tr key={`${h.repo}/${h.file}`} className="hover:bg-subtle">
                    <td className="max-w-0 px-4 py-2">
                      <a href={`#/issues?q=${enc(h.file)}&status=`} className="block truncate font-mono text-xs hover:text-accent" title={`${h.repo}/${h.file}`}>{h.repo}/{h.file}</a>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{h.issues}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${h.errors ? "font-medium text-error" : "text-fg-subtle"}`}>{h.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.hotspots.length && <p className="px-4 py-6 text-center text-sm text-fg-muted">No files with issues.</p>}
          </Panel>

          <Panel title="Largest functions">
            <ul className="divide-y divide-line">
              {data.largestFunctions.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-2 hover:bg-subtle">
                  <div className="min-w-0 flex-1">
                    <a href={exploreHref(f.id)} className="block truncate text-sm font-medium hover:text-accent">{f.name}</a>
                    <EditorLink repo={f.repo} file={f.file} line={f.line} />
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-fg-muted">{f.loc} lines</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      <Suggestions />
    </>
  );
}
