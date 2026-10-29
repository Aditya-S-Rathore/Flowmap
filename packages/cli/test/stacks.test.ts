import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileRoute, ROUTER_PACKS } from "@flowmap/plugins";
import { normRoute } from "@flowmap/core";
import { indexFacts } from "../../core/src/indexes.ts";
import { Engine } from "../src/engine.ts";
import { Queries } from "../src/queries.ts";
import { MapQueries } from "../src/map.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function open(fixture: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `flowmap-${fixture.replace(/\W/g, "-")}-`));
  dirs.push(dir);
  cpSync(fileURLToPath(new URL(`../../../fixtures/${fixture}`, import.meta.url)), dir, { recursive: true, filter: (p) => !p.includes(".flowmap") });
  for (const [f, text] of Object.entries(extra)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); }
  const e = await Engine.open(dir);
  e.refresh(true);
  const m = new MapQueries(new Queries(e));
  return { e, m, map: m.appMap(), issues: e.issues.map((i) => `${i.rule} ${i.nodeName}`).sort(), unresolved: e.graph.edges.filter((x) => !x.dst && !x.attrs.optional) };
}

test("file-based routers: folder paths become URLs", () => {
  const rules = (id: string) => ROUTER_PACKS.find((p) => p.id === id)!.files!;
  const url = (id: string, file: string, roots = [""]) => {
    for (const r of rules(id)) {
      const hit = fileRoute(file, roots, r);
      if (hit) return `${r.kind} ${hit.verb ?? ""}${hit.url.length > 1 ? hit.url.replace(/\/$/, "") : hit.url}`;
    }
    return null;
  };
  assert.equal(url("next", "app/(shop)/products/[id]/page.tsx"), "page /products/:id");
  assert.equal(url("next", "src/app/page.tsx"), "page /");
  assert.equal(url("next", "app/api/users/[id]/route.ts"), "endpoint /api/users/:id");
  assert.equal(url("next", "app/_components/button/page.tsx"), null);
  assert.equal(url("next", "pages/blog/[...slug].tsx"), "page /blog/*");
  assert.equal(url("next", "pages/api/health.ts"), "endpoint /api/health");
  assert.equal(url("next", "pages/_app.tsx"), null);
  assert.equal(url("next", "apps/web/app/settings/page.tsx", ["apps/web", ""]), "page /settings");
  assert.equal(url("nuxt", "pages/users/[id].vue"), "page /users/:id");
  assert.equal(url("nuxt", "server/api/users/[id].get.ts"), "endpoint GET/api/users/:id");
  assert.equal(url("sveltekit", "src/routes/(app)/blog/[slug]/+page.svelte"), "page /blog/:slug");
  assert.equal(url("sveltekit", "src/routes/api/items/+server.ts"), "endpoint /api/items");
  assert.equal(url("remix", "app/routes/users.$id.edit.tsx"), "page /users/:id/edit");
  assert.equal(url("remix", "app/routes/_auth.login.tsx"), "page /login");
  assert.equal(url("remix", "app/routes/_index.tsx"), "page /");
  assert.equal(url("remix", "app/routes/users.$id/route.tsx"), "page /users/:id");
  assert.equal(url("remix", "app/routes/users.$id/components/card.tsx"), null);
  assert.equal(url("expo-router", "app/(tabs)/settings.tsx"), "page /settings");
  assert.equal(url("expo-router", "app/_layout.tsx"), null);
  assert.equal(url("astro", "src/pages/blog/[...slug].astro"), "page /blog/*");
  assert.equal(normRoute("/chat/:sessionId?"), "/chat/:p?");
  assert.equal(normRoute("/users/{id}/<int:x>?tab=1"), "/users/:p/:p");
});

test("Next.js + Prisma: route groups, dynamic segments, route handlers, server actions, tables", async () => {
  const { map, issues, unresolved } = await open("next-app");
  assert.deepEqual(map.screens.map((s) => s.name), ["/", "/projects", "/projects/:id", "/settings"]);
  const screen = (n: string) => map.screens.find((s) => s.name === n)!;
  assert.equal(screen("/projects").component?.name, "ProjectsPage");
  assert.deepEqual(screen("/projects").linksOut.map((l) => l.name), ["/projects/:id"]);
  assert.equal(screen("/projects").writes, 1, "server action createProject writes projects");
  assert.equal(screen("/settings").unlinked, true);
  assert.deepEqual(map.apis.map((a) => a.name).sort(), ["DELETE /api/projects/:id", "GET /api/projects/:id", "action createProject"]);
  assert.equal(map.apis.find((a) => a.name === "action createProject")!.guarded, true, "auth() inside the action counts as a guard");
  assert.deepEqual(issues, [
    "id-without-actor DELETE /api/projects/:id",
    "id-without-actor GET /api/projects/:id",
    "missing-fk-index projects",
    "tx-external-call createProject",
    "unguarded-operation DELETE /api/projects/:id",
    "unguarded-operation GET /api/projects/:id",
    "unreachable-screen /settings",
  ]);
  assert.deepEqual(unresolved, []);
});

