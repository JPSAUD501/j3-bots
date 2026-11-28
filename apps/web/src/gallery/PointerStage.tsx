// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor } from "@j3-bots/client-runtime";
import type { BotId } from "@j3-bots/contracts";
import { useEffect, useState } from "react";
import { type CursorSource, type PointerOnTab, TabPointers } from "../browser/TabPointers";
import type { PointerBot } from "../browser/BotCursor";

/** The page the stage stands for, in its own px. */
const PAGE = { width: 640, height: 280 };
/** How long the script runs before it starts again, in seconds. */
const LOOP = 15;

/** One moment of the script, `at` seconds in. */
type Beat =
  | {
      readonly at: number;
      readonly bot: 0 | 1;
      readonly point: readonly [number, number];
      readonly click: boolean;
    }
  | { readonly at: number; readonly bot: 0 | 1; readonly thinks: boolean }
  | { readonly at: number; readonly held: boolean };

/**
 * Two bots on one tab, as a view of it draws them: they come in, move, click
 * and think; one tag flips at the page's edge, another away from the first
 * bot's; the person takes the tab and gives it back. It plays on a loop.
 */
const SCRIPT: ReadonlyArray<Beat> = [
  { at: 0.4, bot: 0, point: [120, 80], click: true },
  { at: 1.6, bot: 0, thinks: true },
  { at: 3.8, bot: 0, thinks: false },
  { at: 3.8, bot: 0, point: [520, 210], click: true },
  { at: 4.8, bot: 1, point: [300, 110], click: true },
  { at: 5.8, bot: 0, point: [600, 40], click: true },
  { at: 6.6, bot: 1, point: [340, 150], click: true },
  { at: 7.4, bot: 1, thinks: true },
  { at: 8.8, bot: 1, thinks: false },
  { at: 8.8, held: true },
  { at: 10.8, held: false },
  { at: 11.6, bot: 0, point: [180, 236], click: true },
  { at: 12.4, bot: 1, point: [196, 248], click: false },
  { at: 12.7, bot: 1, point: [240, 200], click: true },
];

/** The bots' pointers over a still page, played from `SCRIPT`. */
export function PointerStage({ bots }: { readonly bots: readonly [PointerBot, PointerBot] }) {
  const [listeners] = useState(() => new Set<(cursor: BrowserCursor) => void>());
  const [source] = useState<CursorSource>(() => ({
    onCursor: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  }));
  const [round, setRound] = useState(0);
  const [held, setHeld] = useState(false);
  const [thinking, setThinking] = useState<ReadonlySet<BotId>>(new Set());
  // The script follows the two bots, whatever array they come in.
  const first = bots[0].id;
  const second = bots[1].id;
  useEffect(() => {
    // Each round's points are new ones.
    let sequence = round * SCRIPT.length;
    const timers = SCRIPT.map((beat) =>
      window.setTimeout(() => {
        if ("held" in beat) {
          setHeld(beat.held);
          return;
        }
        const botId = beat.bot === 0 ? first : second;
        if ("thinks" in beat) {
          setThinking((now) => {
            const next = new Set(now);
            if (beat.thinks) next.add(botId);
            else next.delete(botId);
            return next;
          });
          return;
        }
        sequence += 1;
        const [x, y] = beat.point;
        const cursor: BrowserCursor = {
          action: beat.click ? "click" : "move",
          x,
          y,
          botId,
          sequence,
        };
        for (const listener of listeners) listener(cursor);
      }, beat.at * 1000),
    );
    const again = window.setTimeout(() => setRound((now) => now + 1), LOOP * 1000);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.clearTimeout(again);
    };
  }, [first, second, listeners, round]);
  const onTab: ReadonlyArray<PointerOnTab> = bots.map((bot) => ({
    ...bot,
    thinking: thinking.has(bot.id),
  }));
  return (
    <div
      className="relative max-w-xl overflow-hidden rounded-lg border border-border bg-background"
      style={{ aspectRatio: `${PAGE.width} / ${PAGE.height}` }}
    >
      <TabPointers
        source={source}
        place={`round ${round}`}
        viewport={PAGE}
        bots={onTab}
        held={held}
      />
    </div>
  );
}
