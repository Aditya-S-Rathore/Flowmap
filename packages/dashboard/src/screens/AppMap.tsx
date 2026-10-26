import { ArrowLeftRight, Cloud, Database, Flag, Link2Off, Lock, Network, Search, ShieldAlert, ShieldCheck, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { enc, useApi } from "../api";
import { ArchGraph } from "../graph/ArchGraph";
import { KindIcon } from "../components/kind";
import { Empty, ErrorState, PageHeader, Pill, SeverityBadge, Skeleton, SkeletonList, card, input } from "../components/ui";
import { outline, OutlineView } from "../components/Outline";
import type { ApiInfo, AppMap as AppMapData, Architecture, Counts, JobInfo, ScreenInfo, Wireframe } from "../types";

type Tab = "services" | "screens" | "apis" | "jobs";

export { mapHref } from "../components/refs";
import { mapHref } from "../components/refs";

function Stat({ icon: Icon, value, label, className = "" }: { icon: LucideIcon; value: number; label: string; className?: string }) {
  if (!value) return null;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} title={`${value} ${label}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden />{value} <span className="text-fg-subtle">{label}</span>
    </span>
  );
}

export function Stats({ c, apis = true }: { c: Counts; apis?: boolean }) {
  const tables = c.writes + c.reads;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      {apis && <Stat icon={ArrowLeftRight} value={c.apis} label={c.apis === 1 ? "API" : "APIs"} className="[&>svg]:text-accent" />}
      {tables > 0 && (
        <span className="inline-flex items-center gap-1" title={`${c.writes} tables written, ${c.reads} read`}>
          <Database className="size-3.5 text-table" aria-hidden />{c.writes ? `${c.writes} written` : ""}{c.writes && c.reads ? " · " : ""}{c.reads ? `${c.reads} read` : ""}
        </span>
      )}
      <Stat icon={Cloud} value={c.externals} label={c.externals === 1 ? "service" : "services"} className="[&>svg]:text-external" />
      {c.issues > 0 && c.maxSeverity && <SeverityBadge severity={c.maxSeverity}>{c.issues}</SeverityBadge>}
      {!c.apis && !tables && !c.externals && !c.issues && <span className="text-fg-subtle">No calls found</span>}
    </div>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-5 flex flex-wrap items-center gap-2">{children}</div>;
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative min-w-56 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className={`${input} w-full pl-8`} />
    </label>
  );
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${on ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-fg-muted hover:bg-muted"}`}>
      {children}
    </button>
  );
}

function GroupSelect({ groups, value, onChange }: { groups: string[]; value: string; onChange: (v: string) => void }) {
  if (groups.length < 2) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Repo or service" className={input}>
      <option value="">All repos</option>
      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
    </select>
  );
}

// ---------- screens ----------

/** Loads once the element scrolls near the viewport (dozens of cards, each with a sketch). */
function useVisible<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible] as const;
}

/** Screenshot if one was captured, else the first lines of the screen's outline. */
function Thumb({ s }: { s: ScreenInfo }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const { data } = useApi<Wireframe>(visible && !s.shot ? `/api/wireframe/${enc(s.id)}?depth=3` : null);
  const rows = useMemo(() => outline(data?.root ?? null, 60).filter((r) => r.kind !== "heading").slice(0, 7), [data]);
  return (
    <div ref={ref} className="relative h-36 overflow-hidden rounded-t-lg border-b border-line bg-subtle" aria-hidden>
      {s.shot
        ? <img src={`/api/shot/${enc(s.id)}`} alt="" loading="lazy" className="w-full object-cover object-top" />
        : data ? (rows.length ? <div className="pointer-events-none px-2 pt-2"><OutlineView rows={rows} compact /></div> : <p className="flex h-full items-center justify-center text-xs text-fg-subtle">No buttons or links found</p>)
        : <Skeleton className="m-4 h-28" />}
      <div className="absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-subtle to-transparent" />
    </div>
  );
}

function ScreenCard({ s }: { s: ScreenInfo }) {
  return (
    <a href={mapHref(s.id)} className={`${card} flex flex-col transition-colors hover:border-accent/50 focus-visible:border-accent`}>
      <Thumb s={s} />
      <div className="flex flex-1 flex-col gap-2.5 p-4">
      <div className="flex items-start gap-2">
        <KindIcon kind="Route" className="mt-0.5 size-4" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-medium" title={s.name}>{s.name}</p>
          <p className="truncate text-xs text-fg-subtle" title={s.component?.name}>{s.component?.name ?? "Component not found"}</p>
        </div>
      </div>
      {(s.auth || s.flag || s.unlinked) && (
        <div className="flex flex-wrap gap-1.5">
          {s.auth && <Pill><Lock className="mr-1 size-3" aria-hidden />Signed in</Pill>}
          {s.flag && <Pill tone="accent"><Flag className="mr-1 size-3" aria-hidden /><span className="max-w-40 truncate">{s.flag}</span></Pill>}
          {s.unlinked && (
            <span title="Nothing in the code links to this screen. It may be opened from an email or external link — or no longer used.">
              <Pill><Link2Off className="mr-1 size-3" aria-hidden />No links in code</Pill>
            </span>
          )}
        </div>
      )}
      <div className="mt-auto border-t border-line pt-2.5"><Stats c={s} /></div>
      </div>
    </a>
  );
}

