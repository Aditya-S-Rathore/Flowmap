import { OctagonAlert, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Severity } from "../types";

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-line p-8 text-center">
      <OctagonAlert className="size-6 text-error" aria-hidden />
      <div>
        <p className="font-medium">Couldn't load this view</p>
        <p className="mt-1 text-sm text-fg-muted">{error}</p>
      </div>
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-muted">
        <RefreshCw className="size-4" aria-hidden /> Retry
      </button>
    </div>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <Icon className="size-6 text-fg-subtle" aria-hidden />
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-fg-muted">{children}</div>}
    </div>
  );
}

export function SeverityBadge({ severity, children }: { severity: Severity; children?: ReactNode }) {
  const Icon = severity === "error" ? OctagonAlert : TriangleAlert;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${severity === "error" ? "bg-error-soft text-error" : "bg-warn-soft text-warn"}`}>
      <Icon className="size-3.5" aria-hidden />
      {children ?? (severity === "error" ? "Error" : "Warning")}
    </span>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "tx" }) {
  const cls = { neutral: "bg-muted text-fg-muted", accent: "bg-accent-soft text-accent", tx: "bg-tx text-warn" }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-fg-muted">{description}</p>
      </div>
      {children}
    </header>
  );
}

export const card = "rounded-lg border border-line bg-bg";
export const input = "rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm placeholder:text-fg-subtle";
