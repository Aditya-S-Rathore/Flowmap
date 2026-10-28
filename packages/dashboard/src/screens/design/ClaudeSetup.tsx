import { Bot, CircleCheck, CircleX } from "lucide-react";
import { useApi } from "../../api";
import { Skeleton, card } from "../../components/ui";
import type { ClaudeStatus } from "../../types";

const PLUGIN = "claude plugin marketplace add <flowmap folder> && claude plugin install flowmap@flowmap";

/** Claude is optional; this shows what's missing and the exact fix. */
export function ClaudeSetup({ compact = false }: { compact?: boolean }) {
  const { data } = useApi<ClaudeStatus>("/api/claude");
  if (!data) return compact ? <Skeleton className="h-16 w-full" /> : null;
  const ready = !!data.version && data.signedIn;
  const rows: [boolean, string, string | undefined][] = [
    [!!data.version, data.version ? `Claude Code ${data.version}` : "Claude Code is not installed", data.version ? undefined : "https://claude.com/claude-code"],
    [data.signedIn, data.signedIn ? "Signed in" : "Not signed in", data.signedIn ? undefined : "claude   (run once and sign in)"],
    ...(compact ? [] : [[data.plugin, data.plugin ? "FlowMap plugin added (terminal sessions)" : "Optional: FlowMap plugin for terminal sessions", data.plugin ? undefined : PLUGIN] as [boolean, string, string | undefined]]),
  ];
  if (ready && !compact && data.plugin) return null;
  return (
    <section className={`${card} mb-6 p-4 text-sm`} aria-label="Claude setup">
      <p className="flex items-center gap-2 font-medium"><Bot className="size-4 text-accent" aria-hidden />{ready ? "Claude is ready" : "Set up Claude to design together"}</p>
      <ul className="mt-2 space-y-1.5">
        {rows.map(([ok, text, fix]) => (
          <li key={text} className="flex flex-wrap items-center gap-2">
            {ok ? <CircleCheck className="size-4 text-success" aria-hidden /> : <CircleX className="size-4 text-fg-subtle" aria-hidden />}
            <span className={ok ? "" : "text-fg-muted"}>{text}</span>
            {fix && <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{fix}</code>}
          </li>
        ))}
      </ul>
      {!ready && <p className="mt-2 text-xs text-fg-subtle">Everything else works without Claude: draw the design yourself, check its impact and export the RFC.</p>}
    </section>
  );
}