test("setup suggestions: a framework plugin that's off, and an SDK FlowMap doesn't know", async () => {
  const { e, m } = await open("next-app");
  const list = m.suggestions();
  const resend = list.find((s) => s.kind === "external")!;
  assert.match(resend.title, /Resend \(resend\)/);
  assert.equal(resend.config, 'externals: { "Resend": "Resend" },');

  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync(e.ws.configPath, readFileSync(e.ws.configPath, "utf8").replace('"prisma", ', ""));
  await e.reload();
  const plugin = new MapQueries(new Queries(e)).suggestions().find((s) => s.kind === "plugin")!;
  assert.equal(plugin.title, "Turn on prisma");
  assert.equal(plugin.config, 'plugins: ["next","http-clients","prisma"],');
});

test("Vue: SFC script + template, nested and named routes, options API", async () => {
  const { e, map, issues } = await open("vue-app");
  assert.deepEqual(map.screens.map((s) => s.name), ["/", "/admin", "/admin/users", "/orders/:id"]);
  const home = map.screens.find((s) => s.name === "/")!;
  assert.deepEqual(home.linksOut.map((l) => l.name).sort(), ["/admin/users", "/orders/:id"], "RouterLink by path and by route name");
  assert.equal(map.screens.find((s) => s.name === "/admin")!.unlinked, false, "a layout route counts as linked through its children");
  const g = e.graph;
  const renders = g.edges.filter((x) => x.kind === "renders" && x.file === "src/views/HomeView.vue").map((x) => g.nodes.get(x.dst!)?.name);
  assert.deepEqual(renders, ["OrderCard"], "template tags become renders edges");
  const requests = g.edges.filter((x) => x.kind === "requests").map((x) => `${g.nodes.get(x.src)?.name} ${x.attrs.label}`).sort();
  assert.deepEqual(requests, ["AdminUsers GET /api/users", "HomeView GET /api/orders", "OrderCard GET /api/orders/total", "OrderView.cancel POST /api/orders/:p/cancel"]);
  assert.deepEqual(issues, [], "no dead-reference false positives for .vue default imports");
});

test("SvelteKit: +page.svelte screens, +page.server.ts loaders, +server.ts endpoints", async () => {
  const { map, unresolved } = await open("kit-app");
  assert.deepEqual(map.screens.map((s) => s.name), ["/", "/about", "/items/:id"]);
  assert.deepEqual(map.screens[0].linksOut.map((l) => l.name), ["/about", "/items/:id"]);
  const item = map.screens.find((s) => s.name === "/items/:id")!;
  assert.equal(item.apis, 1, "the loader's fetch reaches the +server.ts endpoint");
  assert.deepEqual(map.apis.map((a) => `${a.name} ${a.screens}`), ["GET /api/items/:id 1"]);
  assert.deepEqual(unresolved.map((x) => x.resolvedKey), ["op:rest:GET /api/stats"]);
});

test("Angular, React Navigation and TanStack Router", async () => {
  const { map } = await open("routers");
  assert.deepEqual(map.screens.map((s) => `${s.name} ${s.component?.name}`), [
    "/heroes HeroesComponent", "/heroes/:id HeroDetailComponent", "/posts/:postId Post", "Home HomeScreen", "Profile ProfileScreen",
  ]);
  const by = (n: string) => map.screens.find((s) => s.name === n)!;
  assert.equal(by("/heroes/:id").linksIn, 2, "routerLink in the template and router.navigate([...]) in a method");
  assert.equal(by("Profile").linksIn, 1, "navigation.navigate('Profile')");
  assert.equal(by("Home").unlinked, false, "name-based screens are never reported as unlinked");
});

