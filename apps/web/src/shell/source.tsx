// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, use } from "react";
import { unconnected, type ShellData, type ShellIntents } from "./data";

export interface ShellSource {
  readonly data: ShellData;
  readonly intents: ShellIntents;
}

/** Where the shell's data and intents come from. Development provides a sample; builds have no server yet. */
export const ShellSourceContext = createContext<ShellSource>(unconnected);

export const useShellSource = () => use(ShellSourceContext);
