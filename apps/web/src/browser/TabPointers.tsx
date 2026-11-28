// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor } from "@j3-bots/client-runtime";
import { tagOpenFor } from "@j3-bots/client-runtime/presentation";
import type { BotId } from "@j3-bots/contracts";
import { glideFor } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useState } from "react";
import { BotCursor, type PointerBot } from "./BotCursor";
import type { Size } from "./input";

/** Where the bots' pointers come from: a view of the tab, or the page itself on the desktop. */
export interface CursorSource {
  readonly onCursor: (listener: (cursor: BrowserCursor) => void) => () => void;
}

/** A bot on the tab, as its pointer shows it: whether it thinks before it acts too. */
export type PointerOnTab = PointerBot & { readonly thinking: boolean };

interface ShownCursor {
  readonly cursor: BrowserCursor;
  /** How long it glides to `cursor`, in ms: 0 where it first points. */
  readonly glide: number;
  /** The sequence of a click its pointer has yet to answer, null once answered. */
  readonly clicked: number | null;
  /** The tag shows from each move or click until a moment after the pointer stops. */
  readonly tagged: boolean;
}

/**
 * The pointers of `bots`, the bots on the tab most recent first, over a
 * page of `viewport`'s size, wherever they are drawn: over a view's picture
 * (`BotCursors`), or in the page itself on the desktop. `place` names the
 * tab and its page: when it changes, every pointer shows again where it
 * next points. `still` pointers move only for what happens (`BotCursor`).
 */
export function TabPointers({
  source,
  place,
  viewport,
  bots,
  held,
  still = false,
}: {
  readonly source: CursorSource;
  readonly place: string;
  readonly viewport: Size | null;
  readonly bots: ReadonlyArray<PointerOnTab>;
  readonly held: boolean;
  readonly still?: boolean;
}) {
  const [cursors, setCursors] = useState<ReadonlyMap<BotId, ShownCursor>>(new Map());
  const [shownOn, setShownOn] = useState(place);
  if (shownOn !== place) {
    setShownOn(place);
    setCursors(new Map());
  }
  const whose = useEffectEvent((cursor: BrowserCursor) => cursor.botId ?? bots[0]?.id ?? null);
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
    // Each bot's last pointer, and the page it was on.
    const last = new Map<BotId, { readonly place: string; readonly cursor: BrowserCursor }>();
    const stop = source.onCursor((cursor) => {
      const botId = whose(cursor);
      if (botId === null) return;
      const here = placeNow();
      const before = last.get(botId);
      const same = before?.place === here ? before : undefined;
      const glide = glideTo(same?.cursor, cursor);
      const clicked = cursor.action === "click" ? cursor.sequence : null;
      last.set(botId, { place: here, cursor });
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
  }, [source]);
  if (viewport === null || viewport.width === 0 || viewport.height === 0) return null;
  return bots.flatMap((bot) => {
    const shown = cursors.get(bot.id);
    if (shown === undefined) return [];
    const { cursor, glide, clicked, tagged } = shown;
    return [
      <BotCursor
        key={bot.id}
        bot={bot}
        at={{ x: cursor.x / viewport.width, y: cursor.y / viewport.height }}
        glide={glide}
        clicked={clicked}
        onAnswered={(answered) =>
          setCursors((now) => {
            const shown = now.get(bot.id);
            return shown?.clicked === answered
              ? new Map(now).set(bot.id, { ...shown, clicked: null })
              : now;
          })
        }
        tagged={tagged}
        held={held}
        thinking={!held && bot.thinking}
        still={still}
      />,
    ];
  });
}
