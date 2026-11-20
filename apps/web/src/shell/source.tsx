// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, use } from "react";
import type { ShellData, ShellIntents } from "./data";

export interface ShellSource {
  readonly data: ShellData;
  readonly intents: ShellIntents;
}

/** Where the shell's data and intents come from: the server, or in development a sample team. */
export const ShellSourceContext = createContext<ShellSource | null>(null);

export function useShellSource(): ShellSource {
  const source = use(ShellSourceContext);
  if (source === null) throw new Error("The shell is rendered outside a ShellSourceContext.");
  return source;
}