test("microservices: Express + FastAPI + Django + Flask in one workspace, linked by HTTP calls", async () => {
  const { m, map, issues, unresolved } = await open("services");
  assert.deepEqual(map.screens, []);
  assert.deepEqual(map.apis.map((a) => `${a.group} ${a.name}`), [
    "accounts ALL /profiles", "accounts ALL /profiles/:profile_id/delete", "accounts ALL /profiles/:user_id",
    "billing GET /payments/:payment_id", "billing POST /payments/charge", "billing POST /payments/refund",
    "notify POST /notify",
    "orders GET /orders/:orderId", "orders POST /orders",
  ]);
  assert.deepEqual(map.jobs.map((j) => `${j.name} → ${j.handler?.name}`), ["task send_receipt → send_receipt"]);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(issues, [
    "id-without-actor app.get /orders/:orderId",
    "id-without-actor delete_profile",
    "id-without-actor get_payment",
    "id-without-actor profile_detail",
    "missing-fk-index payments",
    "n-plus-one settle_all",
    "orphan-api ALL /profiles",
    "orphan-api ALL /profiles/:profile_id/delete",
    "orphan-api GET /payments/:payment_id",
    "orphan-api POST /payments/refund",
    "tx-external-call create_charge",
    "unbounded-query ProfileList.get",
    "unguarded-operation app.get /orders/:orderId",
    "unguarded-operation delete_profile",
    "unguarded-operation get_payment",
    "unguarded-operation notify",
    "unvalidated-input app.post /orders",
    "unvalidated-input notify",
    "unvalidated-input profile_detail",
    "unvalidated-input refund",
  ]);
  const arch = m.architecture();
  const links = arch.links.map((l) => `${l.src} ${l.kind} ${l.dst}`).sort();
  assert.deepEqual(links, [
    "svc:accounts requests svc:notify", "svc:billing calls_external ext:Stripe", "svc:billing requests svc:notify",
    "svc:notify calls_external ext:Mail", "svc:orders requests svc:accounts", "svc:orders requests svc:billing",
  ]);
  // POST /orders → createOrder → billing POST /payments/charge → create_charge → Stripe (in a transaction) + payments
  const order = map.apis.find((a) => a.name === "POST /orders")!;
  const flow = m.flow(order.id, "full");
  assert.deepEqual([...new Set(flow.nodes.map((n) => n.group))].sort(), ["External services", "billing", "notify", "orders"]);
  assert.ok(flow.edges.some((e) => e.dst === "ext:Stripe" && e.attrs.inTx));
});

// ---------- screen sketches and screenshots ----------

type W = { kind: string; label?: string; children?: W[]; apis?: { name: string }[]; to?: { name: string }; component?: { name: string }; repeat?: boolean; submits?: boolean };
const flat = (w: W | null): W[] => (w ? [w, ...(w.children ?? []).flatMap(flat)] : []);

test("screen sketches: elements, child components, and what each button calls or opens", async () => {
  const { m, map } = await open("next-app");
  const sketch = (name: string) => flat(m.wireframe(map.screens.find((s) => s.name === name)!.id).root);

  const projects = sketch("/projects");
  const row = projects.find((w) => w.kind === "link" && w.to?.name === "/projects/:id")!;
  assert.equal(row.repeat, true, "one link per project (.map)");
  const form = projects.find((w) => w.kind === "form")!;
  assert.deepEqual(form.apis?.map((a) => a.name), ["action createProject"], "<form action={...}> calls the server action");
  assert.ok(projects.some((w) => w.kind === "component" && w.component?.name === "NewProject"), "child component expanded in place");
  assert.ok(projects.some((w) => w.kind === "button" && w.label === "Create"));

  const detail = sketch("/projects/:id").find((w) => w.kind === "button")!;
  assert.deepEqual(detail.apis?.map((a) => a.name), ["DELETE /api/projects/:id"], "inline onClick → fetch(…, { method: 'DELETE' })");

  const connect = await open("next-app", {
    "lib/auth.ts": `export const signIn = (id: string) => fetch(\`/api/projects/\${id}\`, { method: "DELETE" });
export function useAuth() { return { login: (id: string) => fetch(\`/api/projects/\${id}\`) }; }`,
    "app/connect/page.tsx": `"use client";
import { Formik } from "formik";
import { signIn, useAuth } from "../../lib/auth";
export default function Connect() {
  const { login } = useAuth();
  const remove = (id: string) => fetch(\`/api/projects/\${id}\`, { method: "DELETE" });
  const handleGoogle = () => remove("google");
  return (
    <div>
      <button onClick={() => handleGoogle()}>Google</button>
      <button onClick={() => signIn("a")}>Imported</button>
      <button onClick={() => login("b")}>Hook</button>
      <span><button onClick={() => fetch(\`/api/projects/\${1}\`)}>Same line</button><button onClick={() => setOpen(true)}>More</button></span>
      <Formik initialValues={{}} onSubmit={(v) => fetch(\`/api/projects/\${v.id}\`)}><div><button type="submit">Sign in</button></div></Formik>
    </div>
  );
}`,
  });
  const login = flat(connect.m.wireframe(connect.map.screens.find((s) => s.name === "/connect")!.id).root);
  assert.deepEqual(login.find((w) => w.label === "Google")?.apis?.map((a) => a.name), ["DELETE /api/projects/:id"], "onClick={() => handleGoogle()} follows local helpers");
  assert.deepEqual(login.find((w) => w.label === "Sign in")?.apis?.map((a) => a.name), ["GET /api/projects/:id"], "Formik onSubmit: its submit button runs it");
  const apis = (label: string) => login.find((w) => w.label === label)?.apis?.map((a) => a.name);
  assert.deepEqual(apis("Imported"), ["DELETE /api/projects/:id"], "imported helper");
  assert.deepEqual(apis("Hook"), ["GET /api/projects/:id"], "helper returned by a hook (const { login } = useAuth())");
  assert.deepEqual(apis("Same line"), ["GET /api/projects/:id"]);
  assert.equal(apis("More"), undefined, "a handler on the same line only gets its own calls; a button with its own handler doesn't inherit the form's");

  const vue = await open("vue-app");
  const home = flat(vue.m.wireframe(vue.map.screens.find((s) => s.name === "/")!.id).root);
  assert.deepEqual(home.filter((w) => w.kind === "link").map((w) => w.to?.name), ["/orders/:id", "/admin/users"]);
  assert.ok(home.some((w) => w.component?.name === "OrderCard"));
  const order = flat(vue.m.wireframe(vue.map.screens.find((s) => s.name === "/orders/:id")!.id).root);
  assert.equal(order.find((w) => w.kind === "button")?.to?.name, "/", "@click=\"cancel\" resolves the method, which navigates home");
});

