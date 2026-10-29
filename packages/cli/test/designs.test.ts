import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Design } from "@flowmap/core";
import { Engine } from "../src/engine.ts";
import { Queries } from "../src/queries.ts";
import { pageNav, readNav, sendNav } from "../src/nav.ts";
import { activeConversation, buildDiagram, chatSummaries, checkDesign, deleteDesign, designContext, designFlow, designsDir, designView, GLOBAL_CHAT, importDesign, listDesigns, readChats, readDesign, saveDesign, saveDiagram, toMarkdown, toMermaid } from "../src/designs.ts";
import { MapQueries } from "../src/map.ts";
import { DIAGRAM_MARKER, RFC_TEMPLATE, RFC_TEMPLATE_SHORT } from "@flowmap/core";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/shop", import.meta.url));
let dir: string;
let engine: Engine;
let q: Queries;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "flowmap-design-"));
  cpSync(FIXTURE, dir, { recursive: true, filter: (p) => !p.includes(".flowmap") });
  engine = await Engine.open(join(dir, "frontend"));
  engine.refresh(true);
  q = new Queries(engine);
});

after(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const USERS = "backend:table:users";
const STATS = "backend:src/user/user.resolver.ts#StatsResolver.stats";

const draft = (over: Partial<Design> = {}): Design => ({
  version: 0, title: "Archive users", summary: "Let admins archive a user", rfc: "", decisions: [], notes: [], updatedAt: "",
  nodes: [
    { id: "new:archive-op", change: "new", kind: "Operation", name: "mutation archiveUser", repo: "backend", author: "user" },
    { id: "new:archive-fn", change: "new", kind: "Function", name: "UserResolver.archiveUser", repo: "backend", file: "src/user/user.resolver.ts", transactional: true, guards: ["JwtAuthGuard"], author: "user" },
    { id: USERS, change: "existing", kind: "Table", name: "users", repo: "backend", author: "user" },
    { id: "ext:Stripe", change: "existing", kind: "External", name: "Stripe", repo: "", author: "user" },
  ],
  edges: [
    { id: "e1", src: "new:archive-op", dst: "new:archive-fn", kind: "handles", change: "new", author: "user" },
    { id: "e2", src: "new:archive-fn", dst: USERS, kind: "writes", change: "new", author: "user" },
    { id: "e3", src: "new:archive-fn", dst: "ext:Stripe", kind: "calls_external", change: "new", author: "user" },
  ],
  ...over,
});

test("impact: rules run on the design without touching the real graph", () => {
  const before = { nodes: engine.graph.nodes.size, edges: engine.graph.edges.length, tx: engine.graph.txFns.size, issues: engine.issues.length };
  const v = designView(q, "x", draft());
  const introduced = v.impact.introduced.map((i) => `${i.rule} ${i.nodeName}`).sort();
  assert.deepEqual(introduced, ["orphan-api mutation archiveUser", "tx-external-call UserResolver.archiveUser"]);
  assert.deepEqual(v.impact.resolved, []);
  assert.deepEqual(v.impact.tables.map((t) => t.name), ["users"]);
  assert.equal(v.nodes.find((n) => n.id === "new:archive-fn")!.introduced, 1);
  assert.deepEqual({ nodes: engine.graph.nodes.size, edges: engine.graph.edges.length, tx: engine.graph.txFns.size, issues: engine.issues.length }, before);
});

test("impact: a guard added to a real handler resolves its issue; a removed API breaks its callers", () => {
  const guarded = designView(q, "x", draft({ nodes: [{ id: STATS, change: "changed", kind: "Function", name: "StatsResolver.stats", repo: "backend", guards: ["JwtAuthGuard"], author: "user" }], edges: [] }));
  assert.deepEqual(guarded.impact.resolved.map((i) => i.rule), ["unguarded-operation"]);
  const removed = designView(q, "x", draft({ nodes: [{ id: "backend:op:graphql:setNickname", change: "removed", kind: "Operation", name: "mutation setNickname", repo: "backend", author: "user" }], edges: [] }));
  assert.ok(removed.impact.introduced.some((i) => i.rule === "contract-drift"), removed.impact.introduced.map((i) => i.rule).join());
  assert.deepEqual(removed.impact.dependents[0].refs.map((r) => r.name).filter((n) => n.startsWith("/")), ["/settings/profile"]);
});

test("validation rejects bad names, kinds, ids and dangling edges", () => {
  for (const slug of ["../x", "Upper", "a".repeat(65), "", "a/b"]) assert.throws(() => saveDesign(engine.ws, slug, draft(), "user"), /Invalid design name/);
  assert.throws(() => saveDesign(engine.ws, "bad", { ...draft(), nodes: [{ ...draft().nodes[0], kind: "Banana" }] }, "user"), /Invalid design: nodes\.0\.kind/);
  assert.throws(() => saveDesign(engine.ws, "bad", { ...draft(), nodes: [{ ...draft().nodes[0], id: USERS }] }, "user"), /proposed nodes/);
  assert.throws(() => saveDesign(engine.ws, "bad", { ...draft(), edges: [{ ...draft().edges[0], dst: "nowhere" }] }, "user"), /not in the design/);
  assert.ok(!existsSync(join(designsDir(engine.ws), "bad.json")));
});

test("save: versions, conflicts, Claude's additions pending, positions kept", () => {
  const first = saveDesign(engine.ws, "archive", { ...draft(), nodes: draft().nodes.map((n, i) => ({ ...n, x: i * 100, y: 0, pinned: i === 0 })) }, "user");
  assert.equal(first.version, 1);
  assert.throws(() => saveDesign(engine.ws, "archive", draft(), "user"), (e: any) => e.status === 409);
  const moved = { ...first, nodes: first.nodes.map((n) => ({ ...n, x: 999 })) };
  const byClaude = saveDesign(engine.ws, "archive", {
    ...moved, rfc: "## Problem\nx",
    nodes: [...moved.nodes, { id: "new:audit", change: "new", kind: "Table", name: "audit_log", repo: "backend", author: "user" }],
  }, "claude");
  assert.equal(byClaude.version, 2);
  assert.equal(byClaude.rfcBy, "claude");
  assert.equal(byClaude.nodes[0].x, 0, "Claude does not move the user's nodes");
  assert.equal(byClaude.nodes[0].pinned, true, "…nor un-pin them");
  const audit = byClaude.nodes.find((n) => n.id === "new:audit")!;
  assert.equal(audit.author, "claude");
  assert.equal(audit.pending, true);
  assert.equal(listDesigns(engine.ws)[0].pending, 1);
  assert.deepEqual(readDesign(engine.ws, "archive"), byClaude);
  assert.deepEqual(readdirSync(designsDir(engine.ws)), ["archive.json"]);
});

test("save refuses a symlinked design file", () => {
  const target = join(dir, "outside.json");
  writeFileSync(target, "{}");
  mkdirSync(designsDir(engine.ws), { recursive: true });
  symlinkSync(target, join(designsDir(engine.ws), "linked.json"));
  assert.throws(() => saveDesign(engine.ws, "linked", draft(), "user"), /symlink/);
});

test("import picks a free name", () => {
  assert.equal(importDesign(engine.ws, draft()).slug, "archive-users");
  assert.equal(importDesign(engine.ws, draft()).slug, "archive-users-2");
});

test("export: escaped Mermaid, and the RFC has what a reviewer needs", () => {
  const v = designView(q, "x", draft({ title: "Say \"hi\"", rfc: "## Problem\nUsers can't archive." }));
  const md = toMarkdown(v);
  for (const h of ["# Say \"hi\"", "## TL;DR", "## Problem", "## At a glance", "## What changes", "| New | `mutation archiveUser` · api |", "## Impact and risks", "External call inside a DB transaction", "Why it matters:"]) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
  const mm = toMermaid(designView(q, "x", draft({ nodes: [{ ...draft().nodes[0], name: "say \"<hi>\"" }], edges: [] })));
  assert.match(mm, /say #quot;#lt;hi#gt;#quot;/);
  assert.match(mm, /:::new/);
});

test("export: in reading order, TL;DR first, facts from the design, pointers and duplicates gone", () => {
  const v = designView(q, "x", draft({
    title: "Archive users", status: "review", summary: "Admins can archive users so history is kept.",
    decisions: [{ question: "Delete or archive?", answer: "Archive | keep history" }, { question: "  ", answer: "ignored" }],
    rfc: "# Archive users\n\n## Summary\nold summary text\n\n## Problem\nDeleting loses history.\n\n## Goals / non-goals\n- Keep history\n\n## Proposal\n1. Add archiveUser.\n\n## Decisions\nSee decisions list.\n\n## Impact & risks\nFilled from `design_impact`.\n\n## Alternatives\n- Soft delete flag: rejected.\n\n## Rollout\nMigration first.\n\n## Open questions\n- Who may archive?\n",
  }));
  const md = toMarkdown(v);
  const order = ["# Archive users", "> **Status:** In review", "## Problem", "## TL;DR", "## At a glance", DIAGRAM_MARKER, "## Goals and non-goals", "## Proposal", "## What changes", "## Decisions", "## Alternatives considered", "## Impact and risks", "## Rollout"];
  let at = -1;
  for (const h of order) { const i = md.indexOf(h); assert.ok(i > at, `${h} is missing or out of order`); at = i; }
  assert.ok(md.includes("Admins can archive users so history is kept."));
  assert.ok(!md.includes("old summary text"), "the TL;DR field wins over an old Summary section");
  assert.ok(!md.includes("See decisions list") && !md.includes("Filled from"), "one-line pointers are dropped");
  assert.ok(md.includes("| Delete or archive? | Archive \\| keep history |"), "decisions come from the design, escaped for a table");
  assert.ok(!md.includes("ignored"), "an empty decision is skipped");
  for (const h of ["## Decisions", "## TL;DR", "## Problem"]) assert.equal((md.match(new RegExp(`^${h}`, "gm")) ?? []).length, 1, `${h} appears once`);
  assert.match(md, /\| # \| Change \| What \| Where \| Note \|/);
  assert.match(md, /\| 1 \| New \| `mutation archiveUser`/);
  assert.match(md, /\| \*\*Changes\*\* \| 2 new \|/);
  assert.match(md, /\| \*\*New issues\*\* \| 2: /);
  assert.ok(!/flowmap|verification|mermaid|\bFix:/i.test(md), "an RFC says nothing about the tool that drew it, has no code dump and no how-to-fix advice");
});

test("export: an empty RFC still reads well, and a real risks section is kept under the impact", () => {
  const empty = toMarkdown(designView(q, "x", draft({ summary: "", rfc: "" })));
  assert.match(empty, /## TL;DR\n_Add 2–3 lines/);
  assert.ok(!empty.includes("## Problem"), "no empty headings");
  const long = "Large tables lock for the whole backfill, so we run it in batches of 1,000 rows and pause when replication lags more than five seconds.";
  const withRisks = toMarkdown(designView(q, "x", draft({ rfc: `## Risks and impact\n${long}` })));
  assert.ok(withRisks.indexOf("## Impact and risks") < withRisks.indexOf(long), "reviewer-written risks sit under the generated impact");
});

test("export: the diagram says how much unchanged code it left out", () => {
  const SET = "backend:src/user/user.resolver.ts#UserResolver.setNickname";
  const svc = q.resolve("UserService.setNickname")!;
  const v = designView(q, "x", draft({
    nodes: [
      { id: SET, change: "changed", kind: "Function", name: "UserResolver.setNickname", repo: "backend", author: "user" },
      { id: svc.id, change: "existing", kind: "Function", name: svc.name, repo: "backend", author: "claude" },
    ],
    edges: [],
  }));
  assert.ok(!toMermaid(v).includes("UserService.setNickname"), "a function the change only calls is left out");
  assert.match(toMarkdown(v), /Unchanged code the changes only touch in passing \(1 node\) is left out/);
});

test("check: built vs missing", () => {
  const d = draft({
    nodes: [
      { id: "new:me", change: "new", kind: "Operation", name: "query me", repo: "backend", author: "user" },
      ...draft().nodes,
    ],
  });
  const r = checkDesign(q, d, "HEAD");
  assert.equal(r.planned.find((p) => p.name === "query me")!.status, "done");
  assert.equal(r.planned.find((p) => p.name === "mutation archiveUser")!.status, "missing");
});

/** A fake `claude` on PATH: logs its arguments and stdin, then answers like `--output-format stream-json`. */
function fakeClaude() {
  const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const log = join(bin, "args.json");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }));
  const sid = "s-" + (input.split(/\\s+/)[0].replace(/\\W/g, "") || "x");
  if (/lost/.test(input) && process.argv.includes("--resume")) { process.stderr.write("No conversation found with session ID: s-lost\\n"); process.exit(1); }
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid, slash_commands: ["clear", "plan", "ship"] }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm   test" } }, { type: "tool_use", name: "mcp__flowmap__design_get", input: {} }] } }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Overview: " + input }] } }));
  if (/slow/.test(input)) await new Promise((r) => setTimeout(r, 30000));
  console.log(JSON.stringify({ type: "result", is_error: false, session_id: sid }));
});
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return { args: () => JSON.parse(readFileSync(log, "utf8")), restore: () => { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); } };
}

