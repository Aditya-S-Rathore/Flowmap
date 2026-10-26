import { ArrowLeft, ArrowLeftRight, Camera, CornerDownRight, Flag, Info, Link2Off, ListTree, Lock, ShieldAlert, ShieldCheck, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { enc, useApi } from "../api";
import { DetailPanel } from "../components/DetailPanel";
import { KIND, KindIcon } from "../components/kind";
import { EditorLink, exploreHref } from "../components/refs";
import { ErrorState, Pill, Skeleton, card } from "../components/ui";
import { ScreenFrame } from "../components/Wireframe";
import { outline, OutlineView, sameElement } from "../components/Outline";
import { useApp } from "../context";
import { FlowGraph } from "../graph/FlowGraph";
import type { AppMap, ScreenInfo, ShotInfo, ShotSpots, Subgraph, WireNode, Wireframe } from "../types";
import { mapHref, Stats } from "./AppMap";

type Mode = "wireframe" | "compact" | "full";

const MODES: Record<Mode, [label: string, hint: string]> = {
  wireframe: ["Screen", "The screen's screenshot (when captured) and an outline of what each part calls"],
  compact: ["Flow", "Screen → components → APIs → outside services"],
  full: ["Full detail", "Every service function with side effects, tables and transactions"],
};

/** What a clicked wireframe element is and what it triggers. */
function ElementPanel({ n, onClose }: { n: WireNode; onClose: () => void }) {
  return (
    <aside aria-label="Element details" className="flex h-full w-full flex-col overflow-y-auto border-l border-line bg-bg md:w-sm">
      <div className="flex items-start gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg-muted capitalize">{n.kind === "component" ? "Component" : n.kind}</p>
          <h2 className="mt-0.5 break-words font-semibold">{n.label ?? n.component?.name ?? n.kind}</h2>
          <EditorLink repo={n.repo} file={n.file} line={n.line} className="mt-1" />
        </div>
        <button type="button" onClick={onClose} aria-label="Close (Esc)" className="rounded-md p-1 text-fg-muted hover:bg-muted"><X className="size-4" aria-hidden /></button>
      </div>
      {n.component && (
        <section className="border-t border-line px-5 py-4">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Component</h3>
          <a href={exploreHref(n.component.id)} className="flex items-center gap-2 text-sm font-medium hover:text-accent"><KindIcon kind={n.component.kind} />{n.component.name}</a>
          <EditorLink repo={n.component.repo} file={n.component.file} line={n.component.line} className="mt-1 ml-6" />
        </section>
      )}
      <section className="border-t border-line px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Calls</h3>
        {n.apis?.length ? (
          <ul className="space-y-1.5">
            {n.apis.map((a) => (
              <li key={a.id}><a href={mapHref(a.id)} className="flex items-center gap-2 text-sm font-medium hover:text-accent"><ArrowLeftRight className="size-4 text-accent" aria-hidden /><span className="truncate font-mono">{a.name}</span></a></li>
            ))}
          </ul>
        ) : <p className="text-sm text-fg-subtle">No API call found for this element.</p>}
      </section>
      {n.to && (
        <section className="border-t border-line px-5 py-4">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Opens</h3>
          <a href={mapHref(n.to.id)} className="flex items-center gap-2 font-mono text-sm hover:text-accent"><CornerDownRight className="size-4" aria-hidden />{n.to.name}</a>
        </section>
      )}
    </aside>
  );
}

/** A captured page with its buttons, links and inputs clickable (matched to the code behind them). */
function Screenshot({ screen, variant, onPick, selected }: { screen: ScreenInfo; variant: ShotInfo["variant"]; onPick: (n: WireNode) => void; selected: WireNode | null }) {
  const { data } = useApi<ShotSpots>(`/api/spots/${enc(screen.id)}?variant=${variant}`);
  const { version } = useApp();
  const [showAreas, setShowAreas] = useState(false);
  const pct = (v: number, of: number) => `${(v / Math.max(of, 1)) * 100}%`;
  return (
    <div className="relative">
      <img src={`/api/shot/${enc(screen.id)}?variant=${variant}&v=${version}`} alt={`Screenshot of ${screen.name}`} className="block w-full" />
      {data?.spots.map((s, i) => {
        const node: WireNode = { kind: s.kind, label: s.label, apis: s.apis, to: s.to, component: s.component, repo: s.repo, file: s.file, line: s.line };
        const active = sameElement(selected, node);
        return (
          <button key={i} type="button" onClick={(e) => { e.stopPropagation(); onPick(node); }}
            title={[s.label, s.apis?.map((a) => a.name).join(", "), s.to && `→ ${s.to.name}`].filter(Boolean).join(" · ")}
            aria-label={`${s.label || s.kind}${s.apis?.length ? `, calls ${s.apis.map((a) => a.name).join(", ")}` : ""}`}
            style={{ left: pct(s.x, data.width), top: pct(s.y, data.height), width: pct(s.w, data.width), height: pct(s.h, data.height) }}
            className={`absolute rounded-sm transition-colors hover:bg-accent/15 hover:ring-2 hover:ring-accent ${active ? "bg-accent/20 ring-2 ring-accent" : showAreas ? (s.apis?.length ? "ring-2 ring-accent/70" : "ring-1 ring-accent/40") : ""}`} />
        );
      })}
      {data && data.spots.length > 0 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setShowAreas(!showAreas); }}
          className="absolute top-2 right-2 rounded-md border border-line bg-bg/90 px-2 py-1 text-xs text-fg-muted shadow-sm hover:text-fg">
          {showAreas ? "Hide" : "Show"} clickable areas ({data.spots.length})
        </button>
      )}
    </div>
  );
}

