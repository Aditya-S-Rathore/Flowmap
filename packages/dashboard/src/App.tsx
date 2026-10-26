import { BookOpen, CircleAlert, Command as CommandIcon, Database, GitBranch, GitCompare, LayoutDashboard, Map as MapIcon, Moon, Search, Sun, TriangleAlert, Waypoints, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { get, subscribe } from "./api";
import { CommandPalette } from "./components/CommandPalette";
import { AppCtx, type Editor } from "./context";
import { AppMap } from "./screens/AppMap";
import { Changes } from "./screens/Changes";
import { Explorer } from "./screens/Explorer";
import { FlowView } from "./screens/FlowView";
import { Issues } from "./screens/Issues";
import { Overview } from "./screens/Overview";
import { Rules } from "./screens/Rules";
import { Tables } from "./screens/Tables";
import type { Status } from "./types";

const NAV: [route: string, label: string, icon: LucideIcon][] = [
  ["overview", "Overview", LayoutDashboard],
  ["map", "App map", MapIcon],
  ["explore", "Explorer", Workflow],
  ["issues", "Issues", TriangleAlert],
  ["rules", "Rules", BookOpen],
  ["changes", "Changes", GitCompare],
  ["tables", "Tables", Database],
];

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function ago(iso: string | null, now: number) {
  if (!iso) return "not indexed yet";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return `indexed ${s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`} ago`;
}

export function App() {
  const [hash, setHash] = useState(location.hash);
  const [status, setStatus] = useState<Status>();
  const [statusError, setStatusError] = useState<string>();
  const [version, setVersion] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [editor, setEditor] = useState<Editor>(store.get("flowmap.editor") === "cursor" ? "cursor" : "vscode");
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
      else if (e.key === "/" && !typing) { e.preventDefault(); setPaletteOpen(true); }
    };
    const tick = setInterval(() => setNow(Date.now()), 5000);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(tick); window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); };
  }, []);

  useEffect(() => {
    get<Status>("/api/status").then((s) => { setStatus(s); setIndexing(s.indexing); setStatusError(undefined); }, (e: Error) => setStatusError(e.message));
  }, [version]);

  useEffect(() => subscribe((e) => {
    if (e.type === "shot") {
      setVersion((v) => v + 1);
      setToast(e.ok ? { text: "Screenshot updated" } : { text: `No screenshot: ${e.note ?? "capture failed"}`, error: true });
    } else if (e.type === "indexing") setIndexing(true);
    else if (e.type === "updated") {
      setIndexing(false);
      setVersion((v) => v + 1);
      if (e.config) setToast({ text: `Config reloaded${e.files ? ` · re-indexed in ${e.durationMs} ms` : ""}` });
      else if (e.files) setToast({ text: `Index updated · ${e.files} files · ${e.durationMs} ms` });
    } else {
      setIndexing(false);
      setToast({ text: `Indexing failed: ${e.message}`, error: true });
    }
  }), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("flowmap.theme", next);
    setDark(!dark);
  };
  const changeEditor = (e: Editor) => { setEditor(e); store.set("flowmap.editor", e); };

  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [route = "overview", ...rest] = path.split("/");
  const id = rest.length ? decodeURIComponent(rest.join("/")) : undefined;
  const active = NAV.some(([r]) => r === route) ? route : "overview";

  const nav = NAV.map(([r, label, Icon]) => (
    <a key={r} href={`#/${r}`} aria-current={active === r ? "page" : undefined} title={label}
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ${active === r ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg"}`}>
      <Icon className="size-4" aria-hidden /><span className="max-md:sr-only">{label}</span>
    </a>
  ));

  return (
    <AppCtx.Provider value={{ status, editor, version }}>
      <div className="flex h-dvh">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-subtle md:flex">
          <div className="px-4 pt-5 pb-4">
            <p className="flex items-center gap-2 font-semibold"><Waypoints className="size-5 text-accent" aria-hidden />FlowMap</p>
            <p className="mt-3 truncate text-sm font-medium">{status?.workspace ?? "—"}</p>
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Repositories">
              {status?.repos.map((r) => (
                <li key={r.name} title={r.path} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs">
                  <span className="font-medium">{r.name}</span>
                  {r.branch && <span className="inline-flex min-w-0 items-center gap-0.5 font-mono text-fg-subtle"><GitBranch className="size-3 shrink-0" aria-hidden /><span className="truncate">{r.branch}</span></span>}
                </li>
              ))}
            </ul>
          </div>
          <nav aria-label="Main" className="flex-1 space-y-0.5 px-2">{nav}</nav>
          <p className="flex items-center gap-2 border-t border-line px-4 py-3 text-xs text-fg-muted" aria-live="polite">
            {statusError ? (
              <><CircleAlert className="size-3.5 text-error" aria-hidden /><span className="truncate" title={statusError}>Server unreachable</span></>
            ) : (
              <>
                <span className={`size-2 rounded-full ${indexing ? "animate-pulse bg-warn" : status?.indexedAt ? "bg-success" : "bg-fg-subtle"}`} aria-hidden />
                {indexing ? "Indexing…" : status ? ago(status.indexedAt, now) : "Connecting…"}
              </>
            )}
          </p>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-line px-4 py-2">
            <nav aria-label="Main" className="flex gap-1 md:hidden">{nav}</nav>
            <button type="button" onClick={() => setPaletteOpen(true)}
              className="flex w-full max-w-md items-center gap-2 rounded-md border border-line bg-subtle px-3 py-1.5 text-sm text-fg-subtle hover:border-line-strong">
              <Search className="size-4" aria-hidden />
              <span className="flex-1 truncate text-left">Search screens, APIs, functions…</span>
              <kbd className="hidden items-center rounded border border-line bg-bg px-1 text-xs sm:inline-flex"><CommandIcon className="size-3" aria-hidden />K</kbd>
            </button>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <span className="hidden lg:inline">Open files in</span>
                <select value={editor} onChange={(e) => changeEditor(e.target.value as Editor)} aria-label="Editor for file links"
                  className="rounded-md border border-line bg-bg px-2 py-1 text-sm text-fg">
                  <option value="vscode">VS Code</option>
                  <option value="cursor">Cursor</option>
                </select>
              </label>
              <button type="button" onClick={toggleTheme} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
                className="rounded-md p-1.5 text-fg-muted hover:bg-muted hover:text-fg">
                {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
              </button>
            </div>
          </header>

          <main className={`min-h-0 flex-1 ${active === "explore" || (active === "map" && id) ? "" : "overflow-y-auto"}`}>
            {active === "explore" ? <Explorer id={id} onSearch={() => setPaletteOpen(true)} />
              : active === "map" && id ? <FlowView key={id} id={id} /> : (
              <div className="mx-auto max-w-7xl px-6 py-8">
                {active === "overview" && <Overview />}
                {active === "map" && <AppMap key={query} params={new URLSearchParams(query)} />}
                {active === "issues" && <Issues key={query} params={new URLSearchParams(query)} />}
                {active === "rules" && <Rules />}
                {active === "changes" && <Changes />}
                {active === "tables" && <Tables />}
              </div>
            )}
          </main>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      {toast && (
        <div role="status" className={`fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-lg border bg-bg px-3 py-2 text-sm shadow-lg ${toast.error ? "border-error/40 text-error" : "border-line text-fg-muted"}`}>
          <span className={`size-2 rounded-full ${toast.error ? "bg-error" : "bg-success"}`} aria-hidden />{toast.text}
        </div>
      )}
    </AppCtx.Provider>
  );
}
