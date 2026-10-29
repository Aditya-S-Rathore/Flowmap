import { Bot, ChevronRight, History, Loader2, MessageSquarePlus, Mic, Send, ShieldAlert, Square, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../api";
import type { Streaming } from "../../agent";
import { Markdown } from "../../components/Markdown";
import { input } from "../../components/ui";
import type { ChatMode, ChatSummary, ClaudeStatus, DesignChat } from "../../types";
import { ClaudeSetup } from "./ClaudeSetup";
import { Popover, type Point } from "./Menus";
import { ago, primary } from "./shared";

const QUICK = [
  ["Draft the RFC", "Draft the RFC for this design."],
  ["What could break?", "Check the impact of this design and tell me what could break."],
  ["Edge cases", "List the edge cases and failure handling we should cover."],
  ["Build plan", "Turn this design into an ordered build plan, PR by PR."],
] as const;

/** "claude-opus-5-5-20260101" → "Opus 5.5", as Claude names it; anything unexpected is shown as is. */
const modelName = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
};

const DRAFT = "Here is my draft RFC. Map it onto the real code: find the nodes it touches, tell me where it doesn't match the code, ask only about what it leaves open, then draw the design and finish the RFC.\n\n";

/** What Claude did while answering, folded away until you want it. */
function Steps({ tools, live = false }: { tools: string[]; live?: boolean }) {
  return (
    <details open={live} className="group rounded-md border border-line bg-subtle text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-fg-muted">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        <Wrench className="size-3.5" aria-hidden />{live ? "Working…" : `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}`}
      </summary>
      <ul className="space-y-0.5 border-t border-line px-2.5 py-1.5 font-mono text-fg-subtle">
        {tools.map((t, i) => <li key={i} className="truncate" title={t}>› {t}</li>)}
      </ul>
    </details>
  );
}