/** Capture (or re-capture) this screen from the running app; the result arrives as a live update. */
function CaptureButton({ screen, variant, again }: { screen: ScreenInfo; variant: ShotInfo["variant"]; again: boolean }) {
  const { version } = useApp();
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (busy !== null && version > busy) setBusy(null); }, [version, busy]);
  const run = async () => {
    setErr(undefined);
    setBusy(version);
    const r = await fetch(`/api/capture/${enc(screen.id)}?variant=${variant}`, { method: "POST", headers: { "x-flowmap": "1" } }).catch(() => null);
    if (!r || r.status !== 202) { setBusy(null); setErr(r?.status === 409 ? "A capture is already running." : "Couldn't start the capture."); }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={run} disabled={busy !== null}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 py-1 text-sm text-fg hover:bg-muted disabled:opacity-60">
        <Camera className={`size-4 ${busy !== null ? "animate-pulse" : ""}`} aria-hidden />{busy !== null ? "Capturing…" : again ? "Re-capture" : "Capture screenshot"}
      </button>
      {err && <span className="text-xs text-error">{err}</span>}
    </span>
  );
}

/** The screen: its screenshot (when captured) next to an outline of what's on it and what each part calls. */
function ScreenView({ screen }: { screen: ScreenInfo }) {
  const { data, error, reload } = useApi<Wireframe>(`/api/wireframe/${enc(screen.id)}`);
  const [picked, setPicked] = useState<WireNode | null>(null);
  const [variant, setVariant] = useState<ShotInfo["variant"] | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPicked(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const rows = useMemo(() => outline(data?.root ?? null), [data]);
  if (error && !data) return <div className="p-8"><ErrorState error={error} onRetry={reload} /></div>;
  if (!data) return <div className="p-8"><Skeleton className="mx-auto h-96 max-w-5xl" /></div>;

  const ok = data.shots.filter((x) => x.ok);
  const current = ok.find((x) => x.variant === variant) ?? ok.find((x) => x.variant === "desktop") ?? ok[0];
  const failed = !current ? data.shots.find((x) => !x.ok) : undefined;
  const has = (v: ShotInfo["variant"]) => ok.some((x) => x.variant === v);
  const pick = (mobile: boolean, dark: boolean) => setVariant(`${mobile ? "mobile" : "desktop"}${dark ? "-dark" : ""}` as ShotInfo["variant"]);
  const isMobile = current?.variant.startsWith("mobile") ?? false, isDark = current?.variant.endsWith("dark") ?? false;
  const seg = "rounded-md px-2.5 py-1", on = "bg-bg font-medium text-fg shadow-sm", off = "hover:text-fg";
  // a click on the screenshot selects the matching outline row (same element in code)
  const select = (n: WireNode) => setPicked(rows.find((r) => sameElement(r.node, n))?.node ?? n);

  const outlinePanel = (
    <section className={`${card} overflow-hidden`} aria-label="What's on this screen">
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold">
        <ListTree className="size-4 text-accent" aria-hidden />On this screen
        <span className="font-normal text-fg-subtle">· {rows.filter((r) => r.apis?.length).length} call an API</span>
      </h2>
      <OutlineView rows={rows} selected={picked} onPick={setPicked} />
    </section>
  );

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto bg-subtle/50 p-6" onClick={() => setPicked(null)}>
        <div className="mx-auto max-w-7xl">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-fg-muted" onClick={(e) => e.stopPropagation()}>
            {current && (has("mobile") || has("mobile-dark")) && (
              <div role="group" aria-label="Device" className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
                {[false, true].map((m) => <button key={String(m)} type="button" aria-pressed={isMobile === m} disabled={!has(`${m ? "mobile" : "desktop"}${isDark ? "-dark" : ""}` as ShotInfo["variant"])} onClick={() => pick(m, isDark)} className={`${seg} ${isMobile === m ? on : off} disabled:opacity-40`}>{m ? "Mobile" : "Desktop"}</button>)}
              </div>
            )}
            {current && (has("desktop-dark") || has("mobile-dark")) && (
              <div role="group" aria-label="Theme" className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
                {[false, true].map((d) => <button key={String(d)} type="button" aria-pressed={isDark === d} disabled={!has(`${isMobile ? "mobile" : "desktop"}${d ? "-dark" : ""}` as ShotInfo["variant"])} onClick={() => pick(isMobile, d)} className={`${seg} ${isDark === d ? on : off} disabled:opacity-40`}>{d ? "Dark" : "Light"}</button>)}
              </div>
            )}
            {current
              ? <span>Captured {new Date(current.at).toLocaleString()}{current.blocked ? ` · ${current.blocked} write request${current.blocked > 1 ? "s" : ""} blocked` : ""} · click a button on the screenshot or a row in the outline</span>
              : <span>No screenshot yet. The outline shows what's on the screen and what each part calls.</span>}
            {data.capturable && <span className="ml-auto"><CaptureButton screen={screen} variant={current?.variant ?? "desktop"} again={!!current} /></span>}
          </div>
          {failed && (
            <p className="mb-3 flex items-start gap-2 rounded-md border border-line bg-bg px-3 py-2 text-xs text-fg-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>Last capture: {failed.note ?? "not available."}{/sign-in/i.test(failed.note ?? "") ? <> Run <code className="font-mono">flowmap screenshots --login</code> once and sign in.</> : null}</span>
            </p>
          )}
          {!data.capturable && !current && (
            <p className="mb-3 text-xs text-fg-subtle">To see the real screen, add <code className="font-mono">screenshots: {"{ baseUrl }"}</code> to this repo's flowmap.config.mjs and run <code className="font-mono">flowmap screenshots</code>.</p>
          )}
          {current ? (
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
              <div className={isMobile ? "mx-auto w-full max-w-sm" : ""}>
                <ScreenFrame path={screen.name}><Screenshot screen={screen} variant={current.variant} onPick={select} selected={picked} /></ScreenFrame>
              </div>
              <div className="xl:sticky xl:top-0 xl:max-h-[calc(100vh-14rem)] xl:overflow-y-auto">{outlinePanel}</div>
            </div>
          ) : <div className="mx-auto max-w-3xl">{outlinePanel}</div>}
        </div>
      </div>
      {picked && <div className="absolute inset-0 z-10 md:static md:z-auto"><ElementPanel n={picked} onClose={() => setPicked(null)} /></div>}
    </div>
  );
}

/** One screen, API or job: what it does across repos, in boxes per repo/service. */
export function FlowView({ id }: { id: string }) {
  const { data: map, error: mapError, reload: reloadMap } = useApi<AppMap>("/api/map");
  const screen = map?.screens.find((s) => s.id === id);
  const api = map?.apis.find((a) => a.id === id);
  const job = map?.jobs.find((j) => j.id === id);
  const [picked, setPicked] = useState<Mode | null>(null);
  const mode: Mode = picked ?? (screen ? "wireframe" : "full");
  const { data: flow, error, reload } = useApi<Subgraph>(map && mode !== "wireframe" ? `/api/flow/${enc(id)}?mode=${mode}` : null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[cmdk-dialog]")) setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const root = flow?.nodes.find((n) => n.id === id);
  const info = screen ?? api ?? job;
  const title = info?.name ?? root?.name;
  const kind = root?.kind ?? (screen ? "Route" : api ? "Operation" : job?.kind);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <a href={`#/map?tab=${screen ? "screens" : api ? "apis" : job ? "jobs" : "services"}`} className="mt-0.5 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden />App map
          </a>
          <div className="min-w-0 flex-1">
            {title ? (
              <>
                <p className="flex items-center gap-1.5 text-xs text-fg-muted">{kind && <KindIcon kind={kind} className="size-3.5" />}{kind && KIND[kind].label} · {info?.group ?? root?.group}</p>
                <h1 className="mt-0.5 truncate font-mono text-lg font-semibold" title={title}>{title}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {info && <EditorLink repo={info.repo} file={info.file} line={info.line} />}
                  {screen?.component && <span className="text-xs text-fg-muted">renders <span className="font-mono">{screen.component.name}</span></span>}
                  {api?.handler && <span className="text-xs text-fg-muted">handled by <span className="font-mono">{api.handler.name}</span></span>}
                </div>
              </>
            ) : <div className="space-y-2"><Skeleton className="h-3 w-40" /><Skeleton className="h-6 w-72" /></div>}
          </div>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="Detail level" className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
              {(screen ? (["wireframe", "compact", "full"] as const) : (["compact", "full"] as const)).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setPicked(m)} title={MODES[m][1]}
                  className={`rounded-md px-2.5 py-1 ${mode === m ? "bg-bg font-medium shadow-sm" : "text-fg-muted hover:text-fg"}`}>
                  {screen || m !== "compact" ? MODES[m][0] : "Overview"}
                </button>
              ))}
            </div>
            <a href={exploreHref(id)} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:bg-muted" title="Open in the Explorer (step-by-step, expandable)">
              <Workflow className="size-4" aria-hidden />Explorer
            </a>
          </div>
        </div>
        {info && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Stats c={info} apis={!api} />
            {screen?.auth && <Pill><Lock className="mr-1 size-3" aria-hidden />Signed in</Pill>}
            {screen?.flag && <Pill tone="accent"><Flag className="mr-1 size-3" aria-hidden />{screen.flag}</Pill>}
            {screen?.unlinked && <span title="Nothing in the code links here: opened by URL (email, redirect) or unused."><Pill><Link2Off className="mr-1 size-3" aria-hidden />No links in code</Pill></span>}
            {api && (api.guarded
              ? <span className="inline-flex items-center gap-1 text-xs text-success"><ShieldCheck className="size-3.5" aria-hidden />{api.guards.join(", ") || "Global guard"}</span>
              : <span className="inline-flex items-center gap-1 text-xs text-warn"><ShieldAlert className="size-3.5" aria-hidden />No guard</span>)}
            {api && map!.screens.length > 0 && <span className="text-xs text-fg-muted">Used by {api.screens} screen{api.screens === 1 ? "" : "s"}</span>}
            {screen && screen.linksOut.length > 0 && (
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                Links to
                {screen.linksOut.slice(0, 8).map((l) => <a key={l.id} href={mapHref(l.id)} className="rounded border border-line px-1.5 py-0.5 font-mono hover:border-accent hover:text-accent">{l.name}</a>)}
                {screen.linksOut.length > 8 && <span>+{screen.linksOut.length - 8}</span>}
              </span>
            )}
          </div>
        )}
      </header>

      {mode === "wireframe" && screen ? <div className="relative min-h-0 flex-1"><ScreenView screen={screen} /></div> : (
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {(error || mapError) && !flow && <div className="p-8"><ErrorState error={error ?? mapError!} onRetry={() => { reloadMap(); reload(); }} /></div>}
          {!flow && !error && !mapError && (
            <div className="flex h-full items-center justify-center gap-6" aria-busy="true" aria-label="Loading flow">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-64" />)}
            </div>
          )}
          {flow && <FlowGraph key={mode} nodes={flow.nodes} edges={flow.edges} rootId={id} selected={selected} onSelect={setSelected} expandable={false} />}
          {flow && flow.edges.length === 0 && (
            <p className="pointer-events-none absolute inset-x-0 top-6 mx-auto w-fit rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg-muted">
              No API calls, table access or outside services found from here.
            </p>
          )}
          {flow?.truncated && (
            <p className="absolute top-3 left-3 z-10 flex max-w-md items-start gap-2 rounded-md border border-line bg-bg/95 px-3 py-2 text-xs text-fg-muted shadow-sm">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {flow.omitted && screen ? (
                <span>
                  Showing the APIs that change data or call outside services first; {flow.omitted} more aren't drawn.{" "}
                  <a href={`#/map?tab=apis&screen=${enc(id)}`} className="font-medium text-accent hover:underline">See all {screen.apis} APIs</a>
                </span>
              ) : "Large flow: some branches are hidden to keep it readable. Click a node and use Focus to open it on its own."}
            </p>
          )}
        </div>
        {selected && (
          <div className="absolute inset-0 z-10 md:static md:z-auto">
            <DetailPanel id={selected} isRoot={selected === id} onClose={() => setSelected(null)} onFocus={() => { location.hash = mapHref(selected); }} />
          </div>
        )}
      </div>
      )}
    </div>
  );
}
