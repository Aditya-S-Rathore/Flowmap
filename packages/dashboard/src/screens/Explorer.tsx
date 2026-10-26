import { ArrowLeft, ArrowRight, Command as CommandIcon, Search, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { enc, get, useApi } from "../api";
import { DetailPanel } from "../components/DetailPanel";
import { KindIcon } from "../components/kind";
import { exploreHref } from "../components/refs";
import { Empty, ErrorState, Skeleton } from "../components/ui";
import { FlowGraph } from "../graph/FlowGraph";
import type { SearchHit, Subgraph } from "../types";

type Dir = "down" | "up";

export function Explorer({ id, onSearch }: { id?: string; onSearch: () => void }) {
  const [dir, setDir] = useState<Dir>("down");
  const [sideEffects, setSideEffects] = useState(false);
  if (!id) return <Start onSearch={onSearch} />;

  const seg = (d: Dir, label: string, hint: string, Icon: typeof ArrowRight) => (
    <button type="button" aria-pressed={dir === d} onClick={() => setDir(d)}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${dir === d ? "bg-bg font-medium shadow-sm" : "text-fg-muted hover:text-fg"}`}>
      <Icon className="size-4" aria-hidden />{label}<span className="hidden text-fg-subtle lg:inline">· {hint}</span>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <div role="group" aria-label="Direction" className="inline-flex rounded-lg bg-muted p-0.5">
          {seg("down", "Downstream", "what it does", ArrowRight)}
          {seg("up", "Upstream", "who uses it", ArrowLeft)}
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={sideEffects} onChange={(e) => setSideEffects(e.target.checked)} className="size-4 accent-accent" />
          Side effects only
        </label>
      </div>
      <Canvas key={`${id}|${dir}|${sideEffects}`} id={id} dir={dir} sideEffects={sideEffects} />
    </div>
  );
}

function Canvas({ id, dir, sideEffects }: { id: string; dir: Dir; sideEffects: boolean }) {
  const { data: base, error, reload } = useApi<Subgraph>(`/api/graph/${enc(id)}?dir=${dir}&depth=3&limit=8&sideEffects=${sideEffects ? 1 : 0}`);
  const [extra, setExtra] = useState<Subgraph[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(id);
  const [expandError, setExpandError] = useState<string>();

  const merged = useMemo(() => {
    const nodes = new Map(base?.nodes.map((n) => [n.id, n]));
    const edges = new Map(base?.edges.map((e) => [e.id, e]));
    for (const g of extra) {
      g.nodes.forEach((n) => nodes.set(n.id, n));
      g.edges.forEach((e) => edges.set(e.id, e));
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }, [base, extra]);

  const onExpand = useCallback((nodeId: string) => {
    setExpanded((s) => new Set(s).add(nodeId));
    get<Subgraph>(`/api/graph/${enc(nodeId)}?dir=${dir}&depth=1&sideEffects=${sideEffects ? 1 : 0}`).then(
      (g) => setExtra((x) => [...x, g]),
      (e: Error) => {
        setExpanded((s) => { const n = new Set(s); n.delete(nodeId); return n; });
        setExpandError(e.message);
      },
    );
  }, [dir, sideEffects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[cmdk-dialog]")) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1">
        {error && !base && <div className="p-8"><ErrorState error={error} onRetry={reload} /></div>}
        {!base && !error && (
          <div className="flex h-full items-center justify-center gap-6" aria-busy="true" aria-label="Loading graph">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-64" />)}
          </div>
        )}
        {base && (
          <FlowGraph nodes={merged.nodes} edges={merged.edges} rootId={id} dir={dir} expanded={expanded}
            selected={selected} onSelect={setSelected} onExpand={onExpand} />
        )}
        {base && base.edges.length === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-6 mx-auto w-fit rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg-muted">
            {sideEffects ? "No side effects (writes, external calls, queues) in this direction." : dir === "down" ? "This node doesn't call anything." : "Nothing uses this node."}
          </p>
        )}
        {expandError && (
          <button type="button" onClick={() => setExpandError(undefined)} className="absolute inset-x-0 top-6 mx-auto w-fit rounded-md border border-error/40 bg-error-soft px-3 py-2 text-sm text-error">
            Couldn't expand: {expandError} (dismiss)
          </button>
        )}
      </div>
      {selected && (
        <div className="absolute inset-0 z-10 md:static md:z-auto">
          <DetailPanel id={selected} isRoot={selected === id} onClose={() => setSelected(null)}
            onFocus={() => { location.hash = exploreHref(selected); }} />
        </div>
      )}
    </div>
  );
}

function Start({ onSearch }: { onSearch: () => void }) {
  const { data } = useApi<SearchHit[]>("/api/search?q=&kind=Route,Operation&limit=12");
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <Empty icon={Workflow} title="Pick a starting point">
        Search for a screen, API, function or table to see what it does downstream — or who uses it upstream.
        <div className="mt-4">
          <button type="button" onClick={onSearch} className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90">
            <Search className="size-4" aria-hidden /> Search the graph
            <kbd className="inline-flex items-center rounded bg-bg/20 px-1 text-xs"><CommandIcon className="size-3" aria-hidden />K</kbd>
          </button>
        </div>
      </Empty>
      {data && data.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Entry points</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.map((h) => (
              <li key={h.id}>
                <a href={exploreHref(h.id)} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:border-accent">
                  <KindIcon kind={h.kind} /><span className="truncate font-medium">{h.name}</span>
                  <span className="ml-auto text-xs text-fg-subtle">{h.repo}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