function Screens({ map, params }: { map: AppMapData; params: URLSearchParams }) {
  const [q, setQ] = useState(params.get("q") ?? "");
  const [group, setGroup] = useState(params.get("group") ?? "");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const [onlyAuth, setOnlyAuth] = useState(false);
  const list = map.screens.filter((s) =>
    (!group || s.group === group) && (!onlyIssues || s.issues > 0) && (!onlyUnlinked || s.unlinked) && (!onlyAuth || s.auth) &&
    (!q || `${s.name} ${s.component?.name ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const byGroup = [...Map.groupBy(list, (s) => s.group)];
  const groups = [...new Set(map.screens.map((s) => s.group))];

  if (!map.screens.length) {
    return (
      <Empty icon={Network} title="No screens found">
        Screens come from your router: React Router, Next.js, Nuxt, SvelteKit, Remix, Vue Router, Angular, TanStack, Expo, React Navigation or Astro.
        Add the matching plugin to the frontend's flowmap.config.mjs. A backend-only workspace starts from its APIs instead.
      </Empty>
    );
  }
  return (
    <>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Filter screens by path or component…" />
        <GroupSelect groups={groups} value={group} onChange={setGroup} />
        <Toggle on={onlyIssues} onChange={setOnlyIssues}>With issues</Toggle>
        {map.screens.some((s) => s.auth) && <Toggle on={onlyAuth} onChange={setOnlyAuth}><Lock className="size-3.5" aria-hidden />Signed in</Toggle>}
        {map.hasNavigation && <Toggle on={onlyUnlinked} onChange={setOnlyUnlinked}><Link2Off className="size-3.5" aria-hidden />No links in code</Toggle>}
      </Toolbar>
      {!list.length ? <Empty icon={Search} title="No screens match these filters" /> : byGroup.map(([g, screens]) => (
        <section key={g} className="mb-8" aria-label={g}>
          {byGroup.length > 1 || groups.length > 1 ? <h2 className="mb-3 text-sm font-semibold">{g} <span className="font-normal text-fg-subtle">· {screens.length} screens</span></h2> : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{screens.map((s) => <ScreenCard key={s.id} s={s} />)}</div>
        </section>
      ))}
    </>
  );
}

// ---------- APIs ----------

function Apis({ map, params }: { map: AppMapData; params: URLSearchParams }) {
  const [q, setQ] = useState(params.get("q") ?? "");
  const [screenId, setScreenId] = useState(params.get("screen") ?? "");
  const screen = map.screens.find((s) => s.id === screenId);
  const onScreen = new Set(screen?.apiIds ?? []);
  const [group, setGroup] = useState(params.get("group") ?? "");
  const [noGuard, setNoGuard] = useState(false);
  const [unused, setUnused] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const groups = [...new Set(map.apis.map((a) => a.group))];
  const list = map.apis.filter((a) =>
    (!screen || onScreen.has(a.id)) && (!group || a.group === group) && (!noGuard || !a.guarded) && (!unused || !a.screens) && (!onlyIssues || a.issues > 0) &&
    (!q || `${a.name} ${a.handler?.name ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  if (!map.apis.length) return <Empty icon={ArrowLeftRight} title="No APIs found">APIs come from backend plugins: NestJS, Express, Fastify, Hono, Koa, Next.js route handlers, FastAPI, Flask, Django.</Empty>;
  return (
    <>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Filter APIs by name or handler…" />
        <GroupSelect groups={groups} value={group} onChange={setGroup} />
        <Toggle on={noGuard} onChange={setNoGuard}><ShieldAlert className="size-3.5" aria-hidden />No guard</Toggle>
        {map.screens.length > 0 && <Toggle on={unused} onChange={setUnused}>Not used by a screen</Toggle>}
        <Toggle on={onlyIssues} onChange={setOnlyIssues}>With issues</Toggle>
        {screen && (
          <button type="button" onClick={() => setScreenId("")} className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent-soft px-2.5 py-1.5 text-sm text-accent">
            Used by <span className="font-mono">{screen.name}</span><X className="size-3.5" aria-label="Clear screen filter" />
          </button>
        )}
      </Toolbar>
      <p className="mb-2 text-sm text-fg-muted" aria-live="polite">{list.length} of {map.apis.length} APIs</p>
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full min-w-3xl text-sm">
          <thead className="border-b border-line text-left text-xs text-fg-subtle">
            <tr>
              <th className="px-4 py-2 font-medium">API</th>
              <th className="px-3 py-2 font-medium">Handler</th>
              <th className="px-3 py-2 font-medium">Auth</th>
              <th className="px-3 py-2 font-medium">Touches</th>
              <th className="px-3 py-2 text-right font-medium">Screens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.slice(0, 400).map((a) => <ApiRow key={a.id} a={a} showScreens={map.screens.length > 0} />)}
          </tbody>
        </table>
        {list.length > 400 && <p className="border-t border-line px-4 py-2 text-xs text-fg-subtle">Showing 400 of {list.length}. Narrow the filter to see more.</p>}
      </div>
    </>
  );
}

function ApiRow({ a, showScreens }: { a: ApiInfo; showScreens: boolean }) {
  return (
    <tr className="hover:bg-subtle">
      <td className="px-4 py-2">
        <a href={mapHref(a.id)} className="flex items-center gap-2 font-mono font-medium hover:text-accent">
          <KindIcon kind="Operation" className="size-3.5" />
          <span className="truncate">{a.name}</span>
        </a>
      </td>
      <td className="max-w-56 truncate px-3 py-2 font-mono text-xs text-fg-muted" title={a.handler?.name}>{a.handler?.name ?? "—"}</td>
      <td className="px-3 py-2">
        {a.guarded
          ? <span className="inline-flex items-center gap-1 text-xs text-success" title={a.guards.join(", ") || "Global guard"}><ShieldCheck className="size-3.5" aria-hidden /><span className="max-w-36 truncate">{a.guards[0] ?? "global"}</span></span>
          : <span className="inline-flex items-center gap-1 text-xs text-warn"><ShieldAlert className="size-3.5" aria-hidden />None</span>}
      </td>
      <td className="px-3 py-2"><Stats c={a} apis={false} /></td>
      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{showScreens ? a.screens || <span className="text-fg-subtle">—</span> : "—"}</td>
    </tr>
  );
}

// ---------- jobs ----------

function Jobs({ map }: { map: AppMapData }) {
  if (!map.jobs.length) return <Empty icon={Network} title="No jobs or queues">Cron jobs (@Cron), queue consumers (BullMQ, Celery) and event handlers show up here.</Empty>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {map.jobs.map((j: JobInfo) => (
        <a key={j.id} href={mapHref(j.id)} className={`${card} flex flex-col gap-2 p-4 hover:border-accent/50`}>
          <div className="flex items-center gap-2">
            <KindIcon kind={j.kind} />
            <span className="truncate font-mono text-sm font-medium" title={j.name}>{j.name}</span>
          </div>
          <p className="truncate text-xs text-fg-subtle">{j.handler?.name ?? "—"} · {j.group}</p>
          <div className="mt-auto border-t border-line pt-2"><Stats c={j} /></div>
        </a>
      ))}
    </div>
  );
}

// ---------- page ----------

export function AppMap({ params }: { params: URLSearchParams }) {
  const { data: map, error, reload } = useApi<AppMapData>("/api/map");
  const { data: arch } = useApi<Architecture>("/api/architecture");
  const defaultTab: Tab = map?.screens.length ? "screens" : (arch?.nodes.filter((n) => n.kind === "service").length ?? 0) > 1 ? "services" : "apis";
  const [picked, setPicked] = useState<Tab | null>((params.get("tab") as Tab) || null);
  const tab = picked ?? defaultTab;
  const counts = useMemo(() => ({
    services: arch?.nodes.filter((n) => n.kind === "service").length ?? 0,
    screens: map?.screens.length ?? 0, apis: map?.apis.length ?? 0, jobs: map?.jobs.length ?? 0,
  }), [map, arch]);
  const tabs: [Tab, string][] = [["services", "Services"], ["screens", "Screens"], ["apis", "APIs"], ["jobs", "Jobs & queues"]];

  return (
    <>
      <PageHeader title="App map" description="Every screen, API and background job, what each one touches, and how the services connect." />
      <div role="tablist" aria-label="App map views" className="mb-5 flex gap-1 border-b border-line">
        {tabs.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setPicked(t); history.replaceState(null, "", `#/map?tab=${t}`); }}
            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${tab === t ? "border-accent font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
            {label}
            <span className="rounded bg-muted px-1.5 font-mono text-xs text-fg-muted">{counts[t]}</span>
          </button>
        ))}
      </div>
      {error && !map ? <ErrorState error={error} onRetry={reload} />
        : !map ? <SkeletonList rows={6} />
        : tab === "services" ? (arch ? <ArchGraph arch={arch} /> : <SkeletonList />)
        : tab === "screens" ? <Screens map={map} params={params} />
        : tab === "apis" ? <Apis map={map} params={params} />
        : <Jobs map={map} />}
    </>
  );
}
