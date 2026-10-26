import { AppWindow, ArrowLeftRight, Braces, Cloud, Component, Database, Layers, Route, Shield, SquareFunction, Timer, type LucideIcon } from "lucide-react";
import type { NodeKind } from "../types";

export const KIND: Record<NodeKind, { label: string; icon: LucideIcon; color: string }> = {
  Route: { label: "Screen", icon: Route, color: "text-accent" },
  Component: { label: "Component", icon: Component, color: "text-accent" },
  ClientCall: { label: "Client call", icon: AppWindow, color: "text-fg-muted" },
  Operation: { label: "API", icon: ArrowLeftRight, color: "text-accent" },
  Schema: { label: "Schema", icon: Braces, color: "text-fg-muted" },
  Function: { label: "Function", icon: SquareFunction, color: "text-fg-muted" },
  Guard: { label: "Guard", icon: Shield, color: "text-success" },
  Table: { label: "Table", icon: Database, color: "text-table" },
  External: { label: "External", icon: Cloud, color: "text-external" },
  Job: { label: "Job", icon: Timer, color: "text-fg-muted" },
  Queue: { label: "Queue", icon: Layers, color: "text-fg-muted" },
};

export function KindIcon({ kind, className = "size-4" }: { kind: NodeKind; className?: string }) {
  const { icon: Icon, color } = KIND[kind];
  return <Icon className={`${className} ${color} shrink-0`} aria-hidden />;
}
