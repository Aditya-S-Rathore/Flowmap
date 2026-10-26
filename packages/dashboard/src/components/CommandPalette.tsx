import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { enc, get } from "../api";
import type { NodeKind, SearchHit } from "../types";
import { KIND, KindIcon } from "./kind";
import { exploreHref } from "./refs";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(() => {
      get<SearchHit[]>(`/api/search?q=${enc(q)}&limit=40`).then(
        (h) => { if (live) { setHits(h); setError(undefined); } },
        (e: Error) => live && setError(e.message),
      );
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [q, open]);

  const kinds = (Object.keys(KIND) as NodeKind[]).filter((k) => hits.some((h) => h.kind === k));

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Search the graph" shouldFilter={false}
      overlayClassName="fixed inset-0 z-40 bg-black/30"
      contentClassName="fixed inset-x-4 top-24 z-50 mx-auto max-w-xl overflow-hidden rounded-xl border border-line bg-bg shadow-xl">
      <div className="flex items-center gap-2 border-b border-line px-4">
        <Search className="size-4 text-fg-subtle" aria-hidden />
        <Command.Input value={q} onValueChange={setQ} placeholder="Search screens, APIs, functions, tables…"
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle" />
        <kbd className="rounded border border-line px-1.5 text-xs text-fg-subtle">Esc</kbd>
      </div>
      <Command.List className="max-h-96 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-fg-muted">
          {error ? `Search failed: ${error}` : q ? `No matches for “${q}”` : "Type to search the index"}
        </Command.Empty>
        {kinds.map((k) => (
          <Command.Group key={k} heading={`${KIND[k].label}s`}>
            {hits.filter((h) => h.kind === k).map((h) => (
              <Command.Item key={h.id} value={h.id}
                onSelect={() => { location.hash = exploreHref(h.id); onOpenChange(false); }}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted">
                <KindIcon kind={h.kind} />
                <span className="max-w-xs shrink-0 truncate font-medium">{h.name}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-fg-subtle">{h.repo}{h.file && `/${h.file}`}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
