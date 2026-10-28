import { Search, StickyNote, type LucideIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { KindIcon } from "../../components/kind";
import type { NodeKind } from "../../types";
import { ADD_KINDS } from "./shared";

export type Point = { x: number; y: number };

/** A menu at a screen position; clicking elsewhere, right-clicking or Escape closes it. */
export function Popover({ at, label, onClose, children, width = "w-60" }: { at: Point; label: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div role="menu" aria-label={label} className={`fixed z-50 ${width} overflow-hidden rounded-lg border border-line bg-bg py-1 shadow-xl`}
        style={{ left: Math.max(8, Math.min(at.x, innerWidth - 248)), top: Math.max(8, Math.min(at.y, innerHeight - 420)) }}>
        {children}
      </div>
    </>
  );
}

const item = "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-muted";

/** "Add": a screen, API, function, table… or existing code, or a note. Opened from the toolbar, a double-click or a dropped arrow. */
export function QuickAdd({ at, fromName, onKind, onExisting, onNote, onClose }: {
  at: Point; fromName?: string; onKind: (kind: NodeKind, name: string) => void; onExisting: () => void; onNote: () => void; onClose: () => void;
}) {
  return (
    <Popover at={at} label="Add" onClose={onClose}>
      <p className="px-3 pt-1 pb-1.5 text-xs text-fg-subtle">{fromName ? <>Add and connect from <span className="font-medium text-fg-muted">{fromName}</span></> : "Add a new…"}</p>
      {ADD_KINDS.map(([kind, label, name]) => (
        <button key={kind} type="button" role="menuitem" onClick={() => { onKind(kind, name); onClose(); }} className={item}>
          <KindIcon kind={kind} />{label}
        </button>
      ))}
      <div className="my-1 border-t border-line" />
      <button type="button" role="menuitem" onClick={() => { onExisting(); onClose(); }} className={item}><Search className="size-4 text-fg-muted" aria-hidden />Existing code…<kbd className="ml-auto text-xs text-fg-subtle">⌘K</kbd></button>
      <button type="button" role="menuitem" onClick={() => { onNote(); onClose(); }} className={item}><StickyNote className="size-4 text-warn" aria-hidden />Note</button>
      <p className="border-t border-line px-3 pt-1.5 pb-1 text-xs text-fg-subtle">Tip: double-click the canvas to add where you click, or drag from a node's dot onto empty space.</p>
    </Popover>
  );
}

export interface MenuItem { label: string; icon: LucideIcon; onSelect: () => void; hint?: string; danger?: boolean }

export function ContextMenu({ at, items, onClose }: { at: Point; items: MenuItem[]; onClose: () => void }) {
  return (
    <Popover at={at} label="Actions" onClose={onClose}>
      {items.map(({ label, icon: Icon, onSelect, hint, danger }) => (
        <button key={label} type="button" role="menuitem" onClick={() => { onSelect(); onClose(); }} className={`${item} ${danger ? "text-error" : ""}`}>
          <Icon className="size-4" aria-hidden />{label}{hint && <kbd className="ml-auto text-xs text-fg-subtle">{hint}</kbd>}
        </button>
      ))}
    </Popover>
  );
}
