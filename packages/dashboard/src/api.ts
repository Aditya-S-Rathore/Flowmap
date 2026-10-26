import { useEffect, useState } from "react";
import { useApp } from "./context";
import type { ServerEvent } from "./types";

const MOCK = import.meta.env.VITE_MOCK === "1";

export async function get<T>(path: string): Promise<T> {
  if (MOCK) return (await import("./mock")).mockGet(path) as Promise<T>;
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}${res.status === 401 ? " — open the dashboard from the link printed by `flowmap dev`" : ""}`);
  return res.json() as Promise<T>;
}

export const enc = encodeURIComponent;

/** Subscribes to live index events. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: ServerEvent) => void): () => void {
  if (MOCK) {
    const stop = import("./mock").then((m) => m.mockEvents(onEvent));
    return () => void stop.then((s) => s());
  }
  const es = new EventSource("/api/events");
  // after a server restart the stream reconnects: refetch everything quietly
  let connected = false;
  es.onopen = () => { if (connected) onEvent({ type: "updated", files: 0, durationMs: 0 }); connected = true; };
  es.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data) as ServerEvent); } catch { /* ignore malformed event */ }
  };
  return () => es.close();
}

/**
 * Fetches `path` (null = skip). Refetches quietly (keeping current data) when the index updates.
 */
export function useApi<T>(path: string | null) {
  const { version } = useApp();
  const [state, setState] = useState<{ path?: string; data?: T; error?: string }>({});
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    let live = true;
    get<T>(path).then(
      (data) => live && setState({ path, data }),
      (e: Error) => live && setState((s) => ({ path, data: s.path === path ? s.data : undefined, error: e.message })),
    );
    return () => { live = false; };
  }, [path, version, nonce]);

  const current = state.path === path;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    reload: () => { setState({}); setNonce((n) => n + 1); },
  };
}
