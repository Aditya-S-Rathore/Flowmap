import { createContext, useContext } from "react";
import type { SearchHit, Status } from "./types";

export type Editor = "vscode" | "cursor";

export interface App {
  status?: Status;
  editor: Editor;
  version: number;
  /** Opens search; with `pick`, choosing a result calls it once (instead of the usual action) and search closes. */
  openPalette: (pick?: (hit: SearchHit) => void) => void;
  /** While set, picking a search result calls this instead of opening the Explorer (designs: add a node). */
  setPick: (pick: ((hit: SearchHit) => void) | undefined) => void;
  notify: (text: string, error?: boolean) => void;
}

export const AppCtx = createContext<App>({ editor: "vscode", version: 0, openPalette: () => {}, setPick: () => {}, notify: () => {} });

export const useApp = () => useContext(AppCtx);
