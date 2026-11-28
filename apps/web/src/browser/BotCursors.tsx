// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor, BrowserViewHandle } from "@j3-bots/client-runtime";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { glideFor } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useState } from "react";
import { useBots } from "../app/context";
import { BotCursor } from "./BotCursor";
import type { Size } from "./input";

/** A bot's pointer folds its name to its face once it has stood still this long. */
const NAME_FOR_MS = 2_000;

interface ShownCursor {
  readonly cursor: BrowserCursor;
  /** The name shows from each move until the pointer has been still a while. */
  readonly named: boolean;
  /** Where it pointed before, on the same page; undefined when it first points. */
  readonly from: BrowserCursor | undefined;
}

/**
 * Each bot's pointer over the picture, where it last pointed, while the bot
 * is on the tab. A server before shared tabs names no bot: its pointer is
 * the tab's one bot's. Where a pointer was on another tab, or before the
 * page went to `address`, says nothing of the page now: each pointer then
 * shows again where it next points.
 */
export function BotCursors({
  view,
  tab,
  address,
  viewport,
  onIt,
  faded,
}: {
  readonly view: BrowserViewHandle;
  readonly tab: BrowserTabRef;
  readonly address: string;
  readonly viewport: Size | null;
  readonly onIt: ReadonlyArray<BotId>;
  readonly faded: boolean;
}) {
  const bots = useBots();
  const [cursors, setCursors] = useState<ReadonlyMap<BotId, ShownCursor>>(new Map());
  const place = `${tab} ${address}`;
  const [shownOn, setShownOn] = useState(place);
  if (shownOn !== place) {
    setShownOn(place);
    setCursors(new Map());
  }
  const whose = useEffectEvent((cursor: BrowserCursor) => cursor.botId ?? onIt[0] ?? null);
  useEffect(() => {
    const timers = new Map<BotId, number>();
    const stop = view.onCursor((cursor) => {
      const botId = whose(cursor);
      if (botId === null) return;
      setCursors((now) =>
        new Map(now).set(botId, { cursor, named: true, from: now.get(botId)?.cursor }),
      );
      window.clearTimeout(timers.get(botId));
      timers.set(
        botId,
        window.setTimeout(
          () =>
            setCursors((now) => {
              const shown = now.get(botId);
              return shown === undefined
                ? now
                : new Map(now).set(botId, { ...shown, named: false });
            }),
          NAME_FOR_MS,
        ),
      );
    });
    return () => {
      stop();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, [view]);
  if (viewport === null || viewport.width === 0 || viewport.height === 0) return null;
  return onIt.flatMap((botId) => {
    const bot = bots.get(botId);
    const shown = cursors.get(botId);
    if (bot === undefined || shown === undefined) return [];
    const { cursor, named, from } = shown;
    // The move's length as a share of the page's diagonal sets how long it glides.
    const glide =
      from === undefined
        ? 0
        : glideFor(
            Math.hypot(cursor.x - from.x, cursor.y - from.y) /
              Math.hypot(viewport.width, viewport.height),
          );
    return [
      <BotCursor
        key={botId}
        bot={bot}
        at={{ x: cursor.x / viewport.width, y: cursor.y / viewport.height }}
        clicked={cursor.action === "click" && named ? cursor.sequence : null}
        named={named}
        faded={faded}
        glide={glide}
      />,
    ];
  });
}