const viewOf = (slug: string) => ({ chat: chatOf(slug), conversations: chatSummaries(readChats(engine.ws, slug)) });
const chatOf = (slug: string) => activeConversation(readChats(engine.ws, slug)).messages;

const turn = async (slug: string, text: string, mode: "full" | "design") => {
  const { runChat } = await import("../src/chat.ts");
  const events: any[] = [];
  await new Promise<void>((resolve) => runChat(engine, slug, text, mode, (e) => { events.push(e); if ((e as any).done) resolve(); }, () => {}));
  return events;
};

test("chat, design mode: only read tools + FlowMap, streams the reply and what Claude does", async () => {
  const fake = fakeClaude();
  try {
    const { claudeVersion } = await import("../src/chat.ts");
    assert.equal(claudeVersion(), "9.9.9");
    saveDesign(engine.ws, "chatty", draft(), "user");
    const events = await turn("chatty", "--help me", "design");
    const { args, input } = fake.args();
    assert.equal(input, "--help me", "message goes in on stdin, not as an argument");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.deepEqual(events.filter((e) => e.text).map((e) => e.text), ["Overview: --help me"]);
    assert.deepEqual(events.filter((e) => e.tool).map((e) => e.tool), ["Bash npm test", "flowmap › design_get"]);
    assert.ok(!events.at(-1).error);
    assert.deepEqual(chatOf("chatty"), [{ role: "user", text: "--help me" }, { role: "claude", text: "Overview: --help me", tools: ["Bash npm test", "flowmap › design_get"] }]);
  } finally {
    fake.restore();
  }
});

