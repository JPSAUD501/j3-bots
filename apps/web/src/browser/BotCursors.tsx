// SPDX-License-Identifier: AGPL-3.0-or-later
import { pointerThinks } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { useBots } from "../app/context";
import type { Size } from "./input";
import { type CursorSource, TabPointers } from "./TabPointers";

/**
 * Each bot's pointer over the picture, where it last pointed, while the bot
 * is on the tab. A server before shared tabs names no bot: its pointer is
 * the tab's one bot's. Where a pointer was on another tab, or before the
 * page went to `address`, says nothing of the page now: each pointer then
 * shows again where it next points. While the person holds the tab (`held`),
 * every pointer steps aside.
 */
export function BotCursors({
  view,
  tab,
  address,
  viewport,
  onIt,
  held,
}: {
  readonly view: CursorSource;
  readonly tab: BrowserTabRef;
  readonly address: string;
  readonly viewport: Size | null;
  readonly onIt: ReadonlyArray<BotId>;
  readonly held: boolean;
}) {
  const bots = useBots();
  return (
    <TabPointers
      source={view}
      place={`${tab} ${address}`}
      viewport={viewport}
      bots={onIt.flatMap((botId) => {
        const bot = bots.get(botId);
        return bot === undefined ? [] : [{ ...bot, thinking: pointerThinks(bot.state) }];
      })}
      held={held}
    />
  );
}
