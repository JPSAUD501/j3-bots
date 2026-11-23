// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, WorkFoldEntry } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useRef, useState } from "react";
import { foldOfTurn, liveTurn } from "../presentation/turn.ts";
import type { PresentationContext } from "../wording/status.ts";
import { nextSpoken, turnAnnouncement, type Spoken } from "../wording/turn.ts";

/**
 * Says what `bot` is doing through `announce`, politely, as its conversation
 * changes: each new state and each new line while it works, then the line
 * its turn folds into, once, and that what it shows is only what it last
 * knew while `offline` (`turnAnnouncement`). What it is doing as the
 * conversation opens is not said. `folds` are the conversation's work folds;
 * a null `bot`, a room, says nothing. Mount one per conversation.
 */
export function useTurnAnnouncement(
  bot: Bot | null,
  folds: ReadonlyArray<WorkFoldEntry>,
  offline: boolean,
  ctx: PresentationContext,
  announce: (text: string) => void,
): void {
  const live = bot === null ? null : liveTurn(bot);
  // The turn last seen under way, kept once it ends to find the fold it ended in.
  const [last, setLast] = useState<DateTime.Utc | null>(live?.startedAt ?? null);
  if (
    live !== null &&
    (last === null || DateTime.toEpochMillis(live.startedAt) !== DateTime.toEpochMillis(last))
  ) {
    setLast(live.startedAt);
  }
  const ended =
    live === null && last !== null
      ? (folds.findLast((fold) => foldOfTurn(fold, last)) ?? null)
      : null;
  const said = bot === null ? null : turnAnnouncement(bot, ended, offline, ctx);
  // What it is doing as the conversation opens is taken as said.
  const spoken = useRef<Spoken>({ key: said?.key ?? null, ending: null });
  // After every render: a render that changes nothing to say says nothing.
  useEffect(() => {
    const next = nextSpoken(spoken.current, said);
    spoken.current = next.spoken;
    if (next.say !== null) announce(next.say);
  });
}