test("screenshots: read-only guard, path params, sign-in fallback, clickable areas matched to code", async (t) => {
  const { screenUrl, isReadOnly } = await import("../src/shots.ts");
  assert.equal(screenUrl("/projects/:id/chat/:sessionId?", { id: "7" }), "/projects/7/chat");
  assert.equal(screenUrl("/blog/[slug]", { slug: "hello world" }), "/blog/hello%20world");
  assert.equal(screenUrl("/users/:id", {}), null);
  assert.equal(screenUrl("/docs/*", {}), null);
  assert.equal(isReadOnly("GET", undefined), true);
  assert.equal(isReadOnly("POST", JSON.stringify({ query: "query Me { me { id } }" })), true);
  assert.equal(isReadOnly("POST", JSON.stringify({ query: "{ me { id } }" })), true);
  assert.equal(isReadOnly("POST", JSON.stringify({ query: "mutation { deleteUser(id: 1) }" })), false);
  assert.equal(isReadOnly("POST", JSON.stringify([{ query: "query A { a }" }, { query: "mutation B { b }" }])), false);
  assert.equal(isReadOnly("POST", "event=pageview"), false);
  assert.equal(isReadOnly("DELETE", undefined), false);
  assert.equal(isReadOnly("POST", "{}", "https://app.test/api/auth/refresh", ["/api/auth/refresh"]), true, "allow-listed session refresh");
  const refresh = JSON.stringify({ query: "mutation refreshToken { refreshToken { token } }" });
  assert.equal(isReadOnly("POST", refresh, "https://app.test/graphql", []), false);
  assert.equal(isReadOnly("POST", refresh, "https://app.test/graphql", ["refreshToken"]), true, "a GraphQL operation allowed by name");
  assert.equal(isReadOnly("POST", JSON.stringify({ query: "mutation { deleteUser(id: 1) }" }), "https://app.test/graphql", ["refreshToken"]), false, "other mutations on the same URL stay blocked");
  assert.equal(isReadOnly("POST", JSON.stringify({ operationName: "Refresh", query: "mutation Refresh { refreshToken { token } }" }), "", ["Refresh"]), true);
  const { sampleFromLinks } = await import("../src/shots.ts");
  assert.equal(sampleFromLinks("/projects/:id", ["/projects", "/projects/42?tab=a"]), "/projects/42");
  assert.equal(sampleFromLinks("/projects/[id]/edit", ["/projects/42", "/projects/42/edit"]), "/projects/42/edit");
  assert.equal(sampleFromLinks("/chat/:sessionId?", ["/chat"]), "/chat");
  assert.equal(sampleFromLinks("/users/:id", ["/projects/1"]), null);

  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { e: remote } = await open("next-app");
  writeFileSync(remote.ws.configPath, readFileSync(remote.ws.configPath, "utf8").replace("export default {", `export default {\n  screenshots: { baseUrl: "https://staging.example.com" },`));
  await remote.reload();
  const { captureScreens, readShots } = await import("../src/shots.ts");
  await assert.rejects(captureScreens(remote, { log: () => {} }), /not on this machine/);

  const browsers = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  if (!process.env.FLOWMAP_CHROME && !browsers.some(existsSync)) return t.skip("no Chrome/Chromium installed");

  // a tiny app: one page tries to write on load; /settings sends signed-out users to /login
  const seen: string[] = [];
  const http = await import("node:http");
  const page = (body: string) => `<!doctype html><body>${body}</body>`;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      if (req.url === "/settings") { res.writeHead(302, { Location: "/login" }); return res.end(); }
      res.writeHead(200, { "Content-Type": req.url?.startsWith("/api") || req.url === "/graphql" ? "application/json" : "text/html" });
      if (req.url === "/projects") return res.end(page(`<a href="/projects/1">First project</a><form><button>Create</button></form><script>
        fetch("/api/track", { method: "POST", body: "event=view" });
        fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query Me { me { id } }" }) });
        fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "mutation Seen { markSeen }" }) });
        navigator.sendBeacon("/api/beacon", "x");</script>`));
      if (req.url === "/projects/1") return res.end(page(`<button>Delete</button>`));
      res.end(page(`<h1>${req.url}</h1>`));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const { e, m } = await open("next-app");
    // no params: the id for /projects/:id comes from the link on /projects
    writeFileSync(e.ws.configPath, readFileSync(e.ws.configPath, "utf8").replace("export default {", `export default {\n  screenshots: { baseUrl: "http://127.0.0.1:${port}", wait: 300 },`));
    await e.reload();
    const r = await captureScreens(e, { log: () => {} });
    assert.equal(r.captured, 3, "/settings redirected to /login, so it falls back to the sketch");
    assert.ok(r.blocked >= 3);
    assert.ok(seen.some((x) => x.startsWith("POST /graphql") && x.includes("query Me")), "GraphQL queries go through");
    assert.ok(!seen.some((x) => /\/api\/track|\/api\/beacon|markSeen/.test(x)), "writes never reach the app");

    const shots = readShots(e.ws);
    const route = (name: string) => [...e.graph.nodes.values()].find((n) => n.kind === "Route" && n.name === name)!;
    assert.equal(shots[route("/settings").id].desktop!.ok, false);
    assert.match(shots[route("/settings").id].desktop!.note!, /Needs sign-in \(redirected to \/login\)/);
    assert.ok(shots[route("/projects").id].desktop!.height > 0);

    const spots = new MapQueries(new Queries(e)).shotSpots(route("/projects").id).spots;
    assert.equal(spots.find((s) => s.label === "First project")?.to?.name, "/projects/:id", "link matched by its href");
    assert.deepEqual(spots.find((s) => s.label === "Create")?.apis?.map((a) => a.name), ["action createProject"], "submit button inherits its form's server action");
    const del = new MapQueries(new Queries(e)).shotSpots(route("/projects/:id").id).spots.find((s) => s.label === "Delete");
    assert.deepEqual(del?.apis?.map((a) => a.name), ["DELETE /api/projects/:id"]);
    assert.equal(m.appMap().screens.filter((s) => s.shot).length, 3, "a running dashboard sees new screenshots without re-indexing");
  } finally {
    server.close();
  }
});

