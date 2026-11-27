// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor, BrowserViewHandle } from "@j3-bots/client-runtime";
import type { BotId } from "@j3-bots/contracts";
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
}

/**
 * Each bot's pointer over the picture, where it last pointed, while the bot
 * is on the tab. A server before shared tabs names no bot: its pointer is
 * the tab's one bot's.
 */
export function BotCursors({
  view,
  viewport,
  onIt,
  faded,
}: {
  readonly view: BrowserViewHandle;
  readonly viewport: Size | null;
  readonly onIt: ReadonlyArray<BotId>;
  readonly faded: boolean;
}) {
  const bots = useBots();
  const [cursors, setCursors] = useState<ReadonlyMap<BotId, ShownCursor>>(new Map());
  const whose = useEffectEvent((cursor: BrowserCursor) => cursor.botId ?? onIt[0] ?? null);
  useEffect(() => {
    const timers = new Map<BotId, number>();
    const stop = view.onCursor((cursor) => {
      const botId = whose(cursor);
      if (botId === null) return;
      setCursors((now) => new Map(now).set(botId, { cursor, named: true }));
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
    const { cursor, named } = shown;
    return [
      <BotCursor
        key={botId}
        bot={bot}
        at={{ x: cursor.x / viewport.width, y: cursor.y / viewport.height }}
        clicked={cursor.action === "click" && named ? cursor.sequence : null}
        named={named}
        faded={faded}
      />,
    ];
  });
}
