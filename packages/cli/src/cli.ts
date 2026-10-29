import { parseArgs } from "node:util";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { detectDeps, gitRoot, ignoreIndex } from "@flowmap/core";
import { builtinPlugins } from "@flowmap/plugins";
import { Engine } from "./engine.ts";
import { changesBetween } from "./refs.ts";
import { Queries } from "./queries.ts";
import { MapQueries } from "./map.ts";
import { formatArchitecture, formatChanges, formatDesignCheck, formatExplain, formatIssues, formatIssuesMarkdown, formatMap, formatPaths, formatRefs, formatSuggestions, formatTree, setColor } from "./format.ts";

const HELP = `FlowMap — see how your code flows, from screen to database.

Usage: flowmap <command> [options]

Setup
  init [--connect <repo path>]... [--yes|--no-claude]   add flowmap.config.mjs (auto-detects plugins), offer the Claude Code plugin
  index [--full]                                     build / update the index
  hooks install                                      re-index after git pull/checkout (local hooks)

Explore
  dev [--port 4400] [--no-open] [--keep-token]       dashboard + live re-index on save and config change
  trace <target> [--up] [--depth 3] [--side-effects] tree of what it does (or who uses it)
  explain <target>                                   screens, guards, tables, external calls, issues
  impact <target>                                    everything upstream that depends on it
  reachable <target>                                 is it reachable from any screen?
  search <query>                                     find screens, APIs, functions, tables
  map [screens|apis|jobs|services] [filter]          every screen / API / job, or which service calls which
  screenshots [--login] [--only <text>] [--changed] [--mobile] [--dark]   capture screens from your running app, read-only

Review
  check [--all|--new] [--base <ref>] [--format text|json|md]   new issues (default: in changed code)
  check --design <name> [--base <ref>]               does the code match the design? (planned, unplanned, new issues)
  changes [--base <ref>] [--head <ref>]              what your branch affects; with --head, compares two branches without checking either out
  baseline update                                    accept current issues as the baseline
  doctor                                             index health and accuracy report

Integrations
  mcp                                                MCP server for Claude Code (stdio)

Options: -w, --workspace <dir>   --no-color`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: "string", short: "w" },
    full: { type: "boolean" },
    port: { type: "string", default: "4400" },
    "no-open": { type: "boolean" },
    "keep-token": { type: "boolean" },
    up: { type: "boolean" },
    depth: { type: "string", default: "3" },
    "side-effects": { type: "boolean" },
    all: { type: "boolean" },
    new: { type: "boolean" },
    base: { type: "string" },
    head: { type: "string" },
    design: { type: "string" },
    format: { type: "string", default: "text" },
    connect: { type: "string", multiple: true },
    force: { type: "boolean" },
    quiet: { type: "boolean", short: "q" },
    only: { type: "string" },
    changed: { type: "boolean" },
    login: { type: "boolean" },
    mobile: { type: "boolean" },
    dark: { type: "boolean" },
    "no-color": { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    "no-claude": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...args] = positionals;
const log = (s: string) => { if (!opts.quiet) console.error(s); };
if (opts["no-color"]) setColor(false);

async function engine(refresh = true) {
  const e = await Engine.open(opts.workspace);
  e.ws.config.warnings.forEach((w) => log(`warning: ${w}`));
  if (refresh) {
    const started = Date.now();
    const s = e.refresh(opts.full);
    if (s.changed > 50) log(`indexed ${s.changed} file(s) in ${Date.now() - started} ms`);
  }
  return e;
}

function target(q: Queries) {
  const name = args.join(" ");
  if (!name) throw new Error(`Usage: flowmap ${cmd} <target>`);
  const n = q.resolve(name);
  if (!n) throw new Error(`Nothing named "${name}". Try: flowmap search ${name}`);
  return n;
}