test("screenshots: each frontend in a workspace is captured from its own URL", async (t) => {
  const { existsSync, writeFileSync } = await import("node:fs");
  const browsers = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  if (!process.env.FLOWMAP_CHROME && !browsers.some(existsSync)) return t.skip("no Chrome/Chromium installed");
  const http = await import("node:http");
  const hits: Record<string, string[]> = { web: [], vue: [] };
  const serve = (name: string) => http.createServer((req, res) => { hits[name].push(req.url!); res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<a href="/orders/9">o</a><a href="/projects/3">p</a>`); });
  const servers = [serve("web"), serve("vue")];
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  const [p1, p2] = servers.map((s) => (s.address() as { port: number }).port);
  try {
    const dir = mkdtempSync(join(tmpdir(), "flowmap-two-"));
    dirs.push(dir);
    for (const f of ["next-app", "vue-app"]) cpSync(fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url)), join(dir, f), { recursive: true, filter: (p) => !p.includes(".flowmap") });
    writeFileSync(join(dir, "flowmap.config.mjs"), `export default { name: "two", repos: [
      { name: "web", path: "./next-app", plugins: ["next", "prisma"], screenshots: { baseUrl: "http://127.0.0.1:${p1}", wait: 50 } },
      { name: "vue", path: "./vue-app", plugins: ["vue-router"], screenshots: { baseUrl: "http://127.0.0.1:${p2}", wait: 50 } },
    ] };`);
    const e = await Engine.open(dir);
    e.refresh(true);
    const { captureScreens } = await import("../src/shots.ts");
    await captureScreens(e, { log: () => {} });
    assert.ok(hits.web.includes("/projects") && hits.web.includes("/projects/3"), "Next app pages from the web URL, /projects/:id from a link");
    assert.ok(hits.vue.includes("/admin/users") && hits.vue.includes("/orders/9"), "Vue pages from the vue URL");
    assert.ok(!hits.web.includes("/admin/users") && !hits.vue.includes("/projects"), "no app's screens are loaded from the other app's URL");
    e.close();
  } finally {
    servers.forEach((s) => s.close());
  }
});

test("screenshots: a rotating refresh token survives between runs (browser closed cleanly)", async (t) => {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const browsers = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  if (!process.env.FLOWMAP_CHROME && !browsers.some(existsSync)) return t.skip("no Chrome/Chromium installed");
  // like many auth setups: every refresh hands out a new token and the old one stops working
  let current = 0;
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    const rt = Number(/rt=(\d+)/.exec(req.headers.cookie ?? "")?.[1] ?? -1);
    if (req.url === "/refresh" && req.method === "POST") {
      if (rt !== current) { res.writeHead(401); return res.end(); }
      current++;
      res.writeHead(200, { "Set-Cookie": `rt=${current}; Path=/; Max-Age=3600` });
      return res.end("{}");
    }
    const first = current === 0 && rt === -1;
    if (first) current = 1;
    res.writeHead(200, { "Content-Type": "text/html", ...(first ? { "Set-Cookie": "rt=1; Path=/; Max-Age=3600" } : {}) });
    res.end(`<h1>${req.url}</h1><script>fetch("/refresh", { method: "POST" }).then((r) => { if (!r.ok && location.pathname !== "/login") location.href = "/login"; });</script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const { e } = await open("next-app");
    writeFileSync(e.ws.configPath, readFileSync(e.ws.configPath, "utf8").replace("export default {", `export default {\n  screenshots: { baseUrl: "http://127.0.0.1:${port}", allow: ["/refresh"], params: { id: "1" }, wait: 400 },`));
    await e.reload();
    const { captureScreens } = await import("../src/shots.ts");
    const first = await captureScreens(e, { log: () => {} });
    const second = await captureScreens(e, { log: () => {} });
    assert.equal(first.captured, 4);
    assert.equal(second.captured, 4, "the second run still has the latest token");
  } finally {
    server.close();
  }
});

test("screenshots: sign-in kept in session-only cookies and sessionStorage is restored for every capture", async (t) => {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const browsers = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  if (!process.env.FLOWMAP_CHROME && !browsers.some(existsSync)) return t.skip("no Chrome/Chromium installed");
  // an app that keeps "who is signed in" in a session-only cookie (gone when the browser closes) and in sessionStorage
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    const user = /(?:^|; )user=alice/.test(req.headers.cookie ?? "");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(req.url === "/login" ? "<h1>Sign in</h1><input type=password>"
      : `<h1>${req.url}</h1><script>if (${user} === false || sessionStorage.getItem("tab") !== "1") location.href = "/login";</script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const { e } = await open("next-app");
    writeFileSync(e.ws.configPath, readFileSync(e.ws.configPath, "utf8").replace("export default {", `export default {\n  screenshots: { baseUrl: "http://127.0.0.1:${port}", params: { id: "1" }, wait: 400 },`));
    await e.reload();
    const { captureScreens } = await import("../src/shots.ts");
    assert.equal((await captureScreens(e, { log: () => {} })).captured, 0, "not signed in yet");
    // what --login saves while the window is open (the user signed in there)
    const profile = join(e.ws.dir, ".flowmap", "browser");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "flowmap-sign-in.json"), JSON.stringify({
      at: new Date().toISOString(),
      cookies: [{ name: "user", value: "alice", domain: "127.0.0.1", path: "/", secure: false, httpOnly: false, session: true }],
      session: { [`http://127.0.0.1:${port}`]: [["tab", "1"]] },
    }));
    assert.equal((await captureScreens(e, { log: () => {} })).captured, 4, "signed in from the saved state");
    assert.equal((await captureScreens(e, { log: () => {} })).captured, 4, "and again next run (state kept up to date)");
  } finally {
    server.close();
  }
});

