import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { Engine } from "../src/engine.ts";
import { Queries } from "../src/queries.ts";
import { MapQueries } from "../src/map.ts";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/shop", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/flowmap.js", import.meta.url));
let dir: string;
let engine: Engine;
let q: Queries;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "flowmap-test-"));
  cpSync(FIXTURE, dir, { recursive: true, filter: (p) => !p.includes(".flowmap") });
  engine = await Engine.open(join(dir, "frontend"));
  engine.refresh(true);
  q = new Queries(engine);
});

after(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const found = () => engine.issues.map((i) => `${i.rule} ${i.nodeName}`).sort();

test("finds exactly the planted issues", () => {
  assert.deepEqual(found(), [
    "contract-drift Home",
    "contract-drift mutation ghostOperation",
    "dead-reference src/pages/Home.tsx",
    "id-without-actor UserResolver.setNickname",
    "missing-fk-index users",
    "n-plus-one UserService.notifyAll",
    "orphan-api mutation updateProfile",
    "orphan-api query me",
    "orphan-api query stats",
    "raw-error-in-handler UserService.findUser",
    "tx-external-call UserService.setNickname",
    "tx-no-write UserService.getUser",
    "unguarded-operation StatsResolver.stats",
    "unreachable-screen /legacy-report",
    "unvalidated-input UserResolver.updateProfile",
  ]);
  const tx = engine.issues.find((i) => i.rule === "tx-external-call")!;
  assert.equal(tx.severity, "error");
  assert.match(tx.message, /Stripe \(customers\.update\)/);
});

test("honours suppressions with a reason and after-commit callbacks", () => {
  assert.equal(engine.suppressed, 1);
  assert.ok(!found().some((f) => f.includes("notifyAdmins") || f.includes("rename")));
});

test("links screen → client call → API → service → table across repos", () => {
  const svc = q.resolve("UserService.setNickname")!;
  const r = q.reachable(svc.id);
  assert.ok(r.reachable);
  assert.deepEqual(r.paths[0].map((s) => s.name), ["/settings/profile", "Profile", "setNicknameAction", "mutation setNickname", "UserResolver.setNickname", "UserService.setNickname"]);
});

test("explain card for an API", () => {
  const card = q.explain(q.resolve("setNickname")!.id);
  assert.equal(card.node.kind, "Operation");
  assert.deepEqual(card.guards, ["JwtAuthGuard"]);
  assert.equal(card.hasActor, false);
  assert.deepEqual(card.writes.map((w) => w.name), ["users"]);
  assert.deepEqual(card.externals.map((e) => [e.name, e.inTx, e.write]), [["Stripe", true, true]]);
  assert.equal(card.schema?.returns, "User");
  assert.deepEqual(card.screens.map((s) => s.name), ["/settings/profile"]);
});

test("each repo works alone; a missing connected repo only warns", async () => {
  const backend = await Engine.open(join(dir, "backend"));
  backend.refresh(true);
  assert.deepEqual(backend.ws.config.repos.map((r) => r.name), ["backend"]);
  assert.ok(backend.issues.some((i) => i.rule === "tx-external-call"));
  assert.ok(!backend.issues.some((i) => i.rule === "contract-drift" && i.repo === "frontend"));
  backend.close();

  const lonely = mkdtempSync(join(tmpdir(), "flowmap-lonely-"));
  cpSync(join(FIXTURE, "frontend"), join(lonely, "frontend"), { recursive: true, filter: (p) => !p.includes(".flowmap") });
  const fe = await Engine.open(join(lonely, "frontend"));
  assert.match(fe.ws.config.warnings[0], /\.\.\/backend is not checked out/);
  fe.refresh(true);
  assert.ok(!fe.issues.some((i) => i.rule === "contract-drift"), "no drift errors without the backend");
  fe.close();
  rmSync(lonely, { recursive: true, force: true });
});

test("screen map: screens, links, and a compact flow across repo boxes", () => {
  const map = new MapQueries(q).appMap();
  const by = (name: string) => map.screens.find((s) => s.name === name)!;
  assert.deepEqual(map.screens.map((s) => s.name).sort(), ["/", "/legacy-report", "/settings/profile"]);
  assert.equal(by("/settings/profile").linksIn, 1, "Home links to the profile screen through PATHS.PROFILE");
  assert.equal(by("/settings/profile").auth, true);
  assert.equal(by("/legacy-report").unlinked, true);
  assert.equal(by("/").unlinked, false);
  assert.equal(by("/settings/profile").apis, 1);
  assert.ok(by("/settings/profile").issues > 0);
  const api = map.apis.find((a) => a.name === "mutation setNickname")!;
  assert.equal(api.screens, 1);
  assert.deepEqual(api.guards, ["JwtAuthGuard"]);

  const flow = new MapQueries(q).flow(by("/settings/profile").id, "compact");
  const groups = new Set(flow.nodes.map((n) => n.group));
  assert.deepEqual([...groups].sort(), ["External services", "backend", "frontend"]);
  const op = flow.nodes.find((n) => n.kind === "Operation")!;
  const stripe = flow.edges.find((e) => e.src === op.id && e.dst === "ext:Stripe")!;
  assert.equal(stripe.attrs.inTx, true, "the API points straight at Stripe, flagged as inside the transaction");
  assert.equal(op.attrs.summary, "writes 1 table · reads 1", "tables are summarized on the API card in the overview");
});

test("cron jobs and entity relations are indexed", () => {
  const job = [...engine.graph.nodes.values()].find((n) => n.kind === "Job")!;
  assert.match(job.name, /cron 0 3/);
  const users = q.tables().find((t) => t.name === "users")!;
  assert.deepEqual(users.relations, [{ to: "Org", column: "orgId", indexed: false }]);
  assert.ok(q.tables().some((t) => t.name === "org"));
});

test("baseline: existing issues stop being new", () => {
  engine.saveBaseline();
  engine.load();
  assert.equal(engine.issues.filter((i) => i.repo === "frontend" && i.status === "new").length, 0);
  assert.ok(engine.issues.some((i) => i.repo === "backend" && i.status === "new"), "backend issues are accepted in the backend's own baseline");
  assert.ok(existsSync(join(dir, "frontend", "flowmap.baseline.json")));
  assert.ok(!existsSync(join(dir, "backend", "flowmap.baseline.json")), "connected repo keeps its own baseline");
});

test("config edits reload: rule settings re-run rules without re-indexing", async () => {
  const file = join(dir, "frontend/flowmap.config.mjs");
  const src = readFileSync(file, "utf8");
  writeFileSync(file, src.replace("export default {", `export default {\n  rules: { "n-plus-one": "off" },`));
  assert.equal(await engine.reload(), null);
  assert.ok(!found().some((f) => f.startsWith("n-plus-one")));
  writeFileSync(file, src);
  await engine.reload();
  assert.ok(found().includes("n-plus-one UserService.notifyAll"));
});

test("incremental index re-parses only changed files", () => {
  const file = join(dir, "backend/src/user/user.service.ts");
  const src = readFileSync(file, "utf8");
  writeFileSync(file, src.replace("await this.stripe.customers.update(String(userId), { name: nickname });", "runOnTransactionCommit(() => this.stripe.customers.update(String(userId), { name: nickname }));"));
  const stats = engine.refresh();
  assert.equal(stats.changed, 1);
  assert.ok(!found().includes("tx-external-call UserService.setNickname"));

  rmSync(join(dir, "frontend/src/pages/Home.tsx"));
  const s2 = engine.refresh();
  assert.equal(s2.removed, 1);
  assert.ok(!found().some((f) => f.startsWith("dead-reference") || f === "contract-drift Home"));
});

test("indexing makes no network connections", () => {
  const origConnect = net.Socket.prototype.connect;
  const origFetch = globalThis.fetch;
  let attempts = 0;
  net.Socket.prototype.connect = function () { attempts++; throw new Error("network blocked"); } as any;
  globalThis.fetch = (() => { attempts++; throw new Error("network blocked"); }) as any;
  try {
    engine.refresh(true);
  } finally {
    net.Socket.prototype.connect = origConnect;
    globalThis.fetch = origFetch;
  }
  assert.equal(attempts, 0);
});

test("MCP server answers over stdio", async () => {
  const child = spawn(process.execPath, [BIN, "mcp", "-w", join(dir, "frontend")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } });
  const replies = new Map<number, any>();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) { const m = JSON.parse(line); if (m.id) replies.set(m.id, m); }
    }
  });
  const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const wait = async (id: number) => { for (let t = 0; t < 200 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 50)); return replies.get(id); };
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.ok((await wait(1))?.result, "initialize failed");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    const tools = (await wait(2)).result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(tools, ["check", "design_context", "design_get", "design_impact", "design_save", "explain", "impact", "map", "reachable", "search", "tables", "trace"]);
    send({ id: 3, method: "tools/call", params: { name: "explain", arguments: { target: "setNickname" } } });
    const text = (await wait(3)).result.content[0].text;
    assert.match(text, /caller check: no/);
    assert.match(text, /Stripe/);
    send({ id: 4, method: "tools/call", params: { name: "design_context", arguments: { feature: "let users change their nickname twice", anchor: "setNickname" } } });
    const ctx = (await wait(4)).result.content[0].text;
    assert.match(ctx, /Current flow from mutation setNickname/);
    assert.match(ctx, /Naming in this codebase/);
  } finally {
    child.kill();
  }
});
