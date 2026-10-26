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

test("dashboard server: token cookie, host check, read-only API", async (t) => {
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
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`, { headers: { cookie } })).status, 404);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self' 'sha256-/);
  } finally {
    server.close();
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
