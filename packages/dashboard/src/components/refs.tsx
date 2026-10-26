import { ExternalLink } from "lucide-react";
import { enc } from "../api";
import { useApp } from "../context";
import type { Ref } from "../types";
import { KindIcon } from "./kind";

export const exploreHref = (id: string) => `#/explore/${enc(id)}`;
export const mapHref = (id: string) => `#/map/${enc(id)}`;

/** "Open in editor" link; renders plain text for virtual nodes (no file) or unknown repos. */
export function EditorLink({ repo, file, line, className = "" }: { repo: string; file: string; line: number; className?: string }) {
  const { status, editor } = useApp();
  if (!file) return null;
  const root = status?.repos.find((r) => r.name === repo)?.path;
  const text = `${repo}/${file}${line ? `:${line}` : ""}`;
  const cls = `inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-xs text-fg-subtle ${className}`;
  if (!root) return <span className={cls}><span className="truncate">{text}</span></span>;
  const name = editor === "cursor" ? "Cursor" : "VS Code";
  return (
    <a href={`${editor}://file/${root}/${file}:${line || 1}`} title={`Open in ${name}`} aria-label={`Open ${text} in ${name}`}
      className={`${cls} hover:text-accent hover:underline`} onClick={(e) => e.stopPropagation()}>
      <span className="truncate">{text}</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

export function RefList({ refs, empty }: { refs: Ref[]; empty: string }) {
  if (!refs.length) return <p className="text-sm text-fg-subtle">{empty}</p>;
  return (
    <ul className="space-y-1">
      {refs.map((r, i) => (
        <li key={`${r.id}-${i}`} className="rounded-md px-2 py-1.5 hover:bg-muted">
          <a href={exploreHref(r.id)} className="flex items-center gap-2 text-sm font-medium hover:text-accent">
            <KindIcon kind={r.kind} />
            <span className="truncate">{r.name}</span>
            {r.detail && <span className="ml-auto shrink-0 font-mono text-xs font-normal text-fg-subtle">{r.detail}</span>}
          </a>
          <div className="pl-6"><EditorLink repo={r.repo} file={r.file} line={r.line} /></div>
        </li>
      ))}
    </ul>
  );
}
