import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChatMode, ClaudeStatus, ServerEvent } from "@flowmap/core";
import type { Engine } from "./engine.ts";
import { activeConversation, CONVERSATION_ID, conversationId, DesignError, MAX_CONVERSATIONS, readChats, readDesign, titleOf, writeChats } from "./designs.ts";

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
export function chatArgs(engine: Engine, slug: string, mode: ChatMode, session?: string, model?: string): string[] {
  const mcp = { mcpServers: { flowmap: { command: process.execPath, args: [BIN, "mcp", "-w", engine.ws.dir] } } };
  const skill = readFileSync(SKILL, "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const prompt = `${skill}\n\nYou are chatting with the user inside the FlowMap dashboard, next to the canvas of the design "${slug}" (save it with design_save, slug "${slug}"). Keep replies short and in Markdown.${mode === "full" ? `\n\n${FULL}` : ""}`;
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
  readDesign(engine.ws, slug);
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
export function runChat(engine: Engine, slug: string, text: string, mode: ChatMode, emit: (e: ServerEvent) => void, log: (s: string) => void, model?: string) {
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
    const child = spawn("claude", chatArgs(engine, slug, mode, resume ? session : undefined, model), { cwd: engine.ws.dir, stdio: ["pipe", "pipe", "pipe"] });
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