test("chat, full mode: no tool or MCP restrictions, every repo reachable, same conversation continues", async () => {
  const fake = fakeClaude();
  try {
    saveDesign(engine.ws, "chatty-full", draft(), "user");
    await turn("chatty-full", "first", "full");
    const first = fake.args().args;
    assert.equal(first[first.indexOf("--permission-mode") + 1], "bypassPermissions");
    for (const restricted of ["--tools", "--allowedTools", "--strict-mcp-config"]) assert.ok(!first.includes(restricted), restricted);
    assert.ok(first.includes("--mcp-config"), "FlowMap's design tools are still added");
    assert.ok(first[first.indexOf("--append-system-prompt") + 1].includes("full access"));
    const dirs = first.slice(first.indexOf("--add-dir") + 1).filter((a: string) => !a.startsWith("-"));
    assert.deepEqual(dirs.slice(0, engine.ws.config.repos.length).sort(), engine.ws.config.repos.map((r) => r.path).sort());
    await turn("chatty-full", "second", "full");
    const second = fake.args().args;
    assert.equal(second[second.indexOf("--resume") + 1], "s-first");
  } finally {
    fake.restore();
  }
});

test("chat: stopping keeps what Claude already wrote", async () => {
  const fake = fakeClaude();
  try {
    const { runChat, stopChat } = await import("../src/chat.ts");
    saveDesign(engine.ws, "chatty-stop", draft(), "user");
    assert.equal(stopChat("chatty-stop"), false, "nothing running");
    const events: any[] = [];
    await new Promise<void>((resolve) => runChat(engine, "chatty-stop", "slow please", "full", (e: any) => {
      events.push(e);
      if (e.text) assert.equal(stopChat("chatty-stop"), true);        // the fake now waits 30 s: stop it mid-answer
      if (e.done) resolve();
    }, () => {}));
    assert.ok(!events.at(-1).error, "a stop is not an error");
    assert.deepEqual(chatOf("chatty-stop").at(-1), { role: "claude", text: "Overview: slow please", tools: ["Bash npm test", "flowmap › design_get"] });
    assert.equal(stopChat("chatty-stop"), false);
  } finally {
    fake.restore();
  }
});

