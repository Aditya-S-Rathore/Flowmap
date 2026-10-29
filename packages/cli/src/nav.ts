import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent } from "@flowmap/core";
import type { Engine } from "./engine.ts";
import { Queries } from "./queries.ts";
import { REF } from "./refs.ts";

/**
 * Moving the dashboard from outside it. The MCP tools (called from your editor chat, or from the dashboard's own Agent) write the
 * place to go into `.flowmap/nav.json`; the running `flowmap dev` sees the file and tells the open dashboards to go there.
 * Only a checked place is ever written or read: a route is built from validated pieces, never copied from what an AI wrote.
 */
export type Nav = Extract<ServerEvent, { type: "ui" }>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PAGES = ["overview", "map", "explore", "issues", "rules", "changes", "tables", "designs"];
const FRESH_MS = 10_000;           // a place written long ago (a dashboard that was not running) is not followed when it starts

export interface PageArgs { page: string; target?: string; slug?: string; base?: string; head?: string; rule?: string; severity?: string; search?: string }

/** The route for "take me to a page", or null when the page is not one of ours. */
export function pageNav(engine: Engine, a: PageArgs): Nav | null {
  if (!PAGES.includes(a.page)) return null;
  const query = new URLSearchParams();
  const put = (k: string, v: string | undefined, ok: boolean) => { if (ok && v) query.set(k, v); };
  if (a.page === "changes") { put("base", a.base, REF.test(a.base ?? "")); put("head", a.head, REF.test(a.head ?? "")); }
  if (a.page === "issues") { put("rule", a.rule, /^[a-z0-9-]{1,40}$/.test(a.rule ?? "")); put("severity", a.severity, ["error", "warn"].includes(a.severity ?? "")); put("q", a.search?.slice(0, 80), true); }
  const node = a.page === "explore" && a.target ? new Queries(engine).resolve(a.target) : null;
  const slug = a.page === "designs" && SLUG.test(a.slug ?? "") ? a.slug : "";
  const path = node ? `explore/${encodeURIComponent(node.id)}` : slug ? `designs/${slug}` : a.page;
  return { type: "ui", action: "page", id: query.size ? `${path}?${query}` : path };
}

const file = (engine: Engine) => join(engine.ws.dir, ".flowmap", "nav.json");

/** Asks the running dashboard to go somewhere. Harmless when none is running. */
export function sendNav(engine: Engine, nav: Nav) {
  mkdirSync(join(engine.ws.dir, ".flowmap"), { recursive: true });
  writeFileSync(`${file(engine)}.tmp`, JSON.stringify({ nav, at: Date.now() }));
  renameSync(`${file(engine)}.tmp`, file(engine));
}

/** The place in nav.json if it is recent and well formed. */
export function readNav(engine: Engine): Nav | null {
  try {
    const { nav, at } = JSON.parse(readFileSync(file(engine), "utf8"));
    if (Date.now() - at > FRESH_MS || nav?.type !== "ui" || typeof nav.id !== "string" || nav.id.length > 600 || /[\u0000-\u001f]/.test(nav.id)) return null;
    if (nav.action === "design") return SLUG.test(nav.id) ? { type: "ui", action: "design", id: nav.id } : null;
    if (nav.action === "flow") return { type: "ui", action: "flow", id: nav.id };
    if (nav.action === "page" && /^[a-z]+(\/[^?]*)?(\?[A-Za-z0-9=&%._~-]*)?$/.test(nav.id) && PAGES.includes(nav.id.split(/[/?]/)[0])) return { type: "ui", action: "page", id: nav.id };
  } catch { /* no file, or half-written */ }
  return null;
}
