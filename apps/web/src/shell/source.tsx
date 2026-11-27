// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, use, type ReactNode } from "react";
import { OperatorTimeZone } from "../app/clock";
import type { BrowserSource } from "../browser/source";
import { ThemeRuntime } from "../themes/ThemeRuntime";
import type { ShellData, ShellIntents } from "./data";

export interface ShellSource {
  readonly data: ShellData;
  readonly intents: ShellIntents;
  readonly browser: BrowserSource;
}

/** Where the shell's data and intents come from: the server, or in development a sample team. */
const ShellSourceContext = createContext<ShellSource | null>(null);

/**
 * Gives everything under it the shell's data and intents, shows every time in
 * the operator's time zone once the settings are read, and the page in the
 * theme this device shows.
 */
export function ShellSourceProvider({
  source,
  children,
}: {
  source: ShellSource;
  children: ReactNode;
}) {
  return (
    <ShellSourceContext value={source}>
      <ThemeRuntime themes={source.data.themes} intents={source.intents.themes}>
        <OperatorTimeZone timeZone={source.data.settings?.timeZone ?? null}>
          {children}
        </OperatorTimeZone>
      </ThemeRuntime>
    </ShellSourceContext>
  );
}

export function useShellSource(): ShellSource {
  const source = use(ShellSourceContext);
  if (source === null) throw new Error("The shell is rendered outside a ShellSourceContext.");
  return source;
}
