import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rootFields } from "@flowmap/plugins";
import { isWriteMethod } from "@flowmap/core";
import { Engine } from "../src/engine.ts";

test("rootFields reads top-level GraphQL fields, aliases and skips fragments", () => {
  assert.deepEqual(rootFields("mutation X($a: Int) { setNickname(userId: $a) { id ...F } }"), ["setNickname"]);
  assert.deepEqual(rootFields("query { a: getUser(id: 1) { id } other { x } ...Frag }"), ["getUser", "other"]);
  assert.deepEqual(rootFields("{ me { id } } ${FRAGMENT}"), ["me"]);
});

test("external read/write heuristic", () => {
  assert.equal(isWriteMethod("customers.retrieve"), false);
  assert.equal(isWriteMethod("subscriptions.update"), true);
  assert.equal(isWriteMethod("getSignedUrlPromise"), false);
  assert.equal(isWriteMethod("sendMail"), true);
});

const DIST = fileURLToPath(new URL("../../dashboard/dist/index.html", import.meta.url));

test("dashboard server: token cookie, host check, writes only through guarded endpoints", async (t) => {
  const { existsSync } = await import("node:fs");
  if (!existsSync(DIST)) return t.skip("dashboard not built");
  const dir = mkdtempSync(join(tmpdir(), "flowmap-srv-"));
  cpSync(fileURLToPath(new URL("../../../fixtures/shop", import.meta.url)), dir, { recursive: true, filter: (p) => !p.includes(".flowmap") });
  const e = await Engine.open(join(dir, "frontend"));
  e.refresh(true);
  const { serveDashboard } = await import("../src/server.ts");
  const port = 4600 + Math.floor(Math.random() * 300);
  let link = "";
  const server = await serveDashboard(e, { port, open: false, log: (s) => { link = /http\S+/.exec(s)?.[0] ?? link; } });
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/?token=wrong`, { redirect: "manual" })).status, 401);
    const login = await fetch(link, { redirect: "manual" });
    assert.equal(login.status, 302);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const ok = await fetch(`${base}/api/search?q=setNickname`, { headers: { cookie } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json())[0].kind, "Operation");
    assert.equal((await fetch(`${base}/api/status`, { method: "POST", headers: { cookie } })).status, 405);
    // the one write (capture a screenshot) needs the dashboard's own origin and header
    assert.equal((await fetch(`${base}/api/capture/x`, { method: "POST", headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/capture/x`, { method: "POST", headers: { cookie, "x-flowmap": "1", origin: "http://evil.test" } })).status, 403);
    assert.equal((await fetch(`${base}/api/capture/x`, { method: "POST", headers: { cookie, "x-flowmap": "1", origin: base } })).status, 202);
    // design saves: same guards, JSON only, size cap, safe names, version check
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { cookie, "x-flowmap": "1", origin: base, "content-type": "application/json", ...headers } });
    const design = { version: 0, title: "Test", nodes: [], edges: [] };
    assert.equal((await post("/api/designs/test", design, { "x-flowmap": "" })).status, 403);
    assert.equal((await post("/api/designs/test", design, { origin: "http://evil.test" })).status, 403);
    assert.equal((await post("/api/designs/test", design, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("/api/designs/..%2F..%2Fx", design)).status, 400);
    assert.equal((await post("/api/designs/test", "x".repeat(600 * 1024))).status, 413);
    const saved = await post("/api/designs/test", design);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { slug: "test", version: 1 });
    assert.equal((await post("/api/designs/test", design)).status, 409);
    // chat: bad input is refused before Claude is started; stopping when nothing runs is harmless
    assert.equal((await post("/api/designs/test/chat", { text: "hi", mode: "root" })).status, 400);
    assert.equal((await post("/api/designs/test/chat", { text: "  " })).status, 400);
    assert.deepEqual(await (await post("/api/designs/test/chat", { cancel: true })).json(), { stopped: false });
    assert.equal((await post("/api/designs/test/chat", { text: "hi" }, { "x-flowmap": "" })).status, 403);
    assert.equal((await post("/api/designs/test/chat", { new: true })).status, 200);
    assert.equal((await post("/api/designs/test/chat", { open: "c-nope" })).status, 404);
    assert.equal((await post("/api/designs/test/chat", { remove: "../x" })).status, 404);
    const flowRes = await fetch(`${base}/api/designs/test/flow?mode=full`, { headers: { cookie } });
    assert.deepEqual((await flowRes.json()).roots, 0);
    const view = await (await fetch(`${base}/api/designs/test`, { headers: { cookie } })).json();
    assert.equal(view.design.title, "Test");
    assert.equal((await fetch(`${base}/api/designs/nope`, { headers: { cookie } })).status, 404);
    assert.match(await (await fetch(`${base}/api/designs/test/export`, { headers: { cookie } })).text(), /^# Test/);
    // deleting is for good: it needs the guards and an explicit confirm, and a name that is not a design is refused
    assert.equal((await post("/api/designs/test/delete", { confirm: true }, { "x-flowmap": "" })).status, 403);
    assert.equal((await post("/api/designs/test/delete", {})).status, 400);
    assert.equal((await post("/api/designs/..%2F..%2Fx/delete", { confirm: true })).status, 400);
    assert.equal((await post("/api/designs/nope/delete", { confirm: true })).status, 404);
    assert.equal((await post("/api/designs/test/delete", { confirm: true })).status, 200);
    assert.equal((await fetch(`${base}/api/designs/test`, { headers: { cookie } })).status, 404);
    assert.equal((await post("/api/agent/chat", { clear: true })).status, 200);
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`, { headers: { cookie } })).status, 404);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self' 'sha256-/);
  } finally {
    server.close();
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