/** Every conversation about this design: open one to carry on where you left off. */
function HistoryMenu({ at, list, busy, onOpen, onDelete, onClear, onNew, onClose }: {
  at: Point; list: ChatSummary[]; busy: boolean; onOpen: (id: string) => void; onDelete: (id: string) => void; onClear: () => void; onNew: () => void; onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const hint = busy ? "Wait for Claude to finish" : undefined;
  return (
    <Popover at={at} label="Conversation history" width="w-80" onClose={onClose}>
      <p className="px-3 pt-1 pb-1.5 text-xs text-fg-subtle">Your conversations about this design</p>
      <ul className="max-h-80 overflow-y-auto">
        {list.map((c) => (
          <li key={c.id} className={`flex items-center gap-1 px-1.5 ${c.active ? "bg-muted" : ""}`}>
            <button type="button" role="menuitem" disabled={busy || c.active} title={hint} onClick={() => { onOpen(c.id); onClose(); }}
              className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent">
              <span className="block truncate text-sm">{c.title}</span>
              <span className="block text-xs text-fg-subtle">{[c.active && "open now", ago(c.updatedAt), `${c.count} message${c.count === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
            </button>
            {confirming === c.id ? (
              <button type="button" onClick={() => { onDelete(c.id); onClose(); }} className="rounded-md bg-error-soft px-2 py-1 text-xs font-medium text-error">Delete?</button>
            ) : (
              <button type="button" disabled={busy} title={hint ?? "Delete this conversation"} aria-label={`Delete “${c.title}”`} onClick={() => setConfirming(c.id)}
                className="rounded-md p-1.5 text-fg-subtle hover:bg-bg hover:text-error disabled:opacity-40"><Trash2 className="size-3.5" aria-hidden /></button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-1 border-t border-line pt-1">
        <button type="button" role="menuitem" disabled={busy} title={hint} onClick={() => { onNew(); onClose(); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40">
          <MessageSquarePlus className="size-4 text-fg-muted" aria-hidden />New conversation
        </button>
        {list.some((c) => c.count > 0) && (clearing ? (
          <button type="button" role="menuitem" disabled={busy} onClick={() => { onClear(); onClose(); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm font-medium text-error hover:bg-error-soft disabled:opacity-40">
            <Trash2 className="size-4" aria-hidden />Delete everything for good?
          </button>
        ) : (
          <button type="button" role="menuitem" disabled={busy} title={hint ?? "Delete every conversation from this computer"} onClick={() => setClearing(true)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-error hover:bg-muted disabled:opacity-40">
            <Trash2 className="size-4" aria-hidden />Delete all conversations
          </button>
        ))}
      </div>
    </Popover>
  );
}

export function ChatPanel({ messages, conversations, streaming, mode, onMode, model, onModel, design, onSend, onStop, onNew, onOpen, onDelete, onClear, onClose }: {
  messages: DesignChat["messages"]; conversations: ChatSummary[]; streaming: Streaming | null; mode: ChatMode; onMode: (m: ChatMode) => void; model: string; onModel: (m: string) => void; design: boolean;
  onSend: (text: string) => void; onStop: () => void; onNew: () => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onClear: () => void; onClose: () => void;
}) {
  const { data: claude } = useApi<ClaudeStatus>("/api/claude");
  const { data: skills } = useApi<{ name: string; description: string }[]>("/api/claude/commands");
  const [pick, setPick] = useState(0);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<Point | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [listening, setListening] = useState(false);
  const voice = useRef<{ stop: () => void } | null>(null);
  // the box grows with what you type, up to a limit, then scrolls
  useEffect(() => { const t = box.current; if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; } }, [text]);
  useEffect(() => () => voice.current?.stop(), []);
  const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const dictate = () => {
    if (voice.current) return voice.current.stop();
    const r = new SpeechRecognition();
    r.continuous = true; r.interimResults = false; r.lang = navigator.language;
    r.onresult = (e: any) => setText((t) => `${t}${t && !/\s$/.test(t) ? " " : ""}${Array.from(e.results).slice(e.resultIndex).map((x: any) => x[0].transcript.trim()).join(" ")}`);
    r.onend = r.onerror = () => { voice.current = null; setListening(false); };
    voice.current = r; setListening(true); r.start();
  };
  // a block body: scrollIntoView returns a Promise in current browsers, and React would treat a returned value as the cleanup function
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, streaming?.text.length, streaming?.tools.length]);
  const ready = !!claude?.version && claude.signedIn;
  // "/" at the start (and no space yet) offers your skills and commands
  const slash = /^\/([\w:.-]*)$/.exec(text);
  const matches = slash ? (skills ?? []).filter((s) => s.name.startsWith(slash[1])).slice(0, 8) : [];
  const choose = (name: string) => { setText(`/${name} `); setPick(0); box.current?.focus(); };
  const busy = streaming !== null;
  const send = (t: string) => { if (t.trim() && !busy) { onSend(t.trim()); setText(""); } };

  return (
    <aside aria-label="Agent" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Bot className="size-4 text-accent" aria-hidden />
        <span className="text-sm font-medium">Agent</span>
        <select value={mode} onChange={(e) => onMode(e.target.value as ChatMode)} aria-label="What Claude may do" className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs">
          <option value="full">Full access</option>
          <option value="design">Design only</option>
        </select>
        <select value={model} onChange={(e) => onModel(e.target.value)} aria-label="Model" className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs">
          <option value="">Default model</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
        <span className="ml-auto flex items-center gap-0.5">
          <button type="button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHistory({ x: r.right - 320, y: r.bottom + 4 }); }} aria-haspopup="menu" aria-label="Conversation history" title="History: your earlier conversations"
            className="relative rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg">
            <History className="size-4" aria-hidden />
            {conversations.length > 1 && <span className="absolute -top-0.5 -right-0.5 rounded-full bg-accent px-1 text-[0.625rem] leading-4 font-medium text-bg">{conversations.length}</span>}
          </button>
          <button type="button" onClick={onNew} disabled={busy || !messages.length} aria-label="New conversation" title={messages.length ? "New conversation (this one stays in History)" : "Already a new conversation"} className="rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg disabled:opacity-40"><MessageSquarePlus className="size-4" aria-hidden /></button>
          <button type="button" onClick={onClose} aria-label="Close the agent" title="Close" className="rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg"><X className="size-4" aria-hidden /></button>
        </span>
      </div>
      <p className={`flex items-center gap-1.5 border-b border-line px-3 py-1 text-xs ${mode === "full" ? "text-warn" : "text-fg-subtle"}`}
        title={mode === "full"
          ? "Uses your own Claude login, like Claude Code in your terminal. It can edit files and run commands without asking first."
          : "Claude can read your code and change this design. Nothing else."}>
        {mode === "full" && <ShieldAlert className="size-3.5 shrink-0" aria-hidden />}
        {mode === "full" ? "Full access: works like Claude Code in your terminal" : "Design only: reads your code, edits this design"}
      </p>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {claude && !ready && <ClaudeSetup compact />}
        {ready && !messages.length && !streaming && (
          <div className="space-y-2 text-sm text-fg-muted">
            <p>Ask about your code and it answers from the real flow, and shows it: “how is a nickname saved?”, “what does this API touch?”. Or describe a feature and it designs it with you.</p>
            <p className="text-xs text-fg-subtle">For example: “Show me how a nickname is saved” or “Design: let admins archive a user.”</p>
            <p>Already have a rough RFC? <button type="button" onClick={() => { setText(DRAFT); box.current?.focus(); }} className="text-accent hover:underline">Import a draft</button>, then paste it below the line.</p>
          </div>
        )}
        {messages.map((m, i) => m.role === "user" ? (
          <div key={i} className="ml-8 rounded-lg bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap">{m.text}</div>
        ) : (
          <div key={i} className="space-y-2">
            <Markdown text={m.text} />
            {m.tools?.length ? <Steps tools={m.tools} /> : null}
            {m.model && <p className="text-xs text-fg-subtle">{modelName(m.model)}</p>}
          </div>
        ))}
        {streaming && (
          <div className="space-y-2">
            {streaming.text.length > 0 && <Markdown text={streaming.text.join("\n\n")} />}
            {streaming.tools.length > 0 && <Steps tools={streaming.tools} live />}
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />Claude is working…
              <button type="button" onClick={onStop} className="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 hover:bg-muted"><Square className="size-3" aria-hidden />Stop</button>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="shrink-0 border-t border-line p-3">
        {ready && design && messages.length > 0 && !busy && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK.map(([label, prompt]) => (
              <button key={label} type="button" onClick={() => send(prompt)} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-muted hover:border-accent hover:text-accent">{label}</button>
            ))}
          </div>
        )}
        {matches.length > 0 && (
          <ul role="listbox" aria-label="Skills and commands" className="mb-2 max-h-56 overflow-y-auto rounded-lg border border-line bg-bg py-1 text-sm shadow-lg">
            {matches.map((s, i) => (
              <li key={s.name} role="option" aria-selected={i === pick}>
                <button type="button" onClick={() => choose(s.name)} className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-muted ${i === pick ? "bg-muted" : ""}`}>
                  <span className="font-medium">/{s.name}</span><span className="truncate text-xs text-fg-subtle">{s.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={20000} disabled={!ready}
            onKeyDown={(e) => {
              if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setPick((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); }
              else if (matches.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) { e.preventDefault(); choose(matches[Math.min(pick, matches.length - 1)].name); }
              else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); }
            }}
            placeholder={ready ? "Describe the feature or ask for a change…" : "Set up Claude to chat"} aria-label="Message to Claude"
            className={`${input} max-h-48 min-w-0 flex-1 resize-none`} />
          {SpeechRecognition && (
            <button type="button" onClick={dictate} disabled={!ready} aria-pressed={listening} aria-label={listening ? "Stop dictation" : "Dictate"} title={listening ? "Stop dictation" : "Dictate (uses your browser's speech recognition)"}
              className={`rounded-md border border-line p-2 hover:bg-muted disabled:opacity-40 ${listening ? "bg-accent-soft text-accent" : "text-fg-muted"}`}><Mic className="size-4" aria-hidden /></button>
          )}
          <button type="submit" disabled={!ready || !text.trim() || busy} aria-label="Send" className={primary}><Send className="size-4" aria-hidden /></button>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">Enter to send · Shift+Enter for a new line</p>
      </form>
      {history && <HistoryMenu at={history} list={conversations} busy={busy} onOpen={onOpen} onDelete={onDelete} onClear={onClear} onNew={onNew} onClose={() => setHistory(null)} />}
    </aside>
  );
}
