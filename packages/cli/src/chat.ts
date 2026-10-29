import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMode, ClaudeStatus, ServerEvent } from "@flowmap/core";
import type { Engine } from "./engine.ts";
import { activeConversation, clearChats, CONVERSATION_ID, conversationId, DesignError, GLOBAL_CHAT, MAX_CONVERSATIONS, readChats, readDesign, titleOf, writeChats } from "./designs.ts";

const BIN = fileURLToPath(new URL("../bin/flowmap.js", import.meta.url));
const SKILL = fileURLToPath(new URL("../../../claude-plugin/skills/design/SKILL.md", import.meta.url));
// "design" mode: Claude may read code and use FlowMap (its only write: the design file); no edits, no shell, nothing else
const TOOLS = ["Read", "Grep", "Glob"];
const ALLOWED = [...TOOLS, "mcp__flowmap"];
/** Model aliases the `claude` CLI understands; empty means the user's own default. */
export const MODELS = ["opus", "sonnet", "haiku"];
const FULL = `Outside the design workflow you are a normal Claude Code session with full access here: read and edit code, run commands, use the user's skills and connectors, as in a terminal. While the user is planning a feature, only change the design; when they ask you to build, fix or do something else, do it.`;

let version: string | null | undefined;

/** Installed Claude Code version, or null when `claude` isn't on PATH. */
export function claudeVersion(): string | null {
  if (version !== undefined) return version;
  try {
    version = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split(" ")[0] || null;
  } catch {
    version = null;
  }
  return version;
}

const claude = (args: string[]) => new Promise<string | null>((resolve) =>
  execFile("claude", args, { timeout: 20_000 }, (err, out) => resolve(err ? null : out)));

/** One line about each skill and command, from Claude's config folder and each repo (Claude's own list has names only). Read-only. */
function descriptions(engine: Engine): Map<string, string> {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const found = new Map<string, string>();
  const frontmatter = (file: string) => /^description:\s*(.+)$/m.exec(readFileSync(file, "utf8").split(/^---\s*$/m)[1] ?? "")?.[1]?.trim().slice(0, 200) ?? "";
  for (const base of [home, ...engine.ws.config.repos.map((r) => join(r.path, ".claude"))]) {
    try {
      for (const d of readdirSync(join(base, "skills"), { withFileTypes: true })) {
        if (!d.isDirectory() || found.has(d.name)) continue;
        try { found.set(d.name, frontmatter(join(base, "skills", d.name, "SKILL.md"))); } catch { /* not a skill folder */ }
      }
    } catch { /* no skills here */ }
    try {
      for (const f of readdirSync(join(base, "commands"))) if (f.endsWith(".md") && !found.has(f.slice(0, -3))) found.set(f.slice(0, -3), frontmatter(join(base, "commands", f)));
    } catch { /* no commands here */ }
  }
  return found;
}

// ---- what `/` offers: the commands this Claude Code accepts, as it reports them itself (nothing is hard-coded) ----
// Every run starts with a message that lists them. We keep the last list; before any run, one short start of `claude` fetches it.
const listFile = (engine: Engine) => join(engine.ws.dir, ".flowmap", "claude-commands.json");
const remembered = new Map<string, string[]>();
const remember = (engine: Engine, names: string[]) => {
  remembered.set(engine.ws.dir, names);
  try { mkdirSync(join(engine.ws.dir, ".flowmap"), { recursive: true }); writeFileSync(listFile(engine), JSON.stringify(names)); } catch { /* the list is only a cache */ }
};
const recall = (engine: Engine): string[] | null => {
  const names = remembered.get(engine.ws.dir);
  if (names) return names;
  try {
    const saved = JSON.parse(readFileSync(listFile(engine), "utf8"));
    return Array.isArray(saved) && saved.every((n) => typeof n === "string") ? saved : null;
  } catch { return null; }
};

/** Starts `claude` only until it has said which commands it has, then stops it. */
function probe(engine: Engine): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "x", "--output-format", "stream-json", "--verbose"], { cwd: engine.ws.dir, stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    const finish = (names: string[]) => { clearTimeout(timer); child.kill(); resolve(names); };
    const timer = setTimeout(() => finish([]), 20_000);
    child.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        try { const m = JSON.parse(line); if (m.type === "system" && m.subtype === "init" && Array.isArray(m.slash_commands)) return finish(m.slash_commands.filter((n: unknown) => typeof n === "string")); } catch { /* a partial line */ }
      }
    });
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));
  });
}

let probing: Promise<string[]> | null = null;

