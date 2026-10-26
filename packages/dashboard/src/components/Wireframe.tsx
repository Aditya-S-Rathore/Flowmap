import type { ReactNode } from "react";

/** Browser-window frame around a screenshot. */
export function ScreenFrame({ path, children, className = "" }: { path: string; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-line bg-subtle shadow-sm ${className}`}>
      <div className="flex items-center gap-2 border-b border-line bg-bg px-3 py-2">
        <span className="flex gap-1" aria-hidden>{["bg-error/60", "bg-warn/60", "bg-success/60"].map((c) => <span key={c} className={`size-2 rounded-full ${c}`} />)}</span>
        <span className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-0.5 font-mono text-[0.6875rem] text-fg-muted">{path}</span>
      </div>
      {children}
    </div>
  );
}