test("history: a new conversation keeps the old ones, and opening one continues its own Claude session", async () => {
  const fake = fakeClaude();
  try {
    const { newConversation, openConversation, deleteConversation } = await import("../src/chat.ts");
    saveDesign(engine.ws, "hist", draft(), "user");
    await turn("hist", "first topic", "design");
    const firstId = viewOf("hist").conversations[0].id;

    newConversation(engine, "hist");
    newConversation(engine, "hist");                                  // already on a blank one: no second blank
    let v = viewOf("hist");
    assert.deepEqual(v.chat, []);
    assert.deepEqual(v.conversations.map((c) => [c.title, c.count, c.active]), [["New conversation", 0, true], ["first topic", 2, false]]);

    await turn("hist", "second topic", "design");
    assert.ok(!fake.args().args.includes("--resume"), "a new conversation starts a fresh Claude session");
    v = viewOf("hist");
    assert.deepEqual(v.conversations.map((c) => c.title), ["second topic", "first topic"]);

    openConversation(engine, "hist", firstId);
    assert.deepEqual(chatOf("hist").map((m) => m.text), ["first topic", "Overview: first topic"]);
    await turn("hist", "first again", "design");
    const args = fake.args().args;
    assert.equal(args[args.indexOf("--resume") + 1], "s-first", "continues the first conversation, not the latest");

    deleteConversation(engine, "hist", firstId);                      // the open one: the other becomes the open one
    v = viewOf("hist");
    assert.deepEqual(v.conversations.map((c) => [c.title, c.active]), [["second topic", true]]);
    deleteConversation(engine, "hist", v.conversations[0].id);        // the last one: a blank one takes its place
    assert.deepEqual(viewOf("hist").conversations.map((c) => [c.count, c.active]), [[0, true]]);
    assert.throws(() => openConversation(engine, "hist", "c-nope"), (e: any) => e.status === 404);
  } finally {
    fake.restore();
  }
});

