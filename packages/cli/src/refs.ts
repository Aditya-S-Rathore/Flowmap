import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_NAMES } from "@flowmap/core";
import type { ChangeSet } from "@flowmap/core";
import { Engine } from "./engine.ts";
import { defaultBase, Queries } from "./queries.ts";

const KEEP = 5;      // snapshots kept (each is a copy of the branch's files plus its index)

/**
 * Compares two branches (or any two refs) without checking either out. Git reads the files of `head` straight from its objects into
 * `.flowmap/refs/<commit>/<repo>`, FlowMap indexes that copy, and the diff of `base...head` is laid on the copy's graph. The copy is
 * kept per commit, so the same commit is fast the second time. Your working folder is never touched.
 * One repo at a time: connected repos (`connect: ["../api"]`) are read from where they are.
 */
export const REF = /^[\w@][\w./@^~-]{0,199}$/;      // a branch, tag or commit: never something git could read as an option

export async function changesBetween(engine: Engine, base: string | undefined, head: string): Promise<ChangeSet> {
  const own = engine.ws.config.repos.filter((r) => !r.connected);
  if (own.length !== 1) throw new Error("Comparing two branches without a checkout works on one repo at a time: run it inside that repo.");
  const repo = own[0];
  base ??= repo.base ?? defaultBase(repo.path);
  if (!REF.test(base) || !REF.test(head)) throw new Error("A branch, tag or commit name, please.");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo.path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // the branch that is checked out is your working folder (uncommitted edits included): no copy needed
  if (head === "HEAD" || head === git("branch", "--show-current")) return new Queries(engine).changes(base);
  const [sha, baseSha] = [git("rev-parse", "--verify", `${head}^{commit}`), git("rev-parse", "--verify", `${base}^{commit}`)];

  const refs = join(engine.ws.dir, ".flowmap", "refs");
  const root = join(refs, sha.slice(0, 12));
  const dir = join(root, basename(repo.path));
  if (!existsSync(dir)) {
    // built next to its final place and renamed into it, so two requests for the same commit never see a half-copied folder
    const tmp = `${root}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, basename(repo.path)), { recursive: true });
    // the commit's files, straight from git (the shell only joins the two commands; every value is passed as an argument)
    execFileSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", repo.path, sha, join(tmp, basename(repo.path))], { stdio: "ignore" });
    for (const name of CONFIG_NAMES) if (!existsSync(join(tmp, basename(repo.path), name)) && existsSync(join(repo.path, name))) copyFileSync(join(repo.path, name), join(tmp, basename(repo.path), name));
    for (const other of engine.ws.config.repos.filter((r) => r.connected)) symlinkSync(other.path, join(tmp, basename(other.path)));   // so "../api" still resolves
    try { renameSync(tmp, root); } catch { rmSync(tmp, { recursive: true, force: true }); }          // someone else got there first
  }
  prune(refs, root);

  const snap = await Engine.open(dir);
  try {
    snap.refresh(true);
    return new Queries(snap).changes(base, { head: sha, base: baseSha, gitDirs: { [repo.name]: repo.path } });
  } finally {
    snap.close();
  }
}

/** Keeps the most recent snapshots, never the one in use. */
function prune(refs: string, keep: string) {
  const old = readdirSync(refs).filter((d) => !d.endsWith(".tmp")).map((d) => join(refs, d)).filter((d) => d !== keep).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(KEEP - 1);
  for (const d of old) rmSync(d, { recursive: true, force: true });
}

/** What the Changes page needs to start: the branches to pick from, the one checked out, and the base to compare against by default (the repo's `base`, else its main branch). Read-only. */
export function branchInfo(engine: Engine): { branches: string[]; current: string | null; base: string } {
  const repo = engine.ws.config.repos.find((r) => !r.connected);
  if (!repo) return { branches: [], current: null, base: "" };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo.path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const attempt = <T>(fn: () => T, fallback: T) => { try { return fn(); } catch { return fallback; } };
  return {
    branches: attempt(() => git("for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags").split("\n").filter((b) => b && !b.endsWith("/HEAD")).slice(0, 300), []),
    current: attempt(() => git("branch", "--show-current") || null, null),
    base: repo.base ?? attempt(() => defaultBase(repo.path), ""),
  };
}