// ---------- indexes and rules ----------

test("indexes: read from models, SQL and migration helpers; rollbacks skipped; first column only", async () => {
  const cols = (file: string, text: string) => indexFacts(file, text).map((f) => `${f.drop ? "drop " : ""}${f.table ?? "?"}(${f.columns.join(",")})${f.name ? " " + f.name : ""}`);
  assert.deepEqual(cols("m.js", `exports.up = (knex) => knex.schema.createTable("posts", (t) => { t.integer("author_id").references("users.id").index(); t.index(["status", "created_at"]); });
exports.down = (knex) => knex.schema.dropTable("posts");`), ["posts(author_id)", "posts(status,created_at)"]);
  assert.deepEqual(cols("m.js", `up: (qi) => qi.addIndex("posts", ["author_id"]), down: (qi) => qi.removeIndex("posts", "posts_author_id")`), ["posts(author_id)"]);
  assert.deepEqual(cols("a.py", `def upgrade():\n    op.create_index(op.f("ix_posts_author_id"), "posts", ["author_id"])\ndef downgrade():\n    op.drop_index(op.f("ix_posts_author_id"))`), ["posts(author_id) ix_posts_author_id"]);
  assert.deepEqual(cols("V2.sql", `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ix ON ONLY public.posts USING btree (lower(email), id);`), ["posts((expr),id) ix"]);
  assert.deepEqual(cols("2.down.sql", `DROP INDEX ix;`), [], "rollback files are skipped");
  assert.deepEqual(cols("V1.sql", `CREATE TABLE IF NOT EXISTS "keys" ("id" uuid NOT NULL, "owner_id" int UNIQUE, "client_id" uuid, "kind" varchar(10),
    CONSTRAINT "keys_pkey" PRIMARY KEY ("id"), CONSTRAINT "keys_client_kind" UNIQUE ("client_id", "kind"), CONSTRAINT "fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id"))`),
  ["keys(owner_id)", "keys(id) keys_pkey", "keys(client_id,kind) keys_client_kind"], "constraints inside CREATE TABLE");
  assert.deepEqual(cols("m.ts", `await q.createTable(new Table({ name: "usages", columns: [{ name: "id", type: "uuid", isPrimary: true }, { name: "org_id", type: "uuid" }],
    foreignKeys: [new TableForeignKey({ columnNames: ["org_id"], referencedTableName: "orgs" })], uniques: [new TableUnique({ columnNames: ["org_id", "day"] })] }));
  await q.createUniqueConstraint("usages", new TableUnique({ columnNames: ["code"] }));`), ["usages(org_id,day)", "usages(id)", "usages(code)"], "TypeORM table builder: uniques and primary columns, not foreign keys");

  const extra = {
    "src/entities/order.entity.ts": `import { Entity, ManyToOne, OneToOne, JoinColumn, PrimaryGeneratedColumn } from "typeorm";
import { Org } from "./org.entity";
import { User } from "./user.entity";
@Entity({ name: "orders" })
export class Order {
  @PrimaryGeneratedColumn() id: number;
  @ManyToOne(() => User) @JoinColumn({ name: "user_id" }) user: User;
  @ManyToOne(() => Org) @JoinColumn({ name: "org_id" }) org: Org;
  @ManyToOne(() => Org) @JoinColumn({ name: "seller_id" }) seller: Org;
  @ManyToOne(() => Org) @JoinColumn({ name: "buyer_id" }) buyer: Org;
  @ManyToOne(() => Org) @JoinColumn({ name: "tenant_id" }) tenant: Org;
  @OneToOne(() => User) @JoinColumn({ name: "invoice_id" }) invoice: User;
}`,
    "src/migrations/1700000000000-Orders.ts": `import { TableIndex } from "typeorm";
export class Orders1700000000000 {
  async up(q) {
    await q.query(\`CREATE INDEX "IDX_orders_user" ON "public"."orders" ("user_id")\`);
    await q.createIndex("orders", new TableIndex({ name: "IDX_orders_org", columnNames: ["org_id"] }));
    await q.query(\`CREATE INDEX "IDX_orders_status_seller" ON "orders" ("status", "seller_id")\`);
    await q.query(\`CREATE INDEX "IDX_orders_buyer" ON orders (buyer_id)\`);
    await q.query(\`CREATE INDEX "\${name}" ON "\${schema}"."\${table}" ("tenant_id")\`);
  }
  async down(q) { await q.query(\`DROP INDEX "IDX_orders_user"\`); }
}`,
    "src/migrations/1800000000000-drop-buyer.sql": `DROP INDEX "IDX_orders_buyer";`,
  };
  const { e, issues } = await open("shop/backend", extra);
  const orders = new Queries(e).tables().find((t) => t.name === "orders")!;
  assert.deepEqual(Object.fromEntries(orders.relations.map((r) => [r.column, r.indexed])), {
    user_id: true, org_id: true, seller_id: false, buyer_id: false, tenant_id: null, invoice_id: true,
  }, "down() is a rollback; (status, seller_id) doesn't cover seller_id; a later DROP INDEX wins; a runtime table name can't be told; OneToOne is unique");
  assert.deepEqual(orders.issues.filter((i) => i.rule === "missing-fk-index").map((i) => i.message), ["orders.seller_id (→ Org) has no index.", "orders.buyer_id (→ Org) has no index."]);
  assert.ok(issues.includes("missing-fk-index users"));

  const mysql = await open("shop/backend", { ...extra, "flowmap.config.mjs": `export default { name: "backend", database: "mysql", plugins: ["nestjs", "typeorm"] };` });
  assert.ok(!mysql.issues.some((i) => i.startsWith("missing-fk-index")), "MySQL indexes foreign keys itself");
});

