import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig, ScreenshotConfig, Workspace } from "@flowmap/core";
import type { Engine } from "./engine.ts";

/**
 * Opt-in screenshots of each screen, taken from the app the user already runs locally (e.g. `npm start`).
 * Read-only: FlowMap only opens pages, never clicks or types. While capturing, every request that could change data
 * is blocked (POST/PUT/PATCH/DELETE, GraphQL mutations, beacons) unless listed in `screenshots.allow`.
 *
 * Sign-in works the same for any app: the user signs in once in a FlowMap-only browser (`--login`). FlowMap keeps
 * that browser's profile (.flowmap/browser) and a copy of its sign-in state (all cookies, including session-only ones,
 * and sessionStorage), puts the state back before each capture, and saves the latest state after (rotated tokens).
 */

export type Variant = "desktop" | "desktop-dark" | "mobile" | "mobile-dark";

/** Where a button, link, input or form is on the screenshot (page pixels), and its visible text. */
export interface RawSpot { x: number; y: number; w: number; h: number; kind: string; text: string; href?: string }

export interface ShotEntry {
  at: string;
  url: string;
  ok: boolean;              // false: redirected (e.g. to sign-in), error status, or failed to load
  note?: string;
  file?: string;
  width: number;            // page size the image and spots are in
  height: number;
  spots?: RawSpot[];
  blocked?: number;         // write requests the page tried and FlowMap blocked
}

type Index = Record<string, Partial<Record<Variant, ShotEntry>>>;

/** The browser's sign-in state: cookies (session-only ones included) and sessionStorage per app origin. */
interface SignIn { at: string; cookies: unknown[]; session: Record<string, [string, string][]> }

const dirOf = (ws: Workspace) => join(ws.dir, ".flowmap", "screens");
const profileOf = (ws: Workspace) => join(ws.dir, ".flowmap", "browser");
const signInFile = (ws: Workspace) => join(profileOf(ws), "flowmap-sign-in.json");
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/;
const SIGN_OUT = /log-?out|sign-?out/i;
const AUTH_PATH = /log-?in|sign-?(in|up)|auth|sso|password|register|verify|otp|mfa|invite|confirm/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readShots(ws: Workspace): Index {
  try {
    return JSON.parse(readFileSync(join(dirOf(ws), "index.json"), "utf8")).screens ?? {};
  } catch {
    return {};
  }
}

export function shotFile(ws: Workspace, routeId: string, variant: Variant = "desktop"): string | null {
  const e = readShots(ws)[routeId]?.[variant];
  const file = e?.ok && e.file ? join(dirOf(ws), e.file) : null;
  return file && existsSync(file) ? file : null;
}

/** Repos that have a screenshots URL (each frontend its own). */
export function screenshotRepos(ws: Workspace): (RepoConfig & { screenshots: ScreenshotConfig })[] {
  return ws.config.repos.filter((r): r is RepoConfig & { screenshots: ScreenshotConfig } => !!r.screenshots?.baseUrl);
}

function readSignIn(ws: Workspace): SignIn | null {
  try { return JSON.parse(readFileSync(signInFile(ws), "utf8")); } catch { return null; }
}

function writeSignIn(ws: Workspace, state: SignIn) {
  writeFileSync(signInFile(ws), JSON.stringify(state), { mode: 0o600 });
}

/** localhost, or a dev hostname that points to this machine (e.g. local.app.example.com in /etc/hosts). */
async function isLocal(hostname: string) {
  if (LOCAL.test(hostname)) return true;
  try {
    const addrs = await lookup(hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => /^127\.|^::1$|^::ffff:127\./.test(a.address));
  } catch {
    return false;
  }
}

