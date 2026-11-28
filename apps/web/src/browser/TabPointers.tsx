// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor } from "@j3-bots/client-runtime";
import { type OtherTag, tagSide, type TagSide } from "@j3-bots/client-runtime/presentation";
import type { BotId } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { BotCursor, type PointerBot, TAG_WIDTH_GUESS } from "./BotCursor";
import type { Size } from "./input";

/** Where the bots' pointers come from: a view of the tab, or the page itself on the desktop. */
export interface CursorSource {
  readonly onCursor: (listener: (cursor: BrowserCursor) => void) => () => void;
}

/** A bot on the tab, as its pointer shows it: whether it thinks before it acts too. */
export type PointerOnTab = PointerBot & { readonly thinking: boolean };

interface ShownCursor {
  readonly cursor: BrowserCursor;
  /** The sequence of a click its pointer has yet to answer, null once answered. */
  readonly clicked: number | null;
  /** Where its tag sits, away from the page's edges and the other tags. */
  readonly side: TagSide;
  /** Higher for the bot that pointed later: it is drawn on top. */
  readonly layer: number;
}

const NO_SIDE: TagSide = { x: 1, y: 1 };

/**
 * The pointers of `bots`, the bots on the tab most recent first, over a
 * page of `viewport`'s size, wherever they are drawn: over a view's picture
 * (`BotCursors`), or in the page itself on the desktop. `place` names the
 * tab and its page: when it changes, every pointer shows again where it
 * next points, coming in from behind its arrow. Each tag keeps clear of the
 * page's edges and of the tags of the other bots, in the size the pointers
 * are drawn at. `still` pointers move only for what happens (`BotCursor`).
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

  // The size the pointers are drawn at, which the tags are measured in.
  const box = useRef<HTMLSpanElement>(null);
  const [drawn, setDrawn] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = () => setDrawn({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const tagWidths = useRef(new Map<BotId, number>());

  const whose = useEffectEvent((cursor: BrowserCursor) => cursor.botId ?? bots[0]?.id ?? null);
  /** Where `botId`'s tag goes for `cursor`, clear of the others' tags as they stand. */
  const sideFor = useEffectEvent(
    (botId: BotId, cursor: BrowserCursor, others: ReadonlyMap<BotId, ShownCursor>): TagSide => {
      if (viewport === null || drawn === null || viewport.width <= 0 || viewport.height <= 0) {
        return NO_SIDE;
      }
      const scale = { x: drawn.width / viewport.width, y: drawn.height / viewport.height };
      const inDrawing = (at: BrowserCursor) => ({ x: at.x * scale.x, y: at.y * scale.y });
      const theirs: Array<OtherTag> = [];
      for (const [id, shown] of others) {
        if (id === botId) continue;
        theirs.push({
          at: inDrawing(shown.cursor),
          width: tagWidths.current.get(id) ?? TAG_WIDTH_GUESS,
          side: shown.side,
        });
      }
      const width = tagWidths.current.get(botId) ?? TAG_WIDTH_GUESS;
      return tagSide(inDrawing(cursor), width, drawn, theirs);
    },
  );
  const placeNow = useEffectEvent(() => place);
  useEffect(() => {
    // Each bot's pointer as last shown, and the page it was on.
    const shown = new Map<BotId, ShownCursor>();
    let shownPlace = placeNow();
    let layers = 0;
    const stop = source.onCursor((cursor) => {
      const botId = whose(cursor);
      if (botId === null) return;
      const here = placeNow();
      if (here !== shownPlace) {
        shownPlace = here;
        shown.clear();
      }
      layers += 1;
      const next: ShownCursor = {
        cursor,
        clicked: cursor.action === "click" ? cursor.sequence : null,
        side: sideFor(botId, cursor, shown),
        layer: layers,
      };
      shown.set(botId, next);
      setCursors((now) => new Map(now).set(botId, next));
    });
    return stop;
  }, [source]);

  const showing = viewport !== null && viewport.width > 0 && viewport.height > 0;
  return (
    <span ref={box} className="pointer-events-none absolute inset-0 block">
      {showing &&
        bots.flatMap((bot) => {
          const shown = cursors.get(bot.id);
          if (shown === undefined) return [];
          return [
            <BotCursor
              key={bot.id}
              bot={bot}
              point={shown.cursor}
              page={viewport}
              side={shown.side}
              layer={shown.layer}
              clicked={shown.clicked}
              onAnswered={(answered) =>
                setCursors((now) => {
                  const current = now.get(bot.id);
                  return current?.clicked === answered
                    ? new Map(now).set(bot.id, { ...current, clicked: null })
                    : now;
                })
              }
              onTagWidth={(width) => tagWidths.current.set(bot.id, width)}
              held={held}
              thinking={!held && bot.thinking}
              still={still}
            />,
          ];
        })}
    </span>
  );
}
