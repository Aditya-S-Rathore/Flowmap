import { createContext, useContext } from "react";
import type { Status } from "./types";

export type Editor = "vscode" | "cursor";

export const AppCtx = createContext<{ status?: Status; editor: Editor; version: number }>({ editor: "vscode", version: 0 });

export const useApp = () => useContext(AppCtx);