async function main() {
  if (!cmd || opts.help) return console.log(HELP);
  switch (cmd) {
    case "init": return init();
    case "index": {
      const e = await Engine.open(opts.workspace);
      const s = e.refresh(opts.full);
      const q = new Queries(e);
      const st = q.status();
      log(`${s.files} files · ${s.changed} parsed · ${s.removed} removed · ${s.durationMs} ms`);
      log(`${st.counts.nodes} nodes · ${st.counts.edges} edges · ${e.issues.length} issues (${e.issues.filter((i) => i.status === "new").length} new)`);
      log(`index: ${e.ws.dbPath}`);
      return;
    }
    case "dev": {
      const { serveDashboard } = await import("./server.ts");
      const e = await engine();
      await serveDashboard(e, { port: Number(opts.port), open: !opts["no-open"], keepToken: opts["keep-token"], log: (s) => console.error(s) });
      return;
    }
    case "trace": {
      const q = new Queries(await engine());
      const n = target(q);
      const dir = opts.up ? "up" : "down";
      return console.log(formatTree(q.subgraph(n.id, dir, Number(opts.depth), !!opts["side-effects"], 200), dir));
    }
    case "explain": {
      const q = new Queries(await engine());
      return console.log(formatExplain(q.explain(target(q).id)));
    }
    case "impact": {
      const q = new Queries(await engine());
      const r = q.impact(target(q).id);
      return console.log(formatRefs({ APIs: r.operations, Screens: r.screens, Components: r.components, "Client calls": r.clientCalls, Jobs: r.jobs, Functions: r.functions }));
    }
    case "reachable": {
      const q = new Queries(await engine());
      const r = q.reachable(target(q).id);
      console.log(r.reachable ? formatPaths(r.paths) : "Not reachable from any routed screen.");
      process.exitCode = r.reachable ? 0 : 1;
      return;
    }
    case "map": {
      const m = new MapQueries(new Queries(await engine()));
      const view = (["screens", "apis", "jobs", "services"].includes(args[0]) ? args[0] : "screens") as "screens" | "apis" | "jobs" | "services";
      const filter = args.slice(["screens", "apis", "jobs", "services"].includes(args[0]) ? 1 : 0).join(" ");
      return console.log(view === "services" ? formatArchitecture(m.architecture()) : formatMap(m.appMap(), view, filter));
    }
    case "screenshots": {
      const { captureScreens, loginBrowser } = await import("./shots.ts");
      const e = await engine();
      if (opts.login) return loginBrowser(e, log);
      const r = await captureScreens(e, { only: opts.only, changed: opts.changed, mobile: opts.mobile, dark: opts.dark, log });
      return log(`${r.captured} ${r.variant} screenshot(s) saved in .flowmap/screens${r.skipped ? ` · ${r.skipped} skipped` : ""}${r.blocked ? ` · ${r.blocked} write request(s) blocked` : ""}`);
    }
    case "search": {
      const q = new Queries(await engine());
      return console.log(q.search(args.join(" "), undefined, 30).map((h) => `[${h.kind}] ${h.name}  ${h.repo}/${h.file}:${h.line}`).join("\n") || "No matches.");
    }
    case "changes": {
      const e = await engine();
      return console.log(formatChanges(opts.head ? await changesBetween(e, opts.base, opts.head) : new Queries(e).changes(opts.base)));
    }
    case "check": return check();
    case "baseline": {
      if (args[0] !== "update") throw new Error("Usage: flowmap baseline update");
      const e = await engine();
      return log(`Baseline saved:\n${e.saveBaseline().map((f) => `  ${f}`).join("\n")}`);
    }
    case "doctor": return doctor();
    case "hooks": return installHooks();
    case "hook": return stopHook();
    case "mcp": {
      const { serveMcp } = await import("./mcp.ts");
      return serveMcp(await engine(false));
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run flowmap --help`);
  }
}

async function check() {
  const e = await engine();
  const q = new Queries(e);
  if (opts.design) {
    const { checkDesign, readDesign } = await import("./designs.ts");
    const r = checkDesign(q, readDesign(e.ws, opts.design), opts.base);
    console.log(formatDesignCheck(r));
    if (r.planned.some((p) => p.status === "missing") || r.issues.some((i) => i.severity === "error")) process.exitCode = 1;
    return;
  }
  const list = opts.all ? q.issues() : opts.new ? q.issues({ status: "new" }) : q.changes(opts.base).issues;
  if (opts.format === "json") console.log(JSON.stringify(list, null, 2));
  else if (opts.format === "md") console.log(formatIssuesMarkdown(list));
  else {
    console.log(formatIssues(list, { why: true }));
    log(`\n${list.length} issue(s) · ${list.filter((i) => i.severity === "error").length} error(s) · scope: ${opts.all ? "all" : opts.new ? "new vs baseline" : "new in changed code"}`);
  }
  if (list.some((i) => i.severity === "error")) process.exitCode = 1;
}

const FLOWMAP_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PLUGIN_STEPS = [["plugin", "marketplace", "add", FLOWMAP_ROOT], ["plugin", "install", "flowmap@flowmap"]];

async function init() {
  const root = gitRoot(process.cwd()) ?? process.cwd();
  const file = join(root, "flowmap.config.mjs");
  if (existsSync(file) && !opts.force) {
    // already set up (e.g. by a teammate): leave the config alone, only offer the Claude step
    console.log(`${file} already exists, left unchanged (--force overwrites it).${opts.connect?.length ? " --connect was not applied: add the repos to `connect` in it." : ""}`);
    if (!opts["no-claude"]) await setupClaude();
    return console.log("\nNext: flowmap dev");
  }
  const deps = detectDeps(root);
  const plugins = builtinPlugins.filter((p) => p.detect?.(deps)).map((p) => p.id);
  if (deps.python && !plugins.some((id) => builtinPlugins.find((p) => p.id === id)?.extractPy)) plugins.push("python");
  const connect = (opts.connect ?? []).map((c) => relative(root, join(process.cwd(), c)) || ".");
  writeFileSync(file, `// FlowMap config — commit this file. The local index (.flowmap/) is git-ignored.
export default {
  name: ${JSON.stringify(basename(root))},
  plugins: ${JSON.stringify(plugins)},
  // Sibling repos this one talks to (each has its own flowmap.config.mjs), e.g. the backend of this frontend:
  connect: ${JSON.stringify(connect)},
  // Your own API wrappers: which argument holds the operation name / gql document
  clients: [],
  // Classes in this repo that talk to outside services, e.g. { PaymentsService: "Stripe" }
  externals: {},
  ignore: ["**/migrations/**", "**/*.spec.ts", "**/*.test.ts", "**/__tests__/**"],
  rules: {}, // e.g. { "n-plus-one": "off", "tx-external-call": "warn" }
  // base: "origin/main", // branch that "changes" and "check" compare against
};
`);
  const ignored = ignoreIndex(root);
  console.log(`Created ${file}\nPlugins: ${plugins.join(", ") || "(none detected — add them to the config)"}${ignored ? "\nAdded .flowmap/ to .gitignore" : ""}`);
  if (!opts["no-claude"]) await setupClaude();
  console.log("\nNext: flowmap dev (dashboard → Designs to plan a feature with Claude)");
}

/** Claude Code is optional: the dashboard chat only needs it installed and signed in; the plugin adds FlowMap to terminal sessions. */
async function setupClaude() {
  const { claudeStatus } = await import("./chat.ts");
  const s = await claudeStatus();
  if (!s.version) return console.log("\nClaude Code not found. Install it to design features with Claude (everything else works without it): https://claude.com/claude-code");
  console.log(`\nClaude Code ${s.version}${s.signedIn ? "" : " · not signed in: run `claude` once to sign in"}`);
  if (s.plugin) return console.log("FlowMap plugin for Claude Code: installed");
  const manual = PLUGIN_STEPS.map((a) => `claude ${a.join(" ")}`).join(" && ");
  let yes = !!opts.yes;
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    yes = !/^n/i.test(await rl.question("Add the FlowMap plugin to Claude Code (tools, /flowmap:design, issue check before finishing)? [Y/n] "));
    rl.close();
  }
  if (!yes) return console.log(`To add it later: ${manual}`);
  try {
    for (const a of PLUGIN_STEPS) execFileSync("claude", a, { stdio: "inherit" });
    console.log("FlowMap plugin added. Restart Claude Code sessions to load it.");
  } catch {
    console.log(`Could not add the plugin. Run: ${manual}`);
  }
}

async function doctor() {
  const e = await engine();
  const q = new Queries(e);
  const st = q.status();
  console.log(`Workspace ${st.workspace} (${e.ws.configPath})\nNode ${process.version}\n`);
  e.ws.config.warnings.forEach((w) => console.log(`  warning: ${w}`));
  for (const r of st.repos) console.log(`  ${r.name}: ${r.files} files · branch ${r.branch ?? "-"} · plugins ${r.plugins.join(", ")}`);
  console.log(`\nGraph: ${st.counts.nodes} nodes, ${st.counts.edges} edges, last index ${st.lastDurationMs} ms`);
  console.log(Object.entries(st.counts.byKind).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  const unresolved = e.store.db.prepare("SELECT kind, count(*) c FROM edges WHERE dst IS NULL AND attrs NOT LIKE '%\"optional\":true%' GROUP BY kind ORDER BY c DESC").all() as any[];
  const inferred = e.store.db.prepare("SELECT count(*) c FROM edges WHERE confidence = 'inferred'").get() as any;
  console.log(`\nAccuracy: ${st.counts.unresolved} unresolved edges (${((st.counts.unresolved / Math.max(st.counts.edges, 1)) * 100).toFixed(1)}%), ${inferred.c} inferred`);
  for (const u of unresolved) console.log(`  ${u.kind}: ${u.c}`);
  const top = e.store.db.prepare("SELECT dst_key, count(*) c FROM edges WHERE dst IS NULL AND kind = 'calls' GROUP BY dst_key ORDER BY c DESC LIMIT 8").all() as any[];
  if (top.length) console.log(`  most common unresolved calls:\n${top.map((t) => `    ${t.dst_key} ×${t.c}`).join("\n")}`);
  const noReason = [...e.graph.fileMeta.entries()].flatMap(([k, m]) => (m.suppressions ?? []).filter((s: any) => !s.reason).map((s: any) => `${k.replace("\0", "/")}:${s.line}`));
  if (noReason.length) console.log(`\nIgnored suppressions (missing reason):\n${noReason.map((s) => `  ${s}`).join("\n")}`);
  console.log(`\nIssues: ${e.issues.length} (${e.issues.filter((i) => i.status === "new").length} new, ${e.suppressed} suppressed)`);
  const suggestions = new MapQueries(q).suggestions();
  if (suggestions.length) console.log(`\nSuggestions\n${formatSuggestions(suggestions)}`);
  const { claudeStatus } = await import("./chat.ts");
  const c = await claudeStatus();
  console.log(`\nClaude Code (optional, for designing with Claude)\n${[
    c.version ? `  installed: ${c.version}` : "  not installed → https://claude.com/claude-code",
    c.version && (c.signedIn ? "  signed in" : "  not signed in → run `claude` once"),
    c.version && (c.plugin ? "  FlowMap plugin: installed" : `  FlowMap plugin: not added → ${PLUGIN_STEPS.map((a) => `claude ${a.join(" ")}`).join(" && ")}`),
  ].filter(Boolean).join("\n")}`);
}

function installHooks() {
  if (args[0] !== "install") throw new Error("Usage: flowmap hooks install");
  return Engine.open(opts.workspace).then((e) => {
    const script = `#!/bin/sh\n# flowmap: refresh the index after the working tree changes (local only, not committed)\n"${process.execPath}" "${process.argv[1]}" index --quiet --workspace "${e.ws.dir}" >/dev/null 2>&1 &\n`;
    for (const repo of e.ws.config.repos) {
      const root = gitRoot(repo.path);
      if (!root) { console.log(`${repo.name}: not a git repo, skipped`); continue; }
      let hooksPath = "";
      try { hooksPath = execFileSync("git", ["-C", root, "config", "core.hooksPath"], { encoding: "utf8" }).trim(); } catch {}
      if (hooksPath) { console.log(`${repo.name}: uses core.hooksPath (${hooksPath}, e.g. husky) — skipped to avoid changing tracked files. Run \`flowmap index\` after pulling.`); continue; }
      const gitDir = execFileSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
      for (const h of ["post-merge", "post-checkout"]) {
        const p = join(gitDir, "hooks", h);
        if (existsSync(p) && !readFileSync(p, "utf8").includes("# flowmap")) { console.log(`${repo.name}: ${h} already exists and isn't FlowMap's — skipped`); continue; }
        mkdirSync(join(gitDir, "hooks"), { recursive: true });
        writeFileSync(p, script);
        chmodSync(p, 0o755);
        console.log(`${repo.name}: installed ${p}`);
      }
    }
  });
}

/** Claude Code Stop hook: block "done" while the session's changes introduce new error-level issues. */
async function stopHook() {
  const input = await new Promise<string>((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => r(s)); });
  const data = input ? JSON.parse(input) : {};
  if (data.stop_hook_active) return;
  const e = await Engine.open(opts.workspace, data.cwd ?? process.cwd()).catch(() => null);
  if (!e) return;
  e.refresh();
  const errors = new Queries(e).changes(opts.base).issues.filter((i) => i.severity === "error");
  if (!errors.length) return;
  setColor(false);
  console.error(`FlowMap found ${errors.length} new error-level issue(s) in the changed code. Fix them or explain why they are acceptable:\n${formatIssues(errors, { why: true })}`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(`flowmap: ${err.message ?? err}`);
  process.exitCode = 1;
});