test("rules: read-only API writing, writes without a transaction, unlimited lists, unhandled events, unsigned webhooks, removed APIs", async () => {
  const { e } = await open("shop/backend", {
    "src/extra/extra.resolver.ts": `import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { Body, Controller, Headers, Post } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { Org } from "../entities/org.entity";
import { ZodValidationPipe } from "nestjs-zod";
import { ArchiveService } from "./archive.service";

@Resolver()
export class ExtraResolver {
  constructor(@InjectRepository(User) private users: Repository<User>, @InjectRepository(Org) private orgs: Repository<Org>, private events: EventEmitter2, private archive: ArchiveService) {}
  @Query("touch") async touch() { await this.users.save({ id: 1 }); }
  @Mutation("createTeam") async createTeam() { await this.orgs.save({}); await this.users.save({}); this.events.emit("team.created"); }
  @Query("allUsers") async allUsers() { return this.users.find(); }
  @Query("someUsers") async someUsers() { return this.users.find({ take: 10 }); }
  @Mutation("rename") async rename(@Args("input", new ZodValidationPipe(schema)) input: { name: string }) { return input; }
  @Mutation("archiveProject") async archiveProject(@Args("projectId") projectId: string) { return this.archive.run(projectId); }
}

@Controller("webhooks")
export class Hooks {
  @Post("stripe") async stripe(@Body() body: any) { return body; }
  @Post("github") async github(@Headers("x-hub-signature-256") sig: string, @Body() body: any) { return verifySignature(sig, body); }
}`,
    "src/extra/archive.service.ts": `export class ArchiveService {
  constructor(private cls: ClsService) {}
  run(id: string) { const user = this.cls.get("user"); return { id, user }; }
}`,
    "src/filters/all.filter.ts": `import { Catch } from "@nestjs/common";
@Catch()
export class AllErrors {}`,
  });
  const by = (rule: string) => e.issues.filter((i) => i.rule === rule).map((i) => i.message);
  assert.deepEqual(by("write-on-get"), ["query touch writes users."]);
  assert.deepEqual(by("multi-write-no-tx"), ["mutation createTeam writes org, users outside a transaction."]);
  assert.deepEqual(by("unbounded-query"), ["ExtraResolver.allUsers loads every row of users with no limit (reachable from query allUsers)."]);
  assert.deepEqual(by("queue-no-consumer"), [`ExtraResolver.createTeam sends "team.created", but nothing handles it.`]);
  assert.deepEqual(by("webhook-unverified"), ["POST /webhooks/stripe accepts events without checking their signature."]);
  assert.deepEqual(by("raw-error-in-handler"), [], "a catch-all error filter maps plain Errors");
  assert.ok(!by("unvalidated-input").some((m) => m.startsWith("mutation rename")), "a validation pipe on the argument counts");
  assert.ok(!by("id-without-actor").some((m) => m.startsWith("mutation archiveProject")), "the service reads the current user");
  assert.equal(e.issues.find((i) => i.rule === "id-without-actor" && i.nodeName === "UserResolver.setNickname")?.severity, "error", "it writes, so it's an error");

  e.baselineApis.add("backend\0query removedThing");
  e.load();
  assert.deepEqual(by("breaking-change"), ["query removedThing was removed (it is in the baseline)."]);
  e.saveBaseline();
  e.load();
  assert.deepEqual(by("breaking-change"), [], "baseline update records the new API list");
});