test("history: chats saved by the first version still open, as one earlier conversation", () => {
  saveDesign(engine.ws, "old-chat", draft(), "user");
  writeFileSync(join(designsDir(engine.ws), "old-chat.chat.json"), JSON.stringify({ session: "s-old", messages: [{ role: "user", text: "hello   there" }, { role: "claude", text: "hi" }] }));
  const v = viewOf("old-chat");
  assert.deepEqual(v.chat.map((m) => m.text), ["hello   there", "hi"]);
  assert.deepEqual(v.conversations.map((c) => [c.title, c.count, c.active]), [["hello there", 2, true]]);
});

test("history: if Claude has forgotten the session, the chat continues without its memory and says so", async () => {
  const fake = fakeClaude();
  try {
    saveDesign(engine.ws, "forgot", draft(), "user");
    writeFileSync(join(designsDir(engine.ws), "forgot.chat.json"), JSON.stringify({ session: "s-lost", messages: [{ role: "user", text: "earlier" }, { role: "claude", text: "ok" }] }));
    const events = await turn("forgot", "lost track", "design");
    assert.ok(!events.at(-1).error, "not an error");
    assert.ok(events.some((e) => /no longer remembers/.test(e.text ?? "")));
    assert.ok(!fake.args().args.includes("--resume"), "second attempt starts fresh");
    const chat = chatOf("forgot");
    assert.deepEqual(chat.map((m) => m.role), ["user", "claude", "user", "claude"]);
    assert.match(chat.at(-1)!.text, /Overview: lost track/);
  } finally {
    fake.restore();
  }
});

test("a new conversation is refused while Claude is answering", async () => {
  const fake = fakeClaude();
  try {
    const { newConversation, runChat, stopChat } = await import("../src/chat.ts");
    saveDesign(engine.ws, "busy", draft(), "user");
    await new Promise<void>((resolve) => runChat(engine, "busy", "slow", "design", (e: any) => {
      if (e.text) { assert.throws(() => newConversation(engine, "busy"), /still answering/); stopChat("busy"); }
      if (e.done) resolve();
    }, () => {}));
  } finally {
    fake.restore();
  }
});

test("flow: found by itself, the way from the entry points down to the change, always connected", () => {
  const map = new MapQueries(q);
  const SET = "backend:src/user/user.resolver.ts#UserResolver.setNickname";
  const d = draft({ nodes: [{ id: SET, change: "changed", kind: "Function", name: "UserResolver.setNickname", repo: "backend", author: "user" }], edges: [] });
  const r = designFlow(q, map, d, "compact");
  assert.equal(r.roots, 1);
  assert.equal(r.from[0].name, "/settings/profile", "screens first, then APIs");
  const names = r.flow.nodes.map((n) => n.name);
  for (const want of ["/settings/profile", "Profile", "setNicknameAction", "mutation setNickname", "UserResolver.setNickname"]) assert.ok(names.includes(want), `${want} in ${names}`);
  assert.ok(!names.includes("Stripe"), "Flow is the path to the change; what else the code does is Full detail");
  // every drawn node can be reached from the entry point by following the drawn arrows
  const out = new Map<string, string[]>();
  for (const e of r.flow.edges) out.set(e.src, [...(out.get(e.src) ?? []), e.dst]);
  const seen = new Set([r.from[0].id]), todo = [r.from[0].id];
  while (todo.length) for (const n of out.get(todo.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); todo.push(n); }
  assert.ok(seen.has(SET), "the entry point is connected to the change");
  assert.equal(new Set(r.flow.edges.map((e) => e.id)).size, r.flow.edges.length, "merged flows never share an edge id");
  const full = designFlow(q, map, d, "full").flow.nodes.map((n) => n.name);
  assert.ok(full.includes("Stripe") && full.includes("UserResolver.setNickname"), "Full detail adds everything those entry points do");
  assert.ok(full.length > r.flow.nodes.length);
});

