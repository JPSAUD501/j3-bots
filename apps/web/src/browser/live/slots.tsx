// SPDX-License-Identifier: AGPL-3.0-or-later
import { botsTab, type ViewerTab } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { AppWindowIcon } from "lucide-react";
import { useEffect } from "react";
import { useI18n } from "../../app/context";
import { deferred } from "../../lib/deferred";
import { useViewerTabs } from "../context";

// What a conversation shows of a bot's browser before anyone opens it is all
// of it the app's first load carries: whether the bot is on a tab, and See the
// browser. The live card, the live view and the wide viewer come once wanted.

/** The live card, fetched once the bot is first seen on a tab, and kept from then on. */
const liveCard = deferred(
  () => import("./LiveCard").then((module) => module.LiveCard),
  ({ tab }) => tab !== null,
);
const liveView = deferred(() => import("./LiveView").then((module) => module.LiveView));

/** The browser below the wide layout: the phone's live view. */
export const LiveView = liveView.Component;

const browserViewer = deferred(() =>
  import("../BrowserViewer").then((module) => module.BrowserViewer),
);

/** The browser beside the conversation, in the wide layout. */
export const BrowserViewer = browserViewer.Component;

/** Fetches the wide layout's viewer ahead, once the bot has a tab to open in it. */
export const preloadBrowserViewer = (): void => {
  browserViewer.preload().catch(() => undefined);
};

/** The tab the bot is on now, or null while it is on none. */
function useBotsTab(botId: BotId): ViewerTab | null {
  const { tabs } = useViewerTabs(botId);
  return tabs === null ? null : botsTab(tabs, botId);
}

/**
 * Where the live card ends a bot's conversation. Its code comes once the bot
 * is on a tab, and with it the live view's, which a press on the card opens.
 */
export function LiveCardSlot({
  botId,
  onOpen,
}: {
  readonly botId: BotId;
  readonly onOpen: (ref: BrowserTabRef) => void;
}) {
  const tab = useBotsTab(botId);
  const browsing = tab !== null;
  useEffect(() => {
    if (browsing) liveView.preload().catch(() => undefined);
  }, [browsing]);
  return <liveCard.Component tab={tab} onOpen={onOpen} />;
}

/**
 * "See the browser", over the top of a conversation scrolled away from its
 * end, where the live card is, while the bot browses.
 */
export function BrowserPill({
  botId,
  shown,
  onOpen,
}: {
  readonly botId: BotId;
  readonly shown: boolean;
  readonly onOpen: (ref: BrowserTabRef) => void;
}) {
  const { t } = useI18n();
  const tab = useBotsTab(botId);
  if (tab === null || !shown) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <button
        type="button"
        onClick={() => onOpen(tab.ref)}
        className="pointer-events-auto flex min-h-11 items-center gap-2 rounded-pill border border-border bg-surface px-4 text-sm font-medium shadow-overlay focus-visible:outline-2 focus-visible:outline-accent"
      >
        <AppWindowIcon aria-hidden className="size-4" />
        {t("browser.pill")}
      </button>
    </div>
  );
}
