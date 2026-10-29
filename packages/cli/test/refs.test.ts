import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { changesBetween } from "../src/refs.ts";

test("compare two branches without checking either out: the working folder is never touched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flowmap-refs-"));
  cpSync(fileURLToPath(new URL("../../../fixtures/next-app", import.meta.url)), dir, { recursive: true, filter: (p) => !p.includes(".flowmap") });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t.t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "feature");
  const file = join(dir, "app", "actions.ts");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, `${before.replace("const session = await auth();", "const session = await auth(); // checked")}\nexport async function archiveProject(id: string) { return id; }\n`);
  git("commit", "-q", "-am", "feature");
  git("switch", "-q", "main");

  const engine = await Engine.open(dir);
  try {
    engine.refresh(true);
    const r = await changesBetween(engine, "main", "feature");
    assert.deepEqual(r.repos.map((x) => x.files), [["app/actions.ts"]]);
    const by = (name: string) => r.changed.find((c) => c.name === name)!;
    assert.equal(by("archiveProject").change, "new", "a function the branch added is new");
    assert.equal(by("createProject").change, "changed", "one that was there and was touched is changed");
    assert.match(r.diffs[by("archiveProject").id], /^@@ .*\n(\+\n)?\+export async function archiveProject/);
    assert.match(r.diffs[by("createProject").id], /\n-.*auth\(\);\n\+.*\/\/ checked/, "and the diff shows what changed in it");
    assert.ok(r.graph.nodes.some((n) => n.name === "archiveProject" && n.change === "new"), "the picture says the same");
    assert.equal(readFileSync(file, "utf8"), before, "your files are as they were");
    assert.equal(git("branch", "--show-current").trim(), "main", "and you are still on main");
    assert.ok(existsSync(join(dir, ".flowmap", "refs")), "the branch's copy is cached for next time");
    await assert.rejects(changesBetween(engine, "main", "--output=x"), /branch, tag or commit/);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