test("flow: a design that only adds things uses the existing code its arrows attach to; an empty one has none", () => {
  const map = new MapQueries(q);
  const adds = designFlow(q, map, draft(), "compact");              // a new function writing the existing users table and calling Stripe
  assert.equal(adds.roots, 2);
  assert.ok(adds.flow.nodes.length > 0);
  const nothing = designFlow(q, map, draft({ nodes: [], edges: [] }), "compact");
  assert.deepEqual([nothing.roots, nothing.from, nothing.flow.nodes], [0, [], []]);
});

test("export: the diagram shows what the Changes view shows, not every stored node", () => {
  const SET = "backend:src/user/user.resolver.ts#UserResolver.setNickname";
  const d = draft({
    nodes: [
      { id: SET, change: "changed", kind: "Function", name: "UserResolver.setNickname", repo: "backend", author: "claude" },
      { id: "backend:table:org", change: "existing", kind: "Table", name: "org_unrelated", repo: "backend", author: "claude" },
      { id: USERS, change: "existing", kind: "Table", name: "users", repo: "backend", author: "claude" },
      { id: "new:x", change: "new", kind: "Function", name: "archiveIt", repo: "backend", author: "claude" },
    ],
    edges: [{ id: "e9", src: "new:x", dst: USERS, kind: "writes", change: "new", author: "claude" }],
  });
  const mm = toMermaid(designView(q, "x", d));
  assert.ok(mm.includes("UserResolver.setNickname") && mm.includes("archiveIt") && mm.includes("users"));
  assert.ok(!mm.includes("org_unrelated"), "an unrelated stored node is left out");
});

test("export: the template's headings are all recognised, and unwritten placeholders never reach the document", () => {
  const untouched = toMarkdown(designView(q, "x", draft({ rfc: RFC_TEMPLATE })));
  for (const placeholder of ["- Goal:", "- Non-goal:", "First change: what", "Option: why not"]) assert.ok(!untouched.includes(placeholder), placeholder);
  assert.ok(!untouched.includes("## Problem") && !untouched.includes("## Rollout"), "no empty sections");

  const written = RFC_TEMPLATE
    .replace("- What is wrong or missing today? Use numbers where you can.", "- Duplicate callbacks double-charge about 3 users a week.")
    .replace("- Order of deploys, flags and migrations, and how to roll back.", "- Column, then index, then code.");
  const md = toMarkdown(designView(q, "x", draft({ rfc: written })));
  const order = ["## Problem", "## What changes", "## Impact and risks", "## Rollout"];
  let at = -1;
  for (const h of order) { const i = md.indexOf(h); assert.ok(i > at, `${h} is missing or out of order`); at = i; }
  assert.ok(md.includes("double-charge about 3 users") && !md.includes("## Open questions"), "the template has no open-questions section");
  assert.ok(!md.includes("## Risks and impact"), "the section is named once, by FlowMap");
});

test("chatArgs passes the chosen model only when one is set", async () => {
  const { chatArgs } = await import("../src/chat.ts");
  assert.ok(!chatArgs(engine, "m", "design").includes("--model"));
  const a = chatArgs(engine, "m", "design", undefined, "opus");
  assert.equal(a[a.indexOf("--model") + 1], "opus");
});

