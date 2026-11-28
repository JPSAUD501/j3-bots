// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor, BrowserViewHandle } from "@j3-bots/client-runtime";
import { pointerThinks, tagOpenFor } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { glideFor } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useState } from "react";
import { useBots } from "../app/context";
import { BotCursor } from "./BotCursor";
import type { Size } from "./input";

interface ShownCursor {
  readonly cursor: BrowserCursor;
  /** How long it glides to `cursor`, in ms: 0 where it first points. */
  readonly glide: number;
  /** The sequence of its newest click, null before its first. */
  readonly clicked: number | null;
  /** The tag shows from each move or click until a moment after the pointer stops. */
  readonly tagged: boolean;
}

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
  readonly view: BrowserViewHandle;
  readonly tab: BrowserTabRef;
  readonly address: string;
  readonly viewport: Size | null;
  readonly onIt: ReadonlyArray<BotId>;
  readonly held: boolean;
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
  // The move's length as a share of the page's diagonal sets how long it glides.
  const glideTo = useEffectEvent((from: BrowserCursor | undefined, to: BrowserCursor) =>
    from === undefined || viewport === null || viewport.width === 0 || viewport.height === 0
      ? 0
      : glideFor(
          Math.hypot(to.x - from.x, to.y - from.y) / Math.hypot(viewport.width, viewport.height),
        ),
  );
  const placeNow = useEffectEvent(() => place);
  useEffect(() => {
    const timers = new Map<BotId, number>();
    // Each bot's last pointer and click, and the page they were on.
    const last = new Map<
      BotId,
      { readonly place: string; readonly cursor: BrowserCursor; readonly clicked: number | null }
    >();
    const stop = view.onCursor((cursor) => {
      const botId = whose(cursor);
      if (botId === null) return;
      const here = placeNow();
      const before = last.get(botId);
      const same = before?.place === here ? before : undefined;
      const glide = glideTo(same?.cursor, cursor);
      const clicked = cursor.action === "click" ? cursor.sequence : (same?.clicked ?? null);
      last.set(botId, { place: here, cursor, clicked });
      setCursors((now) => new Map(now).set(botId, { cursor, glide, clicked, tagged: true }));
      window.clearTimeout(timers.get(botId));
      timers.set(
        botId,
        window.setTimeout(
          () =>
            setCursors((now) => {
              const shown = now.get(botId);
              return shown === undefined
                ? now
                : new Map(now).set(botId, { ...shown, tagged: false });
            }),
          tagOpenFor(cursor.action, glide),
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
    const { cursor, glide, clicked, tagged } = shown;
    return [
      <BotCursor
        key={botId}
        bot={bot}
        at={{ x: cursor.x / viewport.width, y: cursor.y / viewport.height }}
        glide={glide}
        clicked={clicked}
        tagged={tagged}
        held={held}
        thinking={!held && pointerThinks(bot.state)}
      />,
    ];
  });
}
