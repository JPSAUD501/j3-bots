// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  botViewerTab,
  sharedViewerTab,
  type ViewerTab,
} from "@j3-bots/client-runtime/presentation";
import {
  useAllBrowserTabs,
  useBrowserTabs,
  useJ3Client,
  useReadable,
  useSharedBrowser,
} from "@j3-bots/client-runtime/react";
import type { BotId } from "@j3-bots/contracts";
import { useMemo } from "react";
import { useBots } from "../presentation.tsx";

/**
 * The tabs a live view shows: every tab on a server that shares them, and
 * on one from before, the tabs of the bot the person came from. Null while
 * they load.
 */
export function useViewerTabs(botId: BotId | null): {
  readonly tabs: ReadonlyArray<ViewerTab> | null;
  /** The server shares its tabs: the person may open and close them. */
  readonly shared: boolean;
} {
  const shared = useSharedBrowser();
  const client = useJ3Client();
  const here = useReadable(client.pairing);
  const all = useAllBrowserTabs(shared);
  const own = useBrowserTabs(shared ? null : botId);
  const tabs = useMemo(() => {
    if (shared) {
      return all?._tag === "ready" ? all.value.map((tab) => sharedViewerTab(tab, here)) : null;
    }
    if (own === null || own._tag === "loading") return null;
    return own._tag === "ready" ? own.value.map((tab) => botViewerTab(tab, here)) : [];
  }, [shared, all, own, here]);
  return { tabs, shared };
}

/** The bots that wait for the person, whose faces are amber. */
export function useWaitingBots(): ReadonlySet<BotId> {
  const bots = useBots();
  return useMemo(
    () =>
      new Set(
        [...bots.values()].filter((bot) => bot.state._tag === "waiting").map((bot) => bot.id),
      ),
    [bots],
  );
}