const BROWSERS = [
  process.env.FLOWMAP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const isParam = (seg: string) => /^(:|\[|\$|\{)/.test(seg);
const isOptional = (seg: string) => seg.endsWith("?") || seg.startsWith("[[");

/** URL path for a screen, with :params filled from the config; null when a required param has no sample value. */
export function screenUrl(path: string, params: Record<string, string>): string | null {
  const parts: string[] = [];
  for (const seg of path.split("/").filter(Boolean)) {
    if (seg === "*" || seg.startsWith("[...") || seg.startsWith("[[...")) return null;
    if (!isParam(seg)) { parts.push(seg); continue; }
    const name = /^(?::|\[\[?|\$|\{)(\w+)/.exec(seg)?.[1] ?? "";
    if (params[name] !== undefined) parts.push(encodeURIComponent(params[name]));
    else if (isOptional(seg)) continue;
    else return null;
  }
  return "/" + parts.join("/");
}

/** A link on a captured page that fits a screen with params: /projects/:id ← "/projects/123". */
export function sampleFromLinks(path: string, links: string[]): string | null {
  const want = path.split("/").filter(Boolean);
  const required = want.filter((s) => !isOptional(s)).length;
  for (const href of links) {
    const have = href.split(/[?#]/)[0].split("/").filter(Boolean);
    if (have.length < required || have.length > want.length) continue;
    if (want.every((s, i) => (isParam(s) ? have[i] !== undefined || isOptional(s) : s === have[i]))) return "/" + have.join("/");
  }
  return null;
}

/** GraphQL operations in a request body, with their kind and name (operationName, else the first root field). */
function graphqlOps(body: string | undefined): { kind: "query" | "mutation" | "other"; name: string }[] | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const ops = Array.isArray(parsed) ? parsed : [parsed];
    if (!ops.length || !ops.every((op) => typeof op?.query === "string")) return null;
    return ops.map((op) => {
      const q = op.query.replace(/#[^\n]*/g, "");
      const kind = /^\s*(query\b|\{)/.test(q) && !/\bmutation\b/.test(q) ? "query" : /^\s*mutation\b/.test(q) ? "mutation" : "other";
      const field = /^\s*\w*\s*\w*\s*(?:\([^)]*\))?\s*\{\s*(\w+)/.exec(q)?.[1] ?? "";
      return { kind, name: op.operationName || field };
    });
  } catch {
    return null;
  }
}

/**
 * Whether a request may go through while capturing: anything that only reads, plus what the config allows:
 * a URL part ("/api/auth/refresh") or a GraphQL operation name ("refreshToken").
 * GraphQL over POST is allowed when every operation is a query or an allowed name.
 */
export function isReadOnly(method: string, body: string | undefined, url = "", allow: string[] = []): boolean {
  if (/^(GET|HEAD|OPTIONS)$/i.test(method)) return true;
  if (allow.some((a) => a.includes("/") && url.includes(a))) return true;
  if (!/^POST$/i.test(method)) return false;
  const ops = graphqlOps(body);
  return !!ops && ops.every((op) => op.kind === "query" || allow.includes(op.name));
}

/** A short name for a blocked request, so the summary can say what was blocked: "mutation refreshToken", "POST /ingest". */
function describe(method: string, url: string, body: string | undefined) {
  const ops = graphqlOps(body);
  if (ops) return ops.map((o) => `${o.kind} ${o.name}`).join(", ");
  try { return `${method} ${new URL(url).pathname}`; } catch { return `${method} ${url}`; }
}

/** Buttons, links, inputs on the page, with positions in page pixels (runs in the page; reads only). */
const SPOTS_SCRIPT = `(() => {
  const out = [];
  const sel = 'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],input:not([type=hidden]),select,textarea';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
    const tag = el.tagName.toLowerCase(), role = el.getAttribute("role"), type = (el.getAttribute("type") || "").toLowerCase();
    const kind = tag === "a" || role === "link" ? "link" : tag === "select" ? "select" : tag === "textarea" || (tag === "input" && !/checkbox|radio|submit|button/.test(type)) ? "input" : /checkbox|radio/.test(type) ? "checkbox" : "button";
    const text = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("value") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    out.push({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), kind, text, href: tag === "a" ? el.getAttribute("href") || undefined : undefined });
    if (out.length >= 400) break;
  }
  const password = [...document.querySelectorAll("input[type=password]")].some((el) => el.getBoundingClientRect().width > 0);
  return { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, path: location.pathname, password, spots: out };
})()`;

const SIZES = { desktop: { width: 1280, height: 800, mobile: false }, mobile: { width: 390, height: 844, mobile: true } };

/** A DevTools-protocol connection: request/response, event listeners, wait-for-event. */
async function connect(url: string) {
  const sock = new WebSocket(url);
  await new Promise((r, j) => { sock.addEventListener("open", r); sock.addEventListener("error", j); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const listeners: ((method: string, params: any) => void)[] = [];
  sock.addEventListener("message", (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d.result ?? { error: d.error }); pending.delete(d.id); }
    if (d.method) listeners.forEach((l) => l(d.method, d.params));
  });
  return {
    send: (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); }),
    on: (l: (method: string, params: any) => void) => listeners.push(l),
    once: (method: string, ms: number) => new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); listeners.splice(listeners.indexOf(l), 1); resolve(); };
      const l = (m: string) => { if (m === method) done(); };
      const t = setTimeout(done, ms);
      listeners.push(l);
    }),
    close: () => sock.close(),
  };
}

/** A browser on FlowMap's own profile (.flowmap/browser). */
async function openBrowser(ws: Workspace, opts: { headless: boolean; local: boolean; urls?: string[]; size?: { width: number; height: number } }) {
  const browser = BROWSERS.find((x) => x && existsSync(x));
  if (!browser) throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or set FLOWMAP_CHROME to its path.");
  mkdirSync(profileOf(ws), { recursive: true });
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(browser, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileOf(ws)}`, "--no-first-run", "--no-default-browser-check",
    // local dev servers often use a self-signed HTTPS certificate; accepted only for hosts on this machine
    ...(opts.local ? ["--ignore-certificate-errors"] : []),
    ...(opts.headless ? ["--headless=new", "--hide-scrollbars", `--window-size=${opts.size!.width},${opts.size!.height}`] : ["--new-window"]),
    ...(opts.urls?.length ? opts.urls : ["about:blank"]),
  ], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const pages = async () => ((await (await fetch(`${base}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]).filter((t) => t.type === "page");
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(200);
    if (proc.exitCode !== null) throw new Error("The browser closed right away. Is a FlowMap browser window (from --login) still open? Close it and try again.");
    try { ready = (await pages()).length > 0; } catch { /* not up yet */ }
  }
  if (!ready) throw new Error("Could not start the browser.");
  const browserTarget = async () => connect(((await (await fetch(`${base}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  // close the normal way, so the profile keeps the latest cookies (force-quitting can lose rotated tokens)
  const close = async () => {
    const exited = new Promise((r) => proc.once("exit", r));
    try { void (await browserTarget()).send("Browser.close"); } catch { /* already gone */ }
    if (await Promise.race([exited.then(() => true), sleep(8000).then(() => false)])) return;
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
  };
  return { proc, pages, browserTarget, close };
}

/** The browser's current sign-in state for the given app origins. */
async function snapshot(b: Awaited<ReturnType<typeof openBrowser>>, origins: string[], previous?: SignIn | null): Promise<SignIn> {
  const target = await b.browserTarget();
  const { cookies = [] } = await target.send("Storage.getCookies");
  target.close();
  const session: SignIn["session"] = { ...previous?.session };
  for (const p of await b.pages()) {
    let origin = "";
    try { origin = new URL(p.url).origin; } catch { continue; }
    if (!origins.includes(origin)) continue;
    const page = await connect(p.webSocketDebuggerUrl);
    const r = await page.send("Runtime.evaluate", { expression: "JSON.stringify(Object.entries(sessionStorage))", returnByValue: true });
    page.close();
    if (typeof r?.result?.value === "string") session[origin] = JSON.parse(r.result.value);
  }
  return { at: new Date().toISOString(), cookies, session };
}

/** `--login`: a visible FlowMap browser on each app; the user signs in and closes it; the sign-in state is kept. */
export async function loginBrowser(engine: Engine, log: (s: string) => void) {
  const repos = screenshotRepos(engine.ws);
  if (!repos.length) throw new Error('Add screenshots: { baseUrl: "http://localhost:3000" } to the frontend\'s flowmap.config.mjs first.');
  const urls = repos.map((r) => r.screenshots.baseUrl);
  const origins = urls.map((u) => new URL(u).origin);
  const local = (await Promise.all(urls.map((u) => isLocal(new URL(u).hostname)))).every(Boolean);
  const b = await openBrowser(engine.ws, { headless: false, local, urls });
  log(`A FlowMap browser window opened on ${urls.join(", ")}.\nSign in as you normally do (a test account is best), then close the window. FlowMap doesn't type or click anything.`);
  // keep the latest state while the window is open: session-only cookies and sessionStorage end with the window
  let state: SignIn | null = null;
  for (;;) {
    await sleep(1500);
    if (b.proc.exitCode !== null) break;
    try {
      if (!(await b.pages()).length) break;
      state = await snapshot(b, origins, state);
    } catch { break; }
  }
  if (state) writeSignIn(engine.ws, state);
  await b.close();
  log(state ? "Saved. `flowmap screenshots` will now open pages signed in. Run it with --login again when the session expires." : "The window closed before FlowMap could save the sign-in. Run --login again and close the window only after signing in.");
}

export async function captureScreens(engine: Engine, opts: { only?: string; ids?: string[]; mobile?: boolean; dark?: boolean; changed?: boolean; log: (s: string) => void }) {
  const ws = engine.ws;
  const repos = screenshotRepos(ws);
  if (!repos.length) throw new Error('Add screenshots: { baseUrl: "http://localhost:3000" } to the frontend\'s flowmap.config.mjs and start your app.');
  for (const r of repos) {
    const host = new URL(r.screenshots.baseUrl).hostname;
    if (!(await isLocal(host)) && !r.screenshots.allowRemote) {
      throw new Error(`${r.name}: ${host} is not on this machine. Screenshots open every page of the app, so they only run against a local or staging app you choose: add allowRemote: true to its screenshots settings if this is intended.`);
    }
  }
  const variant = `${opts.mobile ? "mobile" : "desktop"}${opts.dark ? "-dark" : ""}` as Variant;
  const index = readShots(ws);
  const g = engine.graph;
  // --changed: only screens whose UI code changed after their last capture
  const sourceTime = (routeId: string) => {
    const repo = g.nodes.get(routeId)?.repo ?? "";
    const files = engine.store.files(repo);
    const seen = g.walk(routeId, (id) => g.outEdges(id, ["renders", "calls"]).filter((e) => e.dst && g.nodes.get(e.dst)?.repo === repo), 12);
    return Math.max(0, ...[...seen.keys()].map((id) => files.get(g.nodes.get(id)?.file ?? "")?.mtime ?? 0));
  };
  const dir = dirOf(ws);
  mkdirSync(dir, { recursive: true });
  let signIn = readSignIn(ws);
  let done = 0, skipped = 0, blockedTotal = 0, toSignIn = 0, tried = 0;
  const blockedKinds = new Map<string, number>();

  for (const repo of repos) {
    const cfg = repo.screenshots;
    const base = new URL(cfg.baseUrl);
    const size = opts.mobile ? SIZES.mobile : { ...SIZES.desktop, width: cfg.width ?? 1280, height: cfg.height ?? 800 };
    // plain paths first, so their links can provide sample ids for screens like /projects/:id
    const screens = [...g.nodes.values()]
      .filter((n) => n.kind === "Route" && n.repo === repo.name && n.name.startsWith("/") && (!opts.ids || opts.ids.includes(n.id)) && (!opts.only || n.name.includes(opts.only)))
      .filter((n) => !opts.changed || !index[n.id]?.[variant] || sourceTime(n.id) > Date.parse(index[n.id]![variant]!.at))
      .sort((a, b) => Number(a.name.split("/").some(isParam)) - Number(b.name.split("/").some(isParam)));
    if (!screens.length) continue;

    const b = await openBrowser(ws, { headless: true, local: await isLocal(base.hostname), size });
    try {
      const page = await connect((await b.pages())[0].webSocketDebuggerUrl);
      let docStatus = 0, blocked = 0;
      page.on((method, params) => {
        if (method === "Fetch.requestPaused") {
          // the read-only guard
          const { requestId, request } = params;
          if (isReadOnly(request.method, request.postData, request.url, cfg.allow)) void page.send("Fetch.continueRequest", { requestId });
          else {
            blocked++;
            const what = describe(request.method, request.url, request.postData);
            blockedKinds.set(what, (blockedKinds.get(what) ?? 0) + 1);
            void page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
          }
        }
        if (method === "Network.responseReceived" && params.type === "Document") docStatus = params.response.status;
      });
      await page.send("Page.enable");
      await page.send("Network.enable");
      // put back the sign-in from --login (or the last run): cookies, including session-only ones, and sessionStorage
      if (signIn?.cookies.length) await page.send("Network.setCookies", { cookies: signIn.cookies });
      const stored = signIn?.session[base.origin];
      if (stored?.length) {
        await page.send("Page.addScriptToEvaluateOnNewDocument", {
          source: `if (location.origin === ${JSON.stringify(base.origin)} && !sessionStorage.getItem("__flowmap")) { for (const [k, v] of ${JSON.stringify(stored)}) sessionStorage.setItem(k, v); sessionStorage.setItem("__flowmap", "1"); }`,
        });
      }
      await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      // the variant decides the theme, not the machine's own setting
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: opts.dark ? "dark" : "light" }] });
      // reachable at all? one clear message instead of one failure per screen
      const probe = page.once("Page.loadEventFired", 15_000);
      const first = await page.send("Page.navigate", { url: base.href });
      if (first?.errorText) throw new Error(`Can't open ${base.href} (${first.errorText}). Start your app (e.g. npm start) and check screenshots.baseUrl — it must match the URL you open in the browser, including https and the host name.`);
      await probe;

      const links = new Set<string>();
      for (const s of screens) {
        // opening a sign-out page would end the saved session for every page after it
        if (SIGN_OUT.test(s.name)) { skipped++; opts.log(`  – ${s.name}  skipped (sign-out page)`); continue; }
        const path = screenUrl(s.name, cfg.params ?? {}) ?? sampleFromLinks(s.name, [...links]);
        if (!path) {
          skipped++;
          (index[s.id] ??= {})[variant] = { at: new Date().toISOString(), url: "", ok: false, width: size.width, height: size.height, note: "No sample id: no captured page links to it. Add one to screenshots.params." };
          opts.log(`  – ${s.name}  no sample id (add one to screenshots.params)`);
          continue;
        }
        tried++;
        const url = new URL(path, base).href;
        docStatus = 0;
        blocked = 0;
        const loaded = page.once("Page.loadEventFired", 15_000);
        const nav = await page.send("Page.navigate", { url });
        await loaded;
        await sleep(cfg.wait ?? 1500);
        const entry: ShotEntry = { at: new Date().toISOString(), url, ok: true, width: size.width, height: size.height };
        const info = (await page.send("Runtime.evaluate", { expression: SPOTS_SCRIPT, returnByValue: true }))?.result?.value as { width: number; height: number; path: string; password: boolean; spots: RawSpot[] } | undefined;
        const wanted = new URL(url).pathname.replace(/\/$/, "") || "/";
        const landed = info?.path?.replace(/\/$/, "") || "/";
        if (nav?.errorText) Object.assign(entry, { ok: false, note: `Couldn't load (${nav.errorText}).` });
        else if (docStatus >= 400) Object.assign(entry, { ok: false, note: `The page answered HTTP ${docStatus}.` });
        else if (info && (landed !== wanted || (info.password && !AUTH_PATH.test(wanted)))) {
          // sent elsewhere, or a sign-in form shown in place of the page (any app: a password field where none belongs)
          const toAuth = AUTH_PATH.test(landed) || info.password;
          toSignIn++;
          Object.assign(entry, { ok: false, note: toAuth ? `Needs sign-in (${landed !== wanted ? `redirected to ${landed}` : "shows a sign-in form"}).` : `Redirected to ${landed}.` });
        }
        if (entry.ok && info) {
          for (const sp of info.spots) {
            if (!sp.href) continue;
            try { const u = new URL(sp.href, url); if (u.origin === base.origin) links.add(u.pathname); } catch { /* not a URL */ }
          }
          const metrics = await page.send("Page.getLayoutMetrics");
          const h = Math.min(Math.ceil(metrics?.cssContentSize?.height ?? info.height), 12_000);
          const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: h, scale: 1 } });
          if (shot?.data) {
            entry.file = `${createHash("sha1").update(`${s.id}|${variant}`).digest("hex").slice(0, 16)}.png`;
            writeFileSync(join(dir, entry.file), Buffer.from(shot.data, "base64"));
            Object.assign(entry, { width: size.width, height: h, spots: info.spots });
            done++;
          } else Object.assign(entry, { ok: false, note: "Screenshot failed." });
        }
        if (blocked) entry.blocked = blocked;
        blockedTotal += blocked;
        (index[s.id] ??= {})[variant] = entry;
        opts.log(`  ${entry.ok ? "✓" : "–"} ${s.name}${entry.note ? `  ${entry.note}` : ""}${blocked ? `  (${blocked} write request${blocked > 1 ? "s" : ""} blocked)` : ""}`);
      }
      // keep the newest sign-in for next time (apps that rotate tokens hand out new ones while browsing)
      if (signIn) writeSignIn(ws, signIn = await snapshot(b, [base.origin], signIn));
      page.close();
    } finally {
      writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 2, screens: index }, null, 2));
      await b.close();
    }
  }
  const top = [...blockedKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length) opts.log(`Blocked most often: ${top.map(([k, n]) => `${k} ×${n}`).join(" · ")}`);
  if (toSignIn && toSignIn >= tried / 2) {
    const refresh = top.find(([k]) => /refresh|token|session|auth/i.test(k));
    opts.log(refresh
      ? `Most pages went to sign-in. Your app's session check is probably "${refresh[0]}", which the read-only guard blocked. Let just that through with screenshots: { allow: ["${refresh[0].replace(/^(mutation|query|other|POST|PUT|PATCH|DELETE) /, "")}"] } and run again.`
      : signIn
        ? "Most pages went to sign-in: your saved sign-in has probably expired. Run `flowmap screenshots --login` to sign in again."
        : "Most pages need sign-in. Run `flowmap screenshots --login` once, sign in in the window that opens, then run this again.");
  }
  return { captured: done, skipped, blocked: blockedTotal, variant };
}
