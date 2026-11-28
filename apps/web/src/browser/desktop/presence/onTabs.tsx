// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  holdEnd,
  nextLineChange,
  NO_PAGE_USE,
  pointerThinks,
  type ViewerTab,
} from "@j3-bots/client-runtime/presentation";
import type { BrowserTabRef } from "@j3-bots/contracts";
import type { BrowserPresence } from "@j3-bots/desktop-bridge";
import { useEffect, useMemo, useState } from "react";
import { useBots } from "../../../app/context";
import type { DesktopBrowserBridge } from "../../../live/desktop";
import { useViewerTabs } from "../../context";

// Who is on the desktop browser's tabs, as the server tells this device: the
// faces on each tab and the quiet line by the address (bar.tsx), as a view of
// the tab shows them, and the bots' pointers in the page itself (overlay.tsx).
// The person's hold on a tab here is the server's, from their use of the
// page: the line counts it down, with no Now, since only stopping ends it.

/** Every tab by its ref, and the time their holds and lines are read at, kept current. */
export function useTabsNow(): {
  readonly tabs: ReadonlyMap<BrowserTabRef, ViewerTab>;
  readonly now: number;
} {
  const listed = useViewerTabs(null).tabs;
  const tabs = useMemo(() => new Map((listed ?? []).map((tab) => [tab.ref, tab])), [listed]);
  const [now, setNow] = useState(() => Date.now());
  // A line changes by itself only at the countdown's seconds and a hold's end.
  const at = Math.min(
    ...[...tabs.values()].flatMap((tab) => nextLineChange(tab, NO_PAGE_USE, now) ?? []),
  );
  useEffect(() => {
    if (!Number.isFinite(at)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(at - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [at]);
  return { tabs, now };
}

/**
 * Tells the app who is on its tabs, for each tab's page to draw the bots'
 * pointers while it is on screen: the bots most recent first, and whether
 * the person holds the tab, as their pointers then step aside. Draws
 * nothing itself.
 */
export function PagePresence({ bridge }: { readonly bridge: DesktopBrowserBridge }) {
  const { tabs, now } = useTabsNow();
  const bots = useBots();
  const presence = useMemo(
    (): BrowserPresence =>
      [...tabs.values()].flatMap((tab) => {
        if (tab.private) return [];
        const onIt = tab.onIt.flatMap((botId) => {
          const bot = bots.get(botId);
          return bot === undefined
            ? []
            : [
                {
                  id: bot.id,
                  profile: { name: bot.profile.name, avatar: bot.profile.avatar },
                  thinking: pointerThinks(bot.state),
                },
              ];
        });
        return onIt.length === 0
          ? []
          : [{ tab: tab.ref, bots: onIt, held: holdEnd(tab, NO_PAGE_USE, now) !== "none" }];
      }),
    [tabs, bots, now],
  );
  // The app draws again only what changed in a page.
  useEffect(() => {
    bridge.presence(presence);
  }, [bridge, presence]);
  // A client that stops telling, as on signing out, leaves no bot drawn.
  useEffect(() => () => bridge.presence([]), [bridge]);
  return null;
}
