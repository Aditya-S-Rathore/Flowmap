import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A side panel that folds into a slim rail with an icon, so the canvas can take the room. */
export function Collapsible({ side, open, onOpenChange, label, icon: Icon, badge, children }: {
  side: "left" | "right"; open: boolean; onOpenChange: (open: boolean) => void; label: string; icon: LucideIcon; badge?: ReactNode; children: ReactNode;
}) {
  if (open) return <>{children}</>;
  return (
    <div className={`hidden w-11 shrink-0 flex-col items-center gap-3 border-line bg-bg py-2 md:flex ${side === "left" ? "border-r" : "border-l"}`}>
      <button type="button" onClick={() => onOpenChange(true)} aria-label={`Show ${label}`} title={`Show ${label}`}
        className="relative rounded-md p-1.5 text-fg-muted hover:bg-muted hover:text-fg">
        <Icon className="size-4" aria-hidden />
        {badge}
      </button>
      <span className="text-xs text-fg-subtle [writing-mode:vertical-rl]">{label}</span>
    </div>
  );
}

export function CollapseButton({ side, onClick, label }: { side: "left" | "right"; onClick: () => void; label: string }) {
  const Icon = side === "left" ? PanelLeftClose : PanelRightClose;
  return (
    <button type="button" onClick={onClick} aria-label={`Hide ${label}`} title={`Hide ${label}`} className="rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg">
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

export { PanelLeftOpen, PanelRightOpen };
