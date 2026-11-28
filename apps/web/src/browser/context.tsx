// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Loaded, loadedList } from "@j3-bots/client-runtime";
import { type ViewerTab, viewerTabsOf } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTab, SharedBrowserTab } from "@j3-bots/contracts";
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

const noSharedTabs = emptyStore<Loaded<ReadonlyArray<SharedBrowserTab>> | null>(null);

/** Every tab while mounted and `on`, from a server that shares them; null while they load. */
function useAllBrowserTabs(on: boolean): ReadonlyArray<SharedBrowserTab> | null {
  const { source } = useBrowser();
  const store = useMemo(
    () =>
      on
        ? heldStore<Loaded<ReadonlyArray<SharedBrowserTab>> | null>((notify) => {
            const handle = source.openAllBrowserTabs();
            const stop = handle.state.subscribe(notify);
            return {
              get: handle.state.get,
              close: () => {
                stop();
                handle.release();
              },
            };
          }, null)
        : noSharedTabs,
    [source, on],
  );
  return loadedList(useSyncExternalStore(store.subscribe, store.get, store.get));
}

/** Whether the server shares its tabs. */
function useSharedBrowser(): boolean {
  const { source } = useBrowser();
  return useSyncExternalStore(source.sharedBrowser.subscribe, source.sharedBrowser.get);
}

/**
 * The tabs a live view shows, as the phone's do: every tab from a server
 * that shares them, and from one before, the tabs of the bot the person
 * came from. Null while they load.
 */
export function useViewerTabs(botId: BotId | null): {
  readonly tabs: ReadonlyArray<ViewerTab> | null;
  /** The server shares its tabs: the person may open and close them. */
  readonly shared: boolean;
} {
  const { source } = useBrowser();
  const shared = useSharedBrowser();
  const here = useSyncExternalStore(source.pairing.subscribe, source.pairing.get);
  const all = useAllBrowserTabs(shared);
  const own = useBrowserTabs(shared ? null : botId);
  const tabs = useMemo(() => viewerTabsOf({ shared, all, own, here }), [shared, all, own, here]);
  return { tabs, shared };
}
