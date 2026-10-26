import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Issue } from "../types";
import { KIND, KindIcon } from "./kind";
import { EditorLink, exploreHref } from "./refs";
import { Pill, SeverityBadge } from "./ui";

function PathChain({ steps }: { steps: Issue["path"] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Path proof">
      {steps.map((s, i) => (
        <li key={`${s.id}-${i}`} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-4 text-fg-subtle" aria-hidden />}
          <a href={exploreHref(s.id)} title={`${KIND[s.kind].label} · ${s.repo}/${s.file}${s.line ? `:${s.line}` : ""}`}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:border-accent hover:text-accent ${i === steps.length - 1 ? "border-line-strong bg-muted font-medium" : "border-line bg-bg"}`}>
            <KindIcon kind={s.kind} className="size-3.5" />
            {s.name}
          </a>
        </li>
      ))}
    </ol>
  );
}

export function IssueRow({ issue, compact = false }: { issue: Issue; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-subtle">
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={issue.severity} />
            <span className="text-sm font-medium">{issue.ruleTitle}</span>
            {issue.status === "new" ? <Pill tone="accent">New</Pill> : <Pill>Baseline</Pill>}
          </div>
          <p className={`mt-1 text-sm text-fg-muted ${open ? "" : "truncate"}`}>{issue.message}</p>
        </div>
        {!compact && <span className="hidden shrink-0 font-mono text-xs text-fg-subtle md:block">{issue.nodeName}</span>}
      </button>
      {open && (
        <div className="space-y-4 px-4 pb-4 pl-11">
          <EditorLink repo={issue.repo} file={issue.file} line={issue.line} />
          <div className={compact ? "space-y-3" : "grid gap-4 md:grid-cols-2"}>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Why it matters</h4>
              <p className="mt-1 text-sm">{issue.why}</p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">How to fix</h4>
              <p className="mt-1 text-sm">{issue.fix}</p>
            </div>
          </div>
          {issue.path.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Path proof</h4>
              <PathChain steps={issue.path} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
