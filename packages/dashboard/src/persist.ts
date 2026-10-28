import { useCallback, useState } from "react";

/** A boolean remembered in localStorage (a panel open or collapsed). Storage can be unavailable, so every access is guarded. */
export function usePersisted(key: string, initial: boolean) {
  const [value, set] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "1";
    } catch {
      return initial;
    }
  });
  const change = useCallback((next: boolean) => {
    set(next);
    try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [key]);
  return [value, change] as const;
}