test("feature flags: a function that calls a configured flag check is marked with that flag", async () => {
  const { e } = await open("shop/backend", {
    "flowmap.config.mjs": `export default { name: "backend", plugins: ["nestjs", "graphql-sdl", "typeorm", "typeorm-transactional", "bullmq", "http-clients"], flags: [{ call: "isEnabled", arg: 1 }] };`,
    "src/flagged.ts": `declare const ctx: any;\ndeclare function isEnabled(c: any, name: string): boolean;\nexport function boardVisible() { return isEnabled(ctx, "board"); }\nexport function plain() { return 1; }\n`,
  });
  const attrs = (name: string) => [...e.graph.nodes.values()].find((n) => n.name === name)?.attrs;
  assert.deepEqual(attrs("boardVisible")?.flags, ["board"]);
  assert.equal(attrs("plain")?.flags, undefined);
});

test("columns: Prisma lists a model's scalar fields, not its relations; Django and SQLAlchemy list their fields", async () => {
  const prisma = await open("next-app");
  const tables = (e: typeof prisma.e) => [...e.graph.nodes.values()].filter((n) => n.kind === "Table");
  const cols = (e: typeof prisma.e, table: string) => ((tables(e).find((n) => n.name === table)?.attrs.columns ?? []) as { name: string; type: string }[]);
  assert.ok(cols(prisma.e, "projects").some((c) => c.name === "id") && cols(prisma.e, "projects").length > 1, "the Prisma model lists its fields");
  for (const t of tables(prisma.e)) for (const r of (t.attrs.relations ?? []) as { to: string }[]) assert.ok(!cols(prisma.e, t.name).some((c) => c.type.replace(/\W/g, "") === r.to), `${t.name}: a relation to ${r.to} is not a column`);
  const py = await open("services");
  const named = tables(py.e).filter((t) => (t.attrs.columns as unknown[] | undefined)?.length);
  assert.ok(named.length > 0, "Python models list their fields too");
});

test("columns: a Drizzle table lists its columns", async () => {
  const { e } = await open("next-app", {
    "flowmap.config.mjs": `export default { name: "web", plugins: ["next", "prisma", "drizzle", "http-clients"] };`,
    "src/schema.ts": `import { pgTable, serial, text } from "drizzle-orm/pg-core";\nexport const notes = pgTable("notes", { id: serial("id").primaryKey(), body: text("body").notNull() });\n`,
  });
  const notes = [...e.graph.nodes.values()].find((n) => n.kind === "Table" && n.name === "notes");
  assert.deepEqual(notes?.attrs.columns, [{ name: "id", type: "serial" }, { name: "body", type: "text" }]);
});
