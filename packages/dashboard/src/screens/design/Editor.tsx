import {
  ArrowLeft, Bot, Check, Copy, Download, FileText, LayoutGrid, Maximize2, Minimize2, Pencil, Plus, Redo2, Search, TriangleAlert, Trash2, Undo2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { enc, get, getText, post, subscribe, useApi } from "../../api";
import { Collapsible } from "../../components/Collapsible";
import { ErrorState, Skeleton, card } from "../../components/ui";
import { useApp } from "../../context";
import { diagramSvg, pngBlob } from "../../graph/diagramSvg";
import { DesignGraph, type IssueFilter, type Pos } from "../../graph/DesignGraph";
import { NODE_H, NODE_W } from "../../graph/layout";
import { usePersisted } from "../../persist";
import { zip } from "../../zip";
import type {
  ChatMode, Design, DesignEdge, DesignEdgeView, DesignFlow, DesignNode, DesignNodeView, DesignView, NodeKind, SearchHit,
} from "../../types";
import { ChatPanel, type Streaming } from "./ChatPanel";
import { ContextMenu, QuickAdd, type MenuItem } from "./Menus";
import { Selection, type DesignActions } from "./Selection";
import { SidePanel, type Tab } from "./SidePanel";
import { btn, download, guessEdge, key, newId, primary } from "./shared";
import { changesKeep, DIAGRAM_MARKER, flowKeep, isChange, summarize, trim, visibleDesignNodes, type ViewMode } from "../../../../core/src/design-view";

/** What the canvas shows. The hints are what the buttons promise, in plain words. */
const VIEWS: [ViewMode, string, string][] = [
  ["changes", "Changes", "Only what this design changes, what it connects to, and anything you added"],
  ["flow", "Flow", "The real flow of the code you change (screen → APIs → outside services), with your changes on top"],
  ["full", "Full detail", "Every service function, side effect, table and transaction of that flow, with your changes on top"],
];
const edgeSig = (e: { src: string; dst: string; kind: string }) => `${e.src}|${e.dst}|${e.kind}`;
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
const plainId = (id: string | null) => (id && !id.startsWith("edge:") && !id.startsWith("note:") && !id.startsWith("group:") ? id : undefined);

/** Small stable hash, so a changing set of ids can be part of a request path. */
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export function DesignEditor({ slug }: { slug: string }) {
  const { version, setPick, openPalette, notify, status } = useApp();
  const [view, setView] = useState<DesignView>();
  const [draft, setDraft] = useState<Design>();
  const [error, setError] = useState<string>();
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved">("saved");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("impact");
  const [filter, setFilter] = useState<IssueFilter>("all");
  const [picked, setPicked] = useState<ViewMode | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());          // nodes whose folded neighbours ("+N") are open
  const [fitTick, setFitTick] = useState(0);
  const [quick, setQuick] = useState<{ client: Pos; flow?: Pos; from?: string; reverse?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ id: string; client: Pos } | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);     // null: Claude isn't answering
  const [mode, setMode] = useState<ChatMode>(() => { try { return localStorage.getItem("flowmap.chatMode") === "design" ? "design" : "full"; } catch { return "full"; } });
  const [model, setModel] = useState(() => { try { return localStorage.getItem("flowmap.chatModel") ?? ""; } catch { return ""; } });
  const [chatOpen, setChatOpen] = usePersisted("flowmap.design.chat", true);
  const [sideOpen, setSideOpen] = usePersisted("flowmap.design.side", true);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const was = useRef({ chat: true, side: true });
  const getCenter = useRef<(() => Pos) | null>(null);
  // the latest draft lives in a ref so saves and quick successive edits never use a stale copy
  const cur = useRef<Design>(undefined);
  const dirty = useRef(false);
  const edits = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const history = useRef<{ past: Design[]; future: Design[]; key?: string; at: number }>({ past: [], future: [], at: 0 });

  const load = useCallback(async () => {
    try {
      const v = await get<DesignView>(`/api/designs/${enc(slug)}`);
      setView(v);
      setError(undefined);
      if (!dirty.current) { cur.current = v.design; setDraft(v.design); }
    } catch (e: any) {
      setError(e.message);
    }
  }, [slug]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current || !cur.current) return;
    const started = edits.current;
    setSaveState("saving");
    try {
      const { version: v } = await post<{ version: number }>(`/api/designs/${enc(slug)}`, cur.current);
      cur.current = { ...cur.current, version: v };
      setDraft(cur.current);
      if (edits.current === started) { dirty.current = false; setSaveState("saved"); }
      else timer.current = setTimeout(save, 600);
      load();
    } catch (e: any) {
      if (e.status === 409) {
        dirty.current = false;
        notify("This design was changed elsewhere (by Claude?). Reloaded it — re-apply your last edit.", true);
        setSaveState("saved");
        load();
      } else {
        setSaveState("unsaved");
        notify(`Not saved: ${e.message}`, true);
      }
    }
  }, [slug, load, notify]);

  /** A new draft: show it at once, save shortly after. */
  const apply = useCallback((next: Design) => {
    cur.current = next;
    setDraft(next);
    dirty.current = true;
    edits.current++;
    setSaveState("unsaved");
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 600);
  }, [save]);

  /** Every edit goes through here: undoable, saved. Edits to the same field within 1.5 s (typing) are one undo step. */
  const update = useCallback((fn: (d: Design) => Design, coalesce?: string) => {
    const prev = cur.current;
    if (!prev) return;
    const next = fn(prev);
    if (next === prev) return;
    const h = history.current;
    const now = Date.now();
    if (!(coalesce && h.key === coalesce && now - h.at < 1500)) {
      h.past.push(prev);
      if (h.past.length > 100) h.past.shift();
    }
    h.key = coalesce;
    h.at = now;
    h.future = [];
    apply(next);
    setHist({ undo: h.past.length, redo: 0 });
  }, [apply]);

  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev || !cur.current) return;
    h.future.push(cur.current);
    h.key = undefined;
    apply({ ...prev, version: cur.current.version });
    setHist({ undo: h.past.length, redo: h.future.length });
  }, [apply]);

  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next || !cur.current) return;
    h.past.push(cur.current);
    h.key = undefined;
    apply({ ...next, version: cur.current.version });
    setHist({ undo: h.past.length, redo: h.future.length });
  }, [apply]);

  useEffect(() => { load(); }, [load, version]);
  useEffect(() => () => { clearTimeout(timer.current); void save(); }, [save]);     // leaving the page: flush

  useEffect(() => subscribe((e) => {
    if (e.type === "design" && e.slug === slug && e.version > (cur.current?.version ?? 0)) load();
    if (e.type === "chat" && e.slug === slug) {
      if (e.text) setStreaming((s) => ({ text: [...(s?.text ?? []), e.text!], tools: s?.tools ?? [] }));
      if (e.tool) setStreaming((s) => ({ text: s?.text ?? [], tools: [...(s?.tools ?? []), e.tool!] }));
      if (e.done) {
        setStreaming(null);
        if (e.error) notify(`Claude: ${e.error}`, true);
        load();
      }
    }
  }), [slug, load, notify]);

  // ---- what is drawn ----
  // The view: a design that already changes something opens on its changes, a new one on the flow. After that it's your choice.
  const opening = useRef<ViewMode>(undefined);
  if (draft && !opening.current) opening.current = draft.nodes.some(isChange) ? "changes" : "flow";
  const viewMode: ViewMode = picked ?? opening.current ?? "flow";

  // Flow and Full detail: the real flow around the code this design changes. The server finds it; nothing to pick.
  const flowKey = useMemo(() => hash(!draft ? "" : [
    ...draft.nodes.filter((n) => n.change === "changed" || n.change === "removed").map((n) => n.id),
    ...draft.edges.filter((e) => e.change === "new").flatMap((e) => [e.src, e.dst]),
  ].sort().join(",")), [draft]);
  const { data: flowData, error: flowError } = useApi<DesignFlow>(viewMode !== "changes" ? `/api/designs/${enc(slug)}/flow?mode=${viewMode === "full" ? "full" : "compact"}&k=${flowKey}` : null);
  const lastFlow = useRef<DesignFlow>(undefined);
  if (flowData) lastFlow.current = flowData;
  const found = viewMode !== "changes" ? lastFlow.current : undefined;       // keep the last one on screen while the next loads
  const ctx = found?.flow;

  const shown = useMemo(() => {
    if (!draft) return null;
    const server = new Map(view?.nodes.map((n) => [n.id, n]));
    const flowNodes = new Map(ctx?.nodes.map((n) => [n.id, n]));
    const stale = new Set(view?.stale);
    const mine = draft.nodes.filter((n) => !stale.has(n.id)).map((n): DesignNodeView => {
      const known = server.get(n.id) ?? flowNodes.get(n.id);
      const base = known ?? { id: n.id, kind: n.kind, name: n.name, repo: n.repo, file: n.file ?? "", line: 0, transactional: false, inTx: false, issueCount: 0, maxSeverity: null, outCount: 0, inCount: 0, group: n.repo, attrs: {} };
      const own = n.change === "new" ? { kind: n.kind, name: n.name, repo: n.repo, file: n.file ?? "", transactional: !!n.transactional } : {};
      return { introduced: 0, ...base, ...own, context: undefined, change: n.change, author: n.author, pending: n.pending, x: n.x, y: n.y, pinned: n.pinned, note: n.note, keep: n.keep };
    });
    const inDesign = new Set(mine.map((n) => n.id));
    const context = (ctx?.nodes ?? []).filter((n) => !inDesign.has(n.id)).map((n): DesignNodeView => ({ ...n, introduced: 0, change: "existing", author: "user", context: true }));
    // every arrow between everything we know of: it tells which stored nodes are tied to a change
    const known = new Set([...mine, ...context].map((n) => n.id));
    const removed = new Map(draft.edges.filter((e) => e.change === "removed").map((e) => [edgeSig(e), e]));
    const seen = new Set<string>();
    const all: DesignEdgeView[] = [];
    for (const e of [...(view?.edges ?? []).filter((x) => x.change !== "new"), ...(ctx?.edges ?? [])]) {
      const sig = edgeSig(e);
      if (!known.has(e.src) || !known.has(e.dst) || seen.has(sig)) continue;
      seen.add(sig);
      const r = removed.get(sig);
      all.push({ ...e, designId: r?.id, change: r ? "removed" : undefined, pending: r?.pending });
    }
    draft.edges.filter((e) => e.change === "new" && known.has(e.src) && known.has(e.dst)).forEach((e, i) => all.push({
      id: -(i + 1), src: e.src, dst: e.dst, kind: e.kind, confidence: "exact", file: "", line: 0, attrs: {}, designId: e.id, change: "new", pending: e.pending,
    }));
    // What each view keeps. Changes and Flow fold the rest behind "+N" chips; Full detail is everything.
    const arrows = all.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, change: e.change === "new" || e.change === "removed" ? e.change : undefined }));
    let nodes: DesignNodeView[];
    let hidden = new Map<string, string[]>();
    if (viewMode === "full") nodes = [...visibleDesignNodes(mine, all, new Set(ctx?.nodes.map((n) => n.id))), ...context];
    else {
      // on the way to a change = along the flow's own routes and the arrows this design adds or removes
      const routes = [...(ctx?.edges ?? []).map((e) => ({ src: e.src, dst: e.dst, kind: e.kind })), ...arrows.filter((a) => a.change)];
      const keep = viewMode === "flow" ? flowKeep(known, mine, arrows, routes) : changesKeep(mine, arrows);
      ({ nodes, hidden } = trim([...mine, ...context], arrows, keep, revealed));
    }
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes, edges: all.filter((e) => ids.has(e.src) && ids.has(e.dst)),
      folded: new Map([...hidden].map(([id, list]) => [id, list.length] as const)),
      foldedTotal: new Set([...hidden.values()].flat()).size,
    };
  }, [draft, view, ctx, viewMode, revealed]);

  const latest = useRef({ shown, draft });
  latest.current = { shown, draft };
  const viewOf = (id: string) => latest.current.shown?.nodes.find((n) => n.id === id);

  // ---- editing: small pure helpers, then the actions the canvas, menus and panel call ----
  /** Makes sure a real node (maybe only shown as context so far) is part of the design. */
  const ensure = (d: Design, id: string, v: Pick<DesignNodeView, "kind" | "name" | "repo"> | undefined = viewOf(id)): Design => {
    if (d.nodes.some((n) => n.id === id)) return d;
    return v ? { ...d, nodes: [...d.nodes, { id, change: "existing", kind: v.kind, name: v.name, repo: v.repo, author: "user" }] } : d;
  };
  const mapNode = (d: Design, id: string, fn: (n: DesignNode) => DesignNode): Design => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? fn(n) : n)) });
  /** An existing node that gains a new arrow out of it is being changed. */
  const markChanging = (d: Design, id: string): Design => mapNode(d, id, (n) => (n.change === "existing" ? { ...n, change: "changed" } : n));

  const groupsSeen = ctx ? [...new Set(ctx.nodes.map((n) => n.group))].sort().join("|") : "";
  useEffect(() => {
    setRevealed((r) => (r.size ? new Set() : r));
    if (viewMode !== "full") { setCollapsed((c) => (c.size ? new Set() : c)); return; }
    if (!groupsSeen) return;
    // Full detail is the whole flow: start with only the repos / services that hold a change open, and let people open the rest
    const groups = groupsSeen.split("|");
    const withChanges = new Set((latest.current.shown?.nodes ?? []).filter((n) => !n.context && isChange(n)).map((n) => n.group));
    if (groups.length > 1 && withChanges.size) {
      setCollapsed(new Set(groups.filter((g) => !withChanges.has(g))));
      setFitTick((t) => t + 1);                       // the picture just got smaller: look at it again
    }
  }, [viewMode, groupsSeen]);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    if (id) { setTab("selection"); setSideOpen(true); }
  }, [setSideOpen]);

  const addReal = useCallback((h: SearchHit) => {
    update((d) => mapNode(ensure(d, h.id, h), h.id, (n) => ({ ...n, keep: true })));         // you asked for it: show it even though it is unchanged
    select(h.id);
  }, [update, select]);                                                                // eslint-disable-line react-hooks/exhaustive-deps -- `ensure` reads the latest state from a ref

  useEffect(() => {
    setPick(addReal);
    return () => setPick(undefined);
  }, [setPick, addReal]);

  const addNode = useCallback((kind: NodeKind, name: string, o: { from?: string; at?: Pos; reverse?: boolean } = {}) => {
    const id = newId();
    const from = o.from ? viewOf(o.from) : undefined;
    const repo = kind === "External" ? "" : from?.repo || latest.current.draft?.nodes.find((n) => n.repo)?.repo || status?.repos[0]?.name || "";
    const at = o.at ?? (from ? undefined : getCenter.current?.());          // with nothing to attach to, drop it in the middle of the view
    update((d) => {
      let next = o.from ? ensure(d, o.from) : d;
      next = { ...next, nodes: [...next.nodes, { id, change: "new", kind, name, repo, author: "user", ...(at ? { x: Math.round(at.x - NODE_W / 2), y: Math.round(at.y - NODE_H / 2), pinned: true } : {}) }] };
      if (from) {
        const [src, dst] = o.reverse ? [id, from.id] : [from.id, id];
        const edge: DesignEdge = { id: key("e"), src, dst, kind: guessEdge(o.reverse ? kind : from.kind, o.reverse ? from.kind : kind), change: "new", author: "user" };
        next = markChanging({ ...next, edges: [...next.edges, edge] }, src);
      }
      return next;
    });
    select(id);
    setEditing(id);
  }, [update, select, status]);                                                         // eslint-disable-line react-hooks/exhaustive-deps

  const addNote = useCallback((at?: Pos) => {
    const id = key("note");
    const p = at ?? getCenter.current?.() ?? { x: 0, y: 0 };
    update((d) => ({ ...d, notes: [...d.notes, { id, text: "", x: Math.round(p.x), y: Math.round(p.y), author: "user" }] }));
    select(`note:${id}`);
  }, [update, select]);

  const onConnect = useCallback((src: string, dst: string) => {
    const [a, b] = [viewOf(src), viewOf(dst)];
    if (!a || !b) return;
    const id = key("e");
    update((d) => markChanging({ ...ensure(ensure(d, src), dst), edges: [...d.edges, { id, src, dst, kind: guessEdge(a.kind, b.kind), change: "new", author: "user" }] }, src));
    select(`edge:${id}`);
  }, [update, select]);                                                                // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = useCallback((id: string, p: Pos) => update((d) => id.startsWith("note:")
    ? { ...d, notes: d.notes.map((n) => (`note:${n.id}` === id ? { ...n, ...p } : n)) }
    : mapNode(ensure(d, id), id, (n) => ({ ...n, ...p, pinned: true }))), [update]);                  // eslint-disable-line react-hooks/exhaustive-deps

  const act = useMemo<DesignActions>(() => ({
    modify: (id) => update((d) => mapNode(ensure(d, id), id, (n) => ({ ...n, change: "changed" }))),
    keep: (id) => update((d) => mapNode(d, id, (n) => ({ ...n, change: "existing" }))),
    removeCode: (id) => update((d) => mapNode(ensure(d, id), id, (n) => ({ ...n, change: "removed" }))),
    hide: (id) => { update((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.src !== id && e.dst !== id) })); setSelected(null); },
    note: (id, text) => update((d) => mapNode(d, id, (n) => ({ ...n, note: text || undefined })), `note:${id}`),
    patchNode: (id, p) => update((d) => mapNode(d, id, (n) => ({ ...n, ...p })), `node:${id}:${Object.keys(p).join()}`),
    patchEdge: (id, p) => update((d) => ({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, ...p } : e)) })),
    deleteEdge: (id) => { update((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) })); setSelected(null); },
    markEdgeRemoved: (e) => update((d) => markChanging({ ...ensure(ensure(d, e.src), e.dst), edges: [...d.edges, { id: key("e"), src: e.src, dst: e.dst, kind: e.kind, change: "removed", author: "user" }] }, e.src)),
    decide: (id, accept) => update((d) => accept
      ? { ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, pending: undefined } : n)), edges: d.edges.map((e) => (e.id === id ? { ...e, pending: undefined } : e)) }
      : { ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.id !== id && e.src !== id && e.dst !== id) }),
    setNoteText: (id, text) => update((d) => ({ ...d, notes: d.notes.map((n) => (n.id === id ? { ...n, text } : n)) }), `notetext:${id}`),
    deleteNote: (id) => { update((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) })); setSelected(null); },
  }), [update]);                                                                       // eslint-disable-line react-hooks/exhaustive-deps

  const onDecide = useCallback((id: string, accept: boolean) => act.decide(id, accept), [act]);
  const onRename = useCallback((id: string, name: string) => act.patchNode(id, { name }), [act]);
  const onStopEdit = useCallback(() => setEditing(null), []);
  const onReveal = useCallback((id: string) => setRevealed((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; }), []);
  const onToggleGroup = useCallback((g: string) => { setCollapsed((s) => { const n = new Set(s); if (!n.delete(g)) n.add(g); return n; }); }, []);
  const tidy = () => { update((d) => ({ ...d, nodes: d.nodes.map(({ x: _x, y: _y, pinned: _p, ...n }) => n) })); setFitTick((t) => t + 1); };
  const acceptAll = () => update((d) => ({ ...d, nodes: d.nodes.map((n) => ({ ...n, pending: undefined })), edges: d.edges.map((e) => ({ ...e, pending: undefined })) }));
  const rejectAll = () => update((d) => {
    const gone = new Set(d.nodes.filter((n) => n.pending).map((n) => n.id));
    return { ...d, nodes: d.nodes.filter((n) => !gone.has(n.id)), edges: d.edges.filter((e) => !e.pending && !gone.has(e.src) && !gone.has(e.dst)) };
  });

  /** Delete / Backspace: takes the selected thing off the drawing (not out of the code). */
  const deleteSelected = useCallback(() => {
    const id = selected;
    if (!id) return;
    const d = latest.current.draft;
    if (id.startsWith("note:")) act.deleteNote(id.slice(5));
    else if (id.startsWith("edge:")) {
      const e = latest.current.shown?.edges.find((x) => (x.designId ?? `g${x.id}`) === id.slice(5));
      if (e?.designId) act.deleteEdge(e.designId);
      else notify("That arrow is in your code. Select it and use “This design removes this call” in the panel.");
    } else if (d?.nodes.some((n) => n.id === id)) act.hide(id);
  }, [selected, act, notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector("[cmdk-dialog]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && k === "y") { e.preventDefault(); redo(); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (selected) { e.preventDefault(); deleteSelected(); } }
      else if (e.key === "F2") { const n = latest.current.draft?.nodes.find((x) => x.id === selected); if (n?.change === "new") { e.preventDefault(); setEditing(n.id); } }
      else if (e.key === "Escape") { setQuick(null); setMenu(null); setEditing(null); setSelected(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, selected, deleteSelected]);

  // ---- chat ----
  const send = async (text: string) => {
    await save();                 // Claude reads the design from disk: give it the latest
    setStreaming({ text: [], tools: [] });
    try {
      await post(`/api/designs/${enc(slug)}/chat`, { text, mode, model });
      load();
    } catch (e: any) {
      setStreaming(null);
      notify(`Claude: ${e.message}`, true);
    }
  };
  const stop = () => post(`/api/designs/${enc(slug)}/chat`, { cancel: true }).catch((e: Error) => notify(`Couldn't stop: ${e.message}`, true));
  const chatAction = (body: object, what: string) => post(`/api/designs/${enc(slug)}/chat`, body).then(load, (e: Error) => notify(`Couldn't ${what}: ${e.message}`, true));
  const newConversation = () => chatAction({ new: true }, "start a new conversation");
  const openConversation = (id: string) => chatAction({ open: id }, "open that conversation");
  const deleteConversation = (id: string) => chatAction({ remove: id }, "delete that conversation");
  const changeMode = (m: ChatMode) => {
    setMode(m);
    try { localStorage.setItem("flowmap.chatMode", m); } catch { /* storage unavailable */ }
  };

  // ---- export: the RFC text, the diagram as a picture, and a bundle of both ----
  const rfcText = async () => { await save(); return getText(`/api/designs/${enc(slug)}/export?format=md`); };
  const diagram = async () => { await save(); return diagramSvg(await get<DesignView>(`/api/designs/${enc(slug)}`)); };
  const run = (what: string, task: () => Promise<unknown>, done: string) => task().then(() => notify(done), (e: Error) => notify(`Couldn't ${what}: ${e.message}`, true));
  const exports: [group: string, items: [label: string, icon: typeof Copy, go: () => void][]][] = [
    ["RFC", [
      ["Copy RFC (Notion, Linear)", Copy, () => run("copy the RFC", async () => navigator.clipboard.writeText(await rfcText()), "RFC copied. Paste the diagram image where it says so.")],
      ["Download RFC (.md)", Download, () => run("download the RFC", async () => download(`${slug}.md`, await rfcText(), "text/markdown"), "RFC downloaded")],
      ["Download for Notion (.zip: RFC + image)", Download, () => run("build the bundle", async () => {
        const [text, png] = [await rfcText(), await pngBlob(await diagram())];
        download(`${slug}.zip`, zip([
          { name: `${slug}.md`, data: new TextEncoder().encode(text.replace(DIAGRAM_MARKER, "![What changes](diagram.png)")) },
          { name: "diagram.png", data: new Uint8Array(await png.arrayBuffer()) },
        ]));
      }, "Bundle downloaded. In Notion: Import → Markdown & CSV")],
    ]],
    ["Diagram", [
      // the image is handed over as a promise: the browser keeps the click's permission while it is drawn
      ["Copy diagram image", Copy, () => run("copy the image", async () => navigator.clipboard.write([new ClipboardItem({ "image/png": diagram().then(pngBlob) })]), "Diagram image copied. Paste it with ⌘V")],
      ["Download diagram (PNG)", Download, () => run("download the image", async () => download(`${slug}.png`, await pngBlob(await diagram())), "Diagram downloaded")],
      ["Download diagram (SVG)", Download, () => run("download the image", async () => download(`${slug}.svg`, (await diagram()).svg, "image/svg+xml"), "Diagram downloaded")],
    ]],
    ["Share", [
      ["Download design (.json)", Download, () => run("download the design", async () => { await save(); download(`${slug}.json`, JSON.stringify(cur.current, null, 2), "application/json"); }, "Design downloaded")],
    ]],
  ];

  const focus = !chatOpen && !sideOpen;
  const toggleFocus = () => {
    if (focus) { setChatOpen(was.current.chat); setSideOpen(was.current.side); }
    else { was.current = { chat: chatOpen, side: sideOpen }; setChatOpen(false); setSideOpen(false); }
  };

  if (error && !draft) return <div className="p-8"><ErrorState error={error} onRetry={load} /></div>;
  if (!draft || !shown) return <div className="flex h-full items-center justify-center gap-6" aria-busy="true" aria-label="Loading design">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-64" />)}</div>;

  const pending = draft.nodes.filter((n) => n.pending).length + draft.edges.filter((e) => e.pending).length;
  const changed = draft.nodes.filter((n) => n.change !== "existing").length;
  const summary = summarize(draft.nodes);
  const introduced = view?.impact.introduced.length ?? 0;
  const flowNote = !found ? (flowError ? "Couldn't load the flow" : "Loading the flow…")
    : found.from.length ? `Flows from ${found.from.slice(0, 3).map((r) => r.name).join(" · ")}${found.from.length > 3 ? ` +${found.from.length - 3}` : ""}`
    : found.roots ? "The flow of what you change" : "Modify existing code to see its flow";
  const selectedNode = plainId(selected);
  const nameOf = (id: string) => viewOf(id)?.name ?? id;

  const menuItems = (id: string): MenuItem[] => {
    if (id.startsWith("note:")) return [{ label: "Delete note", icon: Trash2, onSelect: () => act.deleteNote(id.slice(5)), hint: "Del", danger: true }];
    const own = draft.nodes.find((n) => n.id === id);
    const items: MenuItem[] = [];
    if (own?.change === "new") items.push({ label: "Rename", icon: Pencil, onSelect: () => setEditing(id), hint: "F2" });
    items.push({ label: "Add a node after this…", icon: Plus, onSelect: () => setQuick({ client: menu?.client ?? { x: 200, y: 200 }, from: id }) });
    if (own?.change !== "new") {
      const change = own?.change ?? "existing";
      if (change !== "changed") items.push({ label: "Modify it", icon: Pencil, onSelect: () => act.modify(id) });
      if (change === "changed" || change === "removed") items.push({ label: change === "removed" ? "Keep it" : "Not changing it", icon: Check, onSelect: () => act.keep(id) });
      if (change !== "removed") items.push({ label: "Remove it", icon: Trash2, onSelect: () => act.removeCode(id), danger: true });
    }
    if (own) items.push({ label: own.change === "new" ? "Delete node" : "Hide from diagram", icon: X, onSelect: () => act.hide(id), hint: "Del" });
    return items;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <a href="#/designs" aria-label="All designs" className="rounded-md p-1 text-fg-muted hover:bg-muted"><ArrowLeft className="size-4" aria-hidden /></a>
        <input value={draft.title} onChange={(e) => update((d) => ({ ...d, title: e.target.value }), "title")} aria-label="Design title" maxLength={200}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-base font-semibold hover:bg-muted focus:bg-muted focus:outline-none" />
        <span className="text-xs text-fg-subtle" aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved" : "Saved"}</span>
        <button type="button" onClick={toggleFocus} aria-pressed={focus} title="Hide both side panels to give the canvas the whole width" className={btn}>
          {focus ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}{focus ? "Show panels" : "Focus"}
        </button>
        <details className="relative">
          <summary className={`${primary} cursor-pointer list-none`}><Download className="size-4" aria-hidden /> Export</summary>
          <div className={`${card} absolute right-0 z-30 mt-1 w-72 p-1 shadow-lg`}>
            {exports.map(([group, items]) => (
              <div key={group} className="border-b border-line pb-1 last:border-b-0">
                <p className="px-2 pt-1.5 pb-0.5 text-xs text-fg-subtle">{group}</p>
                {items.map(([label, Icon, go]) => (
                  <button key={label} type="button" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; go(); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                    <Icon className="size-4 text-fg-muted" aria-hidden />{label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </details>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-1.5">
        <button type="button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setQuick({ client: { x: r.left, y: r.bottom + 4 }, from: selectedNode }); }} className={primary} aria-haspopup="menu">
          <Plus className="size-4" aria-hidden /> Add
        </button>
        <button type="button" onClick={undo} disabled={!hist.undo} aria-label="Undo" title="Undo (⌘Z)" className={btn}><Undo2 className="size-4" aria-hidden /></button>
        <button type="button" onClick={redo} disabled={!hist.redo} aria-label="Redo" title="Redo (⇧⌘Z)" className={btn}><Redo2 className="size-4" aria-hidden /></button>
        <button type="button" onClick={tidy} title="Lay everything out again (frees nodes you moved)" className={btn}><LayoutGrid className="size-4" aria-hidden /> Tidy</button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <div role="group" aria-label="What to show" className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
          {VIEWS.map(([m, label, hint]) => (
            <button key={m} type="button" aria-pressed={viewMode === m} onClick={() => { setPicked(m); setFitTick((t) => t + 1); }} title={hint}
              className={`rounded-md px-2.5 py-1 ${viewMode === m ? "bg-bg font-medium shadow-sm" : "text-fg-muted hover:text-fg"}`}>
              {label}{m === "changes" && changed > 0 && <span className="ml-1.5 rounded bg-bg/70 px-1 font-mono text-xs text-fg-subtle">{changed}</span>}
            </button>
          ))}
        </div>
        <span className="max-w-md truncate text-sm text-fg-muted" title={viewMode === "changes" ? "What this design changes. Unchanged code next to it is folded behind a +N on the node: click it to show." : viewMode === "flow" ? "The way from the screens, APIs and jobs to the code you change. Other branches are folded behind a +N." : "The whole real flow, like the App map. Repos with no change start folded."}>
          {(viewMode === "changes" ? summary || "Nothing changed yet" : flowNote) + (shown.foldedTotal ? ` · ${shown.foldedTotal} unchanged folded away` : "")}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <select value={filter} onChange={(e) => setFilter(e.target.value as IssueFilter)} aria-label="Highlight" className="rounded-md border border-line bg-bg px-2 py-1.5 text-sm">
            <option value="all">Highlight: nothing</option>
            <option value="issues">Highlight: nodes with issues</option>
            <option value="introduced">Highlight: issues this design adds</option>
          </select>
          {introduced > 0 && (
            <button type="button" onClick={() => { setTab("impact"); setSideOpen(true); }} className="inline-flex items-center gap-1.5 rounded-md bg-warn-soft px-2.5 py-1.5 text-sm font-medium text-warn hover:opacity-90" title="See what this design would break">
              <TriangleAlert className="size-4" aria-hidden />{introduced} new issue{introduced === 1 ? "" : "s"}
            </button>
          )}
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <Collapsible side="left" open={chatOpen} onOpenChange={setChatOpen} label="Claude" icon={Bot} badge={pending > 0 ? <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-accent" /> : undefined}>
          <ChatPanel messages={view?.chat ?? []} conversations={view?.conversations ?? []} streaming={streaming} mode={mode} onMode={changeMode} model={model} onModel={(m) => { setModel(m); try { localStorage.setItem("flowmap.chatModel", m); } catch { /* storage unavailable */ } }} pending={pending}
            onSend={send} onStop={stop} onNew={newConversation} onOpen={openConversation} onDelete={deleteConversation} onAcceptAll={acceptAll} onRejectAll={rejectAll} onCollapse={() => setChatOpen(false)} />
        </Collapsible>

        <div className="relative min-w-0 flex-1">
          <DesignGraph nodes={shown.nodes} edges={shown.edges} notes={draft.notes} selected={selected} editing={editing} filter={filter}
            collapsed={collapsed} fitKey={`${viewMode}|${ctx?.nodes.length ?? "-"}|${fitTick}`} getCenter={getCenter} folded={shown.folded} opened={revealed} onReveal={onReveal}
            onSelect={select} onMove={onMove} onConnect={onConnect} onDecide={onDecide} onRename={onRename} onStopEdit={onStopEdit}
            onToggleGroup={onToggleGroup} onEditNode={(id) => { if (draft.nodes.find((n) => n.id === id)?.change === "new") setEditing(id); else select(id); }}
            onQuickAdd={setQuick} onContextMenu={(id, client) => setMenu({ id, client })} />
          {!shown.nodes.length && !draft.notes.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className={`${card} pointer-events-auto max-w-md p-5 text-center shadow-lg`}>
                <p className="font-medium">{viewMode === "changes" ? "Nothing changed yet" : "No flow to show yet"}</p>
                <p className="mt-1 text-sm text-fg-muted">
                  {viewMode === "changes"
                    ? "Add something new, or find existing code you want to change. You can also describe the feature to Claude on the left."
                    : "The flow is the real code around what you change. Find existing code to change, or add something new, and its flow appears here."}
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={() => openPalette()} className={primary}><Search className="size-4" aria-hidden /> Find code to change…</button>
                  <button type="button" onClick={() => setQuick({ client: { x: innerWidth / 2 - 120, y: innerHeight / 2 }, flow: getCenter.current?.() })} className={btn}><Plus className="size-4" aria-hidden /> Add a node</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <Collapsible side="right" open={sideOpen} onOpenChange={setSideOpen} label="Impact & RFC" icon={FileText}
          badge={introduced > 0 ? <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-warn" /> : undefined}>
          <SidePanel slug={slug} tab={selected ? tab : tab === "selection" ? "impact" : tab} setTab={setTab} hasSelection={!!selected}
            view={view} draft={draft} update={update} onSend={send} claudeBusy={streaming !== null} flush={save} onCollapse={() => setSideOpen(false)}>
            {selected && <Selection id={selected} draft={draft} nodes={shown.nodes} edges={shown.edges} act={act} onClose={() => setSelected(null)} />}
          </SidePanel>
        </Collapsible>
      </div>

      {quick && (
        <QuickAdd at={quick.client} fromName={quick.from ? nameOf(quick.from) : undefined} onClose={() => setQuick(null)}
          onKind={(kind, name) => addNode(kind, name, { from: quick.from, at: quick.flow, reverse: quick.reverse })}
          onExisting={() => openPalette()} onNote={() => addNote(quick.flow)} />
      )}
      {menu && <ContextMenu at={menu.client} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  );
}

