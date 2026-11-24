// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Loaded } from "@j3-bots/client-runtime";
import type { BotId, BrowserTab } from "@j3-bots/contracts";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { emptyStore, heldStore } from "./held";
import { type KeptViews, keptViews } from "./kept";
import type { BrowserSource } from "./source";

interface BrowserContextValue {
  readonly source: BrowserSource;
  /** The tabs this window keeps: see `KeptViews`. */
  readonly kept: Pick<KeptViews, "keep" | "makeWay">;
}

const BrowserContext = createContext<BrowserContextValue | null>(null);

/** Gives what is under it the bot's browser: its tabs, views of them, and the tabs this window keeps. */
export function BrowserProvider({
  source,
  children,
}: {
  readonly source: BrowserSource;
  readonly children: ReactNode;
}) {
  const [kept] = useState(keptViews);
  const value = useMemo<BrowserContextValue>(() => ({ source, kept }), [source, kept]);
  // Leaving the shell, as signing out does, lets go of every tab it kept.
  useEffect(() => () => kept.dropAll(), [kept]);
  return <BrowserContext value={value}>{children}</BrowserContext>;
}

export function useBrowser(): BrowserContextValue {
  const value = use(BrowserContext);
  if (value === null) throw new Error("The bot's browser is used outside a BrowserProvider.");
  return value;
}

const noTabs = emptyStore<Loaded<ReadonlyArray<BrowserTab>> | null>(null);

/**
 * The bot's tabs while mounted, in the server's order; null while they load,
 * and for a bot the server does not know. A null `botId` reads nothing.
 */
export function useBrowserTabs(botId: BotId | null): ReadonlyArray<BrowserTab> | null {
  const { source } = useBrowser();
  const store = useMemo(
    () =>
      botId === null
        ? noTabs
        : heldStore<Loaded<ReadonlyArray<BrowserTab>> | null>((notify) => {
            const handle = source.openBrowserTabs(botId);
            const stop = handle.state.subscribe(notify);
            return {
              get: handle.state.get,
              close: () => {
                stop();
                handle.release();
              },
            };
          }, null),
    [source, botId],
  );
  const loaded = useSyncExternalStore(store.subscribe, store.get, store.get);
  return loaded?._tag === "ready" ? loaded.value : null;
}
