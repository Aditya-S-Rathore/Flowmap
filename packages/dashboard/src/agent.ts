import { useCallback, useEffect, useRef, useState } from "react";
import { enc, post, subscribe, useApi } from "./api";
import type { ChatMode, ChatSummary, DesignChat } from "./types";

/** The chat scope of the agent: one conversation space for the whole dashboard (the server keeps it under this name). */
const SCOPE = "agent-chat";
const API = "/api/agent";

export interface Streaming { text: string[]; tools: string[] }

const read = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

/**
 * The agent that is on every page: it answers about the code, shows flows (the server turns its show_flow / open_design
 * calls into `ui` events, which move the dashboard) and edits designs. `page` tells it what you are looking at.
 */
export function useAgent(page: string, notify: (text: string, error?: boolean) => void) {
  const { data, reload } = useApi<{ chat: DesignChat["messages"]; conversations: ChatSummary[] }>(`/api/chat/${SCOPE}`);
  const [streaming, setStreaming] = useState<Streaming | null>(null);       // null: not answering
  const [mode, setModeState] = useState<ChatMode>(() => (read("flowmap.chatMode", "full") === "design" ? "design" : "full"));
  const [model, setModelState] = useState(() => read("flowmap.chatModel", ""));
  const flush = useRef<(() => Promise<void>) | null>(null);                 // a page with unsaved work registers how to save it before Claude reads it

  // subscribe once: each subscription is its own event stream, and a re-subscribe would miss events in between
  const now = useRef({ reload, notify });
  now.current = { reload, notify };
  useEffect(() => subscribe((e) => {
    if (e.type === "ui") location.hash = e.action === "flow" ? `#/explore/${enc(e.id)}` : e.action === "design" ? `#/designs/${enc(e.id)}` : `#/${e.id}`;
    if (e.type !== "chat" || e.slug !== SCOPE) return;
    if (e.text) setStreaming((s) => ({ text: [...(s?.text ?? []), e.text!], tools: s?.tools ?? [] }));
    if (e.tool) setStreaming((s) => ({ text: s?.text ?? [], tools: [...(s?.tools ?? []), e.tool!] }));
    if (e.done) {
      setStreaming(null);
      if (e.error) now.current.notify(`Claude: ${e.error}`, true);
      now.current.reload();
    }
  }), []);

  const send = useCallback(async (text: string) => {
    await flush.current?.();
    setStreaming({ text: [], tools: [] });
    try {
      await post(`${API}/chat`, { text, mode, model, page });
      reload();
    } catch (e: any) {
      setStreaming(null);
      notify(`Claude: ${e.message}`, true);
    }
  }, [mode, model, page, reload, notify]);

  const action = (body: object, what: string) => post(`${API}/chat`, body).then(reload, (e: Error) => notify(`Couldn't ${what}: ${e.message}`, true));
  return {
    messages: data?.chat ?? [], conversations: data?.conversations ?? [], streaming, mode, model, flush, send,
    stop: () => action({ cancel: true }, "stop"),
    newConversation: () => action({ new: true }, "start a new conversation"),
    openConversation: (id: string) => action({ open: id }, "open that conversation"),
    deleteConversation: (id: string) => action({ remove: id }, "delete that conversation"),
    clearConversations: () => action({ clear: true }, "delete the history"),
    setMode: (m: ChatMode) => { setModeState(m); write("flowmap.chatMode", m); },
    setModel: (m: string) => { setModelState(m); write("flowmap.chatModel", m); },
  };
}

export type Agent = ReturnType<typeof useAgent>;
