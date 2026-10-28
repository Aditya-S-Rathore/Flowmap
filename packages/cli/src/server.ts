import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BASELINE_FILE, CONFIG_NAMES, type NodeKind, type ServerEvent } from "@flowmap/core";
import type { Engine } from "./engine.ts";
import { Queries } from "./queries.ts";
import { MapQueries } from "./map.ts";
import { shotFile, type Variant } from "./shots.ts";
import { claudeStatus, deleteConversation, MODELS, newConversation, openConversation, runChat, stopChat } from "./chat.ts";
import { designFlow, designsDir, designView, importDesign, listDesigns, readDesign, saveDesign, SLUG, toMarkdown } from "./designs.ts";

const DIST = fileURLToPath(new URL("../../dashboard/dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};
const WATCH_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|graphql|gql)$/;
const WATCH_SKIP = /(^|[/\\])(node_modules|\.git|dist|build|coverage|\.flowmap)([/\\]|$)/;
const MAX_BODY = 512 * 1024;

export async function serveDashboard(engine: Engine, opts: { port: number; open: boolean; keepToken?: boolean; log: (s: string) => void }) {
  if (!existsSync(join(DIST, "index.html"))) throw new Error(`Dashboard is not built. Run: npm run build (in ${fileURLToPath(new URL("../../..", import.meta.url))})`);
  const q = new Queries(engine);
  const map = new MapQueries(q);
  // allow only the dashboard's own inline scripts (theme bootstrap), by hash
  const inline = [...readFileSync(join(DIST, "index.html"), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const csp = `default-src 'self'; script-src 'self' ${inline.join(" ")}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'`;
  // --keep-token (FlowMap development): reuse the token across restarts so the browser stays logged in
  const tokenFile = join(engine.ws.dir, ".flowmap", "dev-token");
  const saved = opts.keepToken && existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  const token = /^[a-f0-9]{48}$/.test(saved) ? saved : randomBytes(24).toString("hex");
  if (opts.keepToken) writeFileSync(tokenFile, token, { mode: 0o600 });
  const clients = new Set<ServerResponse>();
  let indexing = false;
  let capturing = false;

  const emit = (e: ServerEvent) => {
    for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  // live updates: debounce bursts of saves into one incremental index; config or baseline edits reload them first
  let timer: NodeJS.Timeout | null = null;
  let configChanged = false;
  const watchAll = () => [...new Set([engine.ws.dir, ...engine.ws.config.repos.map((r) => r.path)])].map((dir) =>
    watch(dir, { recursive: true }, (_ev, file) => {
      if (!file || WATCH_SKIP.test(file)) return;
      const config = CONFIG_NAMES.includes(file) || file === BASELINE_FILE;
      if (!config && !WATCH_EXT.test(file)) return;
      configChanged ||= config;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reindex, 250);
    }));
  let watchers = watchAll();

  // designs are edited from here and by Claude (MCP, another process): tell open dashboards about every save
  mkdirSync(designsDir(engine.ws), { recursive: true });
  const designTimers = new Map<string, NodeJS.Timeout>();
  const designWatcher = watch(designsDir(engine.ws), (_ev, file) => {
    const slug = file?.endsWith(".json") ? file.slice(0, -5) : "";
    if (!SLUG.test(slug)) return;
    clearTimeout(designTimers.get(slug));
    designTimers.set(slug, setTimeout(() => {
      designTimers.delete(slug);
      try {
        emit({ type: "design", slug, version: readDesign(engine.ws, slug).version });
      } catch {}       // deleted or half-edited by hand: nothing to show
    }, 100));
  });

  const reindex = async () => {
    indexing = true;
    emit({ type: "indexing", phase: "updating" });
    try {
      if (configChanged) {
        configChanged = false;
        const s = await engine.reload();
        watchers.forEach((w) => w.close());
        watchers = watchAll();
        emit({ type: "updated", files: s ? s.changed + s.removed : 0, durationMs: s?.durationMs ?? 0, config: true });
        opts.log(`config reloaded${s ? `, re-indexed in ${s.durationMs} ms` : ""}`);
        return;
      }
      const s = engine.refresh();
      if (s.changed || s.removed) emit({ type: "updated", files: s.changed + s.removed, durationMs: s.durationMs });
      opts.log(`index updated: ${s.changed + s.removed} file(s) in ${s.durationMs} ms`);
    } catch (err: any) {
      emit({ type: "error", message: String(err.message ?? err) });
      opts.log(`update failed: ${err.message ?? err}`);
    } finally {
      indexing = false;
    }
  };

  const authed = (req: IncomingMessage) => {
    const cookie = /(?:^|;\s*)flowmap_token=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
    return !!cookie && cookie.length === token.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
  };

  const api = (path: string, p: URLSearchParams): unknown => {
    const id = (s: string) => decodeURIComponent(s);
    let m: RegExpExecArray | null;
    if (path === "/api/status") return q.status(indexing);
    if (path === "/api/overview") return q.overview(indexing);
    if (path === "/api/search") return q.search(p.get("q") ?? "", p.get("kind")?.split(",").filter(Boolean) as NodeKind[] | undefined, Number(p.get("limit") ?? 20));
    if ((m = /^\/api\/graph\/(.+)$/.exec(path))) return q.subgraph(id(m[1]), p.get("dir") === "up" ? "up" : "down", Math.min(Number(p.get("depth") ?? 2), 6), p.get("sideEffects") === "1", 150, Math.min(Number(p.get("limit") ?? 40), 100));
    if ((m = /^\/api\/explain\/(.+)$/.exec(path))) return q.explain(id(m[1]));
    if (path === "/api/issues") {
      const filters = Object.fromEntries(["rule", "severity", "status", "repo", "q"].map((k) => [k, p.get(k) || undefined]));
      const issues = q.issues(filters);
      return { issues, summary: q.summary(issues) };
    }
    if (path === "/api/rules") return q.rules();
    if (path === "/api/map") return map.appMap();
    if (path === "/api/architecture") return map.architecture();
    if (path === "/api/suggestions") return map.suggestions();
    if ((m = /^\/api\/flow\/(.+)$/.exec(path))) return map.flow(id(m[1]), p.get("mode") === "compact" ? "compact" : "full");
    if ((m = /^\/api\/wireframe\/(.+)$/.exec(path))) return map.wireframe(id(m[1]), Math.min(Number(p.get("depth") ?? 6), 8));
    if ((m = /^\/api\/spots\/(.+)$/.exec(path))) return map.shotSpots(id(m[1]), variant(p.get("variant")));
    if (path === "/api/tables") return q.tables();
    if (path === "/api/changes") return q.changes(p.get("base") || undefined);
    if (path === "/api/designs") return listDesigns(engine.ws);
    if ((m = /^\/api\/designs\/([^/]+)$/.exec(path))) return designView(q, m[1]);
    if ((m = /^\/api\/designs\/([^/]+)\/flow$/.exec(path))) return designFlow(q, map, readDesign(engine.ws, m[1]), p.get("mode") === "full" ? "full" : "compact");
    return undefined;
  };

  const server = createServer((req, res) => {
    if (process.env.FLOWMAP_DEBUG) {
      const t = Date.now();
      opts.log(`→ ${req.method} ${req.url?.replace(/token=\w+/, "token=…")}`);
      res.on("finish", () => opts.log(`${req.method} ${req.url?.replace(/token=\w+/, "token=…")} ${res.statusCode} ${Date.now() - t}ms`));
    }
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) return send(res, 403, "Forbidden host");
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (url.searchParams.get("token") === token) {
      res.writeHead(302, { "Set-Cookie": `flowmap_token=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/" });
      return res.end();
    }
    if (!authed(req)) return send(res, 401, "Open the link printed by `flowmap dev` (it carries a one-time session token).");
    // the one write: capture a screenshot of a screen (writes only into .flowmap/). Same-origin + custom header against CSRF.
    const capture = /^\/api\/capture\/(.+)$/.exec(url.pathname);
    if (capture && req.method === "POST") {
      if (req.headers.origin !== `http://${host}` || req.headers["x-flowmap"] !== "1") return send(res, 403, "Forbidden");
      if (capturing) return send(res, 409, "A capture is already running");
      const routeId = decodeURIComponent(capture[1]);
      const v = variant(url.searchParams.get("variant"));
      capturing = true;
      import("./shots.ts").then(({ captureScreens, readShots }) =>
        captureScreens(engine, { ids: [routeId], mobile: v.startsWith("mobile"), dark: v.endsWith("dark"), log: opts.log }).then(() => {
          const e = readShots(engine.ws)[routeId]?.[v];
          emit({ type: "shot", id: routeId, ok: !!e?.ok, ...(e?.note ? { note: e.note } : {}) });
        }))
        .catch((err) => emit({ type: "shot", id: routeId, ok: false, note: String(err.message ?? err) }))
        .finally(() => { capturing = false; });
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    // designs: save an edit (/api/designs/<slug>), import a shared one (/api/designs), or ask Claude (/api/designs/<slug>/chat).
    // Writes only into .flowmap/designs; Claude runs locally with read-only code access plus FlowMap's design tools.
    const design = /^\/api\/designs(?:\/([^/]+)(\/chat)?)?$/.exec(url.pathname);
    if (design && req.method === "POST") {
      if (req.headers.origin !== `http://${host}` || req.headers["x-flowmap"] !== "1") return send(res, 403, "Forbidden");
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, "Send JSON");
      return readBody(req).then((raw) => {
        const body = JSON.parse(raw);
        const [, slug, chat] = design;
        let out: unknown;
        if (chat) {
          if (body.cancel === true) out = { stopped: stopChat(slug) };
          else if (body.new === true) { newConversation(engine, slug); out = {}; }
          else if (typeof body.open === "string") { openConversation(engine, slug, body.open); out = {}; }
          else if (typeof body.remove === "string") { deleteConversation(engine, slug, body.remove); out = {}; }
          else {
            if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 20_000) return send(res, 400, "Send { text } (up to 20,000 characters)");
            if (body.mode !== undefined && body.mode !== "full" && body.mode !== "design") return send(res, 400, 'mode must be "full" or "design"');
            if (body.model !== undefined && body.model !== "" && !MODELS.includes(body.model)) return send(res, 400, `model must be one of: ${MODELS.join(", ")}`);
            runChat(engine, slug, body.text, body.mode ?? "design", emit, opts.log, body.model || undefined);
            out = {};
          }
        } else {
          const saved = slug ? { slug, design: saveDesign(engine.ws, slug, body, "user") } : importDesign(engine.ws, body);
          out = { slug: saved.slug, version: saved.design.version };
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      }).catch((err) => send(res, err.status ?? 400, String(err.message ?? err)));
    }
    if (req.method !== "GET") return send(res, 405, "Method not allowed");

    let m0: RegExpExecArray | null;
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if ((m0 = /^\/api\/shot\/(.+)$/.exec(url.pathname))) {
      const file = shotFile(engine.ws, decodeURIComponent(m0[1]), variant(url.searchParams.get("variant")));
      if (!file) return send(res, 404, "No screenshot");
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(readFileSync(file));
    }
    if (url.pathname === "/api/claude") {
      return claudeStatus().then((s) => {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(s));
      });
    }
    if ((m0 = /^\/api\/designs\/([^/]+)\/export$/.exec(url.pathname))) {
      try {
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        return res.end(toMarkdown(designView(q, m0[1])));
      } catch (err: any) {
        return send(res, err.status ?? 400, String(err.message ?? err));
      }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        const body = api(url.pathname, url.searchParams);
        if (body === undefined) return send(res, 404, "Not found");
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify(body));
      } catch (err: any) {
        return send(res, err.status ?? 400, String(err.message ?? err));
      }
    }

    // static dashboard files, never outside dist/
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = normalize(join(DIST, rel));
    if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": csp });
    res.end(readFileSync(file));
  });

  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(opts.port, "127.0.0.1", resolve));
  const link = `http://127.0.0.1:${opts.port}/?token=${token}`;
  opts.log(`FlowMap dashboard: ${link}`);
  if (opts.open) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [link], { stdio: "ignore", detached: true }).unref();
  return {
    close() {
      watchers.forEach((w) => w.close());
      designWatcher.close();
      designTimers.forEach((t) => clearTimeout(t));
      if (timer) clearTimeout(timer);
      clients.forEach((c) => c.end());
      server.close();
    },
  };
}

const variant = (v: string | null): Variant => (v === "mobile" || v === "desktop-dark" || v === "mobile-dark" ? v : "desktop");

/** Request body as text, refused past MAX_BODY. */
function readBody(req: IncomingMessage): Promise<string> {
  const tooLarge = Object.assign(new Error("Too large"), { status: 413 });
  if (Number(req.headers["content-length"]) > MAX_BODY) return Promise.reject(tooLarge);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(tooLarge);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