test("free boxes and columns: boxes are not code, columns reach the RFC, tables list their columns", () => {
  const users = q.view(engine.graph.nodes.get(USERS)!);
  assert.ok(Array.isArray(users.attrs.columns) && (users.attrs.columns as { name: string }[]).length > 0, "a TypeORM table carries its columns");

  const d = draft({
    nodes: [
      ...draft().nodes,
      { id: "new:step", change: "new", kind: "Box", name: "Support approves", repo: "", author: "user", shape: "decision", items: [{ text: "within 24h" }, { text: "else escalate" }] },
    ],
    edges: [...draft().edges, { id: "e9", src: "new:step", dst: "new:archive-op", kind: "calls", change: "new", author: "user" }],
  });
  d.nodes.find((n) => n.id === USERS)!.change = "changed";
  d.nodes.find((n) => n.id === USERS)!.items = [{ text: "archived_at timestamptz", new: true }];

  saveDesign(engine.ws, "boxes", { ...d, version: 0 }, "user");
  const parsed = readDesign(engine.ws, "boxes");
  assert.equal(parsed.nodes.find((n) => n.id === "new:step")?.shape, "decision");

  const view = designView(q, "boxes");
  assert.deepEqual(view.impact.introduced.filter((i) => i.nodeId === "new:step"), [], "a box takes no part in the checks");
  const md = toMarkdown(view);
  assert.ok(!/Support approves/.test(md.split("## Steps in the diagram")[0].split("## What changes")[1] ?? ""), "not in the change table");
  assert.match(md, /## Steps in the diagram\n- \*\*Support approves\*\*: within 24h; else escalate/);
  assert.match(md, /## Data changes\n- `users` \(changing\): \+ `archived_at timestamptz`/);
  assert.ok(!checkDesign(q, parsed).planned.some((p) => p.name === "Support approves"), "nothing to look for in code");
});

test("agent without a design: its own history, kept apart from the designs", async () => {
  const fake = fakeClaude();
  try {
    await turn(GLOBAL_CHAT, "show me how a nickname is saved", "design");
    const args = fake.args().args;
    assert.match(args[args.indexOf("--append-system-prompt") + 1], /FlowMap agent/);
    assert.equal(readChats(engine.ws, GLOBAL_CHAT).conversations[0].messages.length, 2);
    assert.ok(!listDesigns(engine.ws).some((d) => d.slug === GLOBAL_CHAT), "the agent's history is not a design");
  } finally {
    fake.restore();
  }
});

test("`/` menu: Claude's own list of commands (fetched once, then kept), with our descriptions", async () => {
  const home = mkdtempSync(join(tmpdir(), "claude-home-"));
  mkdirSync(join(home, "skills", "plan"), { recursive: true });
  writeFileSync(join(home, "skills", "plan", "SKILL.md"), "---\nname: plan\ndescription: Make a plan before coding\n---\nsecret body\n");
  mkdirSync(join(home, "commands"), { recursive: true });
  writeFileSync(join(home, "commands", "ship.md"), "---\ndescription: Ship it\n---\nbody\n");
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  const fake = fakeClaude();
  const fresh = { ws: { dir: mkdtempSync(join(tmpdir(), "flowmap-ws-")), config: engine.ws.config } } as typeof engine;
  try {
    const { claudeCommands } = await import("../src/chat.ts");
    const expected = [{ name: "clear", description: "" }, { name: "plan", description: "Make a plan before coding" }, { name: "ship", description: "Ship it" }];
    assert.deepEqual(await claudeCommands(fresh), expected, "asked of claude itself: the names are its own");
    assert.deepEqual(JSON.parse(readFileSync(join(fresh.ws.dir, ".flowmap", "claude-commands.json"), "utf8")), ["clear", "plan", "ship"], "and kept for next time");
    rmSync(join(home, "commands"), { recursive: true });
    assert.deepEqual((await claudeCommands(fresh)).map((c) => c.name), ["clear", "plan", "ship"], "no second start of claude");
  } finally {
    fake.restore();
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(home, { recursive: true, force: true });
    rmSync(fresh.ws.dir, { recursive: true, force: true });
  }
});

test("context lists what to read and a table's columns; a short RFC template leaves no empty headings", () => {
  const ctx = designContext(q, "let users change their nickname", "setNickname");
  assert.match(ctx, /## Read these before you propose changes/);
  assert.match(ctx, /users \(id [^)]+\): \d+ reader\(s\), \d+ writer\(s\) · columns: .*nickname/);
  const md = toMarkdown(designView(q, "x", draft({ rfc: RFC_TEMPLATE_SHORT })));
  assert.ok(!/## (Problem|Proposal|Rollout)/.test(md), "untouched short template sections are left out");
});

test("a drawn diagram: free boxes with points, code links as file:line, never over an existing design, ignored by the checks", () => {
  const input = {
    title: "How a nickname is saved", summary: "Three steps.",
    steps: [
      { key: "form", title: "User submits", points: ["from the profile page"] },
      { key: "save", title: "API saves it", points: ["checks the caller"], code: "UserService.setNickname" },
      { key: "ok", title: "Allowed?", shape: "decision" as const },
    ],
    arrows: [{ from: "form", to: "save" }, { from: "save", to: "ok" }],
  };
  const d = buildDiagram(q, input);
  assert.deepEqual(d.nodes.map((n) => [n.id, n.kind, n.change]), [["new:form", "Box", "new"], ["new:save", "Box", "new"], ["new:ok", "Box", "new"]]);
  const svc = q.resolve("UserService.setNickname")!;
  assert.deepEqual(d.nodes[1].items?.map((i) => i.text), ["checks the caller", `${svc.repo}/${svc.file}:${svc.line}`], "the real code is found by its file and line");
  assert.equal(d.nodes[2].shape, "decision");
  assert.throws(() => buildDiagram(q, { ...input, arrows: [{ from: "form", to: "nowhere" }] }), /names a step that is not in steps/);
  assert.throws(() => buildDiagram(q, { ...input, steps: [input.steps[0], input.steps[0]] }), /own key/);

  const first = saveDiagram(q, input);
  assert.equal(first, "diagram-how-a-nickname-is-saved");
  assert.equal(saveDiagram(q, input), `${first}-2`, "drawing the same title again keeps the first, which may hold your edits");
  const view = designView(q, first);
  assert.deepEqual(view.impact.introduced, [], "boxes take no part in the checks");
  assert.match(toMarkdown(view), /## Steps in the diagram\n- \*\*User submits\*\*: from the profile page/);
});

test("deleting a design removes its files for good; clearing a chat removes the whole history", async () => {
  saveDesign(engine.ws, "doomed", draft(), "user");
  writeFileSync(join(designsDir(engine.ws), "doomed.chat.json"), JSON.stringify({ session: "s", messages: [{ role: "user", text: "hi" }] }));
  deleteDesign(engine.ws, "doomed");
  assert.ok(!existsSync(join(designsDir(engine.ws), "doomed.json")) && !existsSync(join(designsDir(engine.ws), "doomed.chat.json")), "both files are gone");
  assert.throws(() => deleteDesign(engine.ws, "doomed"), /No design/);
  assert.throws(() => deleteDesign(engine.ws, "../x"), /Invalid design name/);
  symlinkSync("/etc/hosts", join(designsDir(engine.ws), "linked-del.json"));
  assert.throws(() => deleteDesign(engine.ws, "linked-del"), /symlink/);
  assert.ok(existsSync("/etc/hosts"), "a symlink is never followed");

  const fake = fakeClaude();
  try {
    await turn(GLOBAL_CHAT, "hello", "design");
    assert.ok(readChats(engine.ws, GLOBAL_CHAT).conversations[0].messages.length > 0);
    const { clearConversations } = await import("../src/chat.ts");
    clearConversations(engine, GLOBAL_CHAT);
    assert.ok(!existsSync(join(designsDir(engine.ws), `${GLOBAL_CHAT}.chat.json`)), "the history file is gone");
    assert.deepEqual(readChats(engine.ws, GLOBAL_CHAT).conversations.flatMap((c) => c.messages), [], "and the agent starts blank");
  } finally {
    fake.restore();
  }
});

test("moving the dashboard from outside: only checked places are written or followed", () => {
  const svc = q.resolve("UserService.setNickname")!;
  assert.deepEqual(pageNav(engine, { page: "changes", base: "main", head: "feature/x" }), { type: "ui", action: "page", id: "changes?base=main&head=feature%2Fx" });
  assert.deepEqual(pageNav(engine, { page: "changes", head: "--output=x" }), { type: "ui", action: "page", id: "changes" }, "a branch name git could read as an option is dropped");
  assert.deepEqual(pageNav(engine, { page: "issues", severity: "error", search: "a&b" }), { type: "ui", action: "page", id: "issues?severity=error&q=a%26b" });
  assert.deepEqual(pageNav(engine, { page: "explore", target: "UserService.setNickname" }), { type: "ui", action: "page", id: `explore/${encodeURIComponent(svc.id)}` });
  assert.equal(pageNav(engine, { page: "../etc" }), null);
  assert.equal(pageNav(engine, { page: "designs", slug: "../x" })?.id, "designs", "an unsafe design name is dropped");

  sendNav(engine, { type: "ui", action: "design", id: "archive-users" });
  assert.deepEqual(readNav(engine), { type: "ui", action: "design", id: "archive-users" });
  sendNav(engine, { type: "ui", action: "design", id: "../x" });
  assert.equal(readNav(engine), null, "a hand-edited file is checked again when it is read");
  writeFileSync(join(engine.ws.dir, ".flowmap", "nav.json"), JSON.stringify({ nav: { type: "ui", action: "page", id: "issues" }, at: Date.now() - 60_000 }));
  assert.equal(readNav(engine), null, "an old place is not followed");
});