/** What `/` can start in the agent's box: Claude's own list of commands, each with its description when we have one. */
export async function claudeCommands(engine: Engine): Promise<{ name: string; description: string }[]> {
  const about = descriptions(engine);
  let names = recall(engine);
  if (!names) {
    probing ??= probe(engine).finally(() => { probing = null; });
    names = await probing;
    if (names.length) remember(engine, names);
  }
  return (names.length ? names : [...about.keys()]).map((name) => ({ name, description: about.get(name) ?? "" })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Installed? Signed in? FlowMap plugin added? Local checks only, nothing is sent anywhere. */
export async function claudeStatus(): Promise<ClaudeStatus> {
  const version = (await claude(["--version"]))?.trim().split(" ")[0] || null;
  if (!version) return { version, signedIn: false, plugin: false };
  const [auth, plugins] = await Promise.all([claude(["auth", "status", "--json"]), claude(["plugin", "list", "--json"])]);
  let signedIn = false;
  try { signedIn = JSON.parse(auth ?? "{}").loggedIn === true; } catch {}
  return { version, signedIn, plugin: /"flowmap@/.test(plugins ?? "") };
}

/**
 * Arguments for one headless turn; exported for tests.
 * "full" loads everything a normal session has (all tools, the user's settings, skills, hooks and MCP servers) and, since nobody can
 * answer permission prompts in a headless run, approves tool use up front. "design" is the read-only, FlowMap-only sandbox.
 */
export function chatArgs(engine: Engine, slug: string, mode: ChatMode, session?: string, model?: string, page?: string): string[] {
  const mcp = { mcpServers: { flowmap: { command: process.execPath, args: [BIN, "mcp", "-w", engine.ws.dir] } } };
  const skill = readFileSync(SKILL, "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const where = slug === GLOBAL_CHAT
    ? `You are the FlowMap agent inside the dashboard, and you control it. Answer questions about the code with the FlowMap tools, and move the user's dashboard instead of only describing things: to show or trace a flow call show_flow; to take them to any page (overview, map, issues, rules, changes between two branches, tables, designs) call go_to; to start or open a design call design_save then open_design (choose a short slug), and keep drawing it with design_save so it appears on the canvas. When the user wants something drawn in their own way (simpler, fewer boxes, a process, a comparison, any flow that is not a change to the code), call draw_diagram: at most 8 steps, a short title and one to three short points each, and name the real code a step stands for in \`code\`; it opens on the canvas for them to edit, and you can change it later with design_save.`
    : `You are chatting with the user inside the FlowMap dashboard, next to the canvas of the design "${slug}" (save it with design_save, slug "${slug}"). Call show_flow to put a flow on their screen when it helps.`;
  const prompt = `${skill}\n\n${where} Keep replies short and in Markdown.${page ? ` The user is looking at: ${page.replace(/\s+/g, " ")}.` : ""}${mode === "full" ? `\n\n${FULL}` : ""}`;
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    "--mcp-config", JSON.stringify(mcp), "--append-system-prompt", prompt,
    "--add-dir", ...new Set(engine.ws.config.repos.map((r) => r.path)),     // every repo of the workspace, not only the folder it runs in
    ...(session ? ["--resume", session] : []),
    ...(model ? ["--model", model] : []),
    ...(mode === "full"
      ? ["--permission-mode", "bypassPermissions"]
      : ["--tools", TOOLS.join(","), "--allowedTools", ALLOWED.join(","), "--permission-mode", "dontAsk", "--strict-mcp-config"]),
  ];
}

const running = new Map<string, ChildProcess>();

/** Stops Claude's current answer (what it already wrote is kept). */
export function stopChat(slug: string): boolean {
  return running.get(slug)?.kill() ?? false;
}

// ---- the history: every conversation about a design is kept, one is open ----

function idle(engine: Engine, slug: string) {
  if (slug !== GLOBAL_CHAT) readDesign(engine.ws, slug);
  if (running.has(slug)) throw new DesignError("Claude is still answering.", 409);
}

/** Opens a blank conversation and keeps the others. (Already on a blank one: nothing to do.) */
export function newConversation(engine: Engine, slug: string) {
  idle(engine, slug);
  const store = readChats(engine.ws, slug);
  if (!activeConversation(store).messages.length) return;
  const id = conversationId();
  store.conversations.unshift({ id, title: "", updatedAt: new Date().toISOString(), messages: [] });
  store.active = id;
  writeChats(engine.ws, slug, store);
}

export function openConversation(engine: Engine, slug: string, id: string) {
  idle(engine, slug);
  const store = readChats(engine.ws, slug);
  if (!CONVERSATION_ID.test(id) || !store.conversations.some((c) => c.id === id)) throw new DesignError("No such conversation.", 404);
  store.active = id;
  store.conversations = store.conversations.filter((c) => c.id === id || c.messages.length);      // a blank one left behind is not worth keeping
  writeChats(engine.ws, slug, store);
}

/** Deletes the whole history of a chat for good. */
export function clearConversations(engine: Engine, slug: string) {
  idle(engine, slug);
  clearChats(engine.ws, slug);
}

export function deleteConversation(engine: Engine, slug: string, id: string) {
  idle(engine, slug);
  const store = readChats(engine.ws, slug);
  if (!CONVERSATION_ID.test(id) || !store.conversations.some((c) => c.id === id)) throw new DesignError("No such conversation.", 404);
  store.conversations = store.conversations.filter((c) => c.id !== id);
  if (store.active === id) {
    const next = store.conversations.find((c) => c.messages.length);
    if (next) store.active = next.id;
    else {
      store.active = conversationId();
      store.conversations.unshift({ id: store.active, title: "", updatedAt: new Date().toISOString(), messages: [] });
    }
  }
  writeChats(engine.ws, slug, store);
}

/** "Bash npm test", "Edit src/a.ts": what Claude is doing, for the chat panel. */
function brief(c: { name?: string; input?: Record<string, unknown> }): string {
  const i = c.input ?? {};
  const arg = [i.command, i.file_path, i.path, i.pattern, i.query, i.url].find((x) => typeof x === "string" && x) as string | undefined;
  return `${String(c.name).replace(/^mcp__/, "").replace(/__/g, " › ")}${arg ? ` ${arg.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
}

const FORGOTTEN = "(Claude no longer remembers this earlier conversation, so it starts fresh from here. Everything above is kept.)";

/** One chat turn: the user's message goes to the local `claude` CLI; its replies stream to the dashboard as `chat` events. */
export function runChat(engine: Engine, slug: string, text: string, mode: ChatMode, emit: (e: ServerEvent) => void, log: (s: string) => void, model?: string, page?: string) {
  idle(engine, slug);
  if (!claudeVersion()) throw new DesignError("Claude Code is not installed (the `claude` command was not found).", 400);
  const first = readChats(engine.ws, slug);
  const conv = activeConversation(first);
  conv.messages.push({ role: "user", text });
  conv.title ||= titleOf(text);
  conv.updatedAt = new Date().toISOString();
  first.conversations = [conv, ...first.conversations.filter((c) => c !== conv && c.messages.length)].slice(0, MAX_CONVERSATIONS);
  writeChats(engine.ws, slug, first);
  const id = conv.id;

  const reply: string[] = [];
  const tools: string[] = [];
  let session = conv.session;
  let answeredBy: string | undefined;           // what Claude actually answered with

  const start = (resume: boolean) => {
    const child = spawn("claude", chatArgs(engine, slug, mode, resume ? session : undefined, model, page), { cwd: engine.ws.dir, stdio: ["pipe", "pipe", "pipe"] });
    running.set(slug, child);
    child.stdin.on("error", () => {});          // claude exited before reading: its exit is reported below
    child.stdin.end(text);                      // the message goes in on stdin, never as an argument
    let error = "";
    let buf = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.session_id) session = m.session_id;
        if (m.type === "system" && m.subtype === "init" && Array.isArray(m.slash_commands)) remember(engine, m.slash_commands.filter((n: unknown) => typeof n === "string"));
        if (m.type === "assistant") {
          answeredBy = m.message?.model ?? answeredBy;
          for (const c of m.message?.content ?? []) {
            if (c.type === "text" && c.text) {
              reply.push(c.text);
              emit({ type: "chat", slug, text: c.text });
            } else if (c.type === "tool_use") {
              tools.push(brief(c));
              emit({ type: "chat", slug, tool: tools.at(-1) });
            }
          }
        }
        if (m.type === "result" && m.is_error) error = String(m.result ?? "Claude stopped with an error");
      }
    });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    const finish = (failure?: string) => {
      if (running.get(slug) !== child) return;
      running.delete(slug);
      // Claude can't resume a conversation it has cleaned up on its own side: say so and carry on without its memory
      if (failure && resume && session && /no conversation found/i.test(failure)) {
        session = undefined;
        reply.push(FORGOTTEN);
        emit({ type: "chat", slug, text: FORGOTTEN });
        return start(false);
      }
      const latest = readChats(engine.ws, slug);
      const c = latest.conversations.find((x) => x.id === id);
      if (c) {
        if (reply.length) c.messages.push({ role: "claude", text: reply.join("\n\n"), ...(answeredBy ? { model: answeredBy } : {}), ...(tools.length ? { tools: tools.slice(0, 100) } : {}) });
        if (session) c.session = session;
        else delete c.session;
        c.updatedAt = new Date().toISOString();
        writeChats(engine.ws, slug, latest);
      }
      if (failure) log(`chat (${slug}) failed: ${failure}`);
      emit({ type: "chat", slug, done: true, ...(failure ? { error: failure } : {}) });
    };
    child.on("error", (err) => finish(err.message));
    child.on("close", (code) => finish(error || stderr.match(/no conversation found[^\n]*/i)?.[0] || (code ? stderr.trim().split("\n").pop() || `claude exited with code ${code}` : undefined)));
  };
  start(true);
}
