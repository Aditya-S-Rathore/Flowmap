import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zip } from "../src/zip.ts";

const have = (() => { try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("the bundle is a valid ZIP: a real unzip reads both files back unchanged", { skip: !have && "no unzip on this machine" }, async () => {
  const png = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 256);
  const md = new TextEncoder().encode("# Título\n\n![What changes](diagram.png)\n");
  const file = join(mkdtempSync(join(tmpdir(), "flowmap-zip-")), "bundle.zip");
  writeFileSync(file, Buffer.from(await zip([{ name: "rfc.md", data: md }, { name: "diagram.png", data: png }]).arrayBuffer()));
  assert.match(execFileSync("unzip", ["-t", file], { encoding: "utf8" }), /No errors detected/);
  assert.deepEqual(execFileSync("unzip", ["-p", file, "rfc.md"]), Buffer.from(md));
  assert.deepEqual(execFileSync("unzip", ["-p", file, "diagram.png"]), Buffer.from(png));
});
