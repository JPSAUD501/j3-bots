// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EntryOrder, EntryTarget } from "@j3-bots/contracts";
import { useMemo } from "react";
import {
  arrivalCounts,
  buildTimeline,
  liveTurn,
  readThrough,
  withLiveTurn,
} from "@j3-bots/client-runtime/presentation";
import { useArrivals, useConversationEnd } from "@j3-bots/client-runtime/react";
import { scrollToEnd, useScrollFollow } from "../components/ToLatest";
import { useCardPlace } from "../lib/useCardPlace";
import { useSeenEntries } from "../lib/useSeenEntries";
import type { ConversationView } from "./data";

/**
 * A conversation as its timeline shows it, wherever that is: its rows, with
 * the turn under way of the bot it belongs to; what just arrived at its end,
 * which settles in and is counted while the operator reads above it; the view
 * following that end; what the operator can see of it marked as read; and the
 * card the bot waits on, with where it is.
 */
export function useConversationView({
  selectionKey,
  target,
  view,
  bot,
  timeline,
  markRead,
}: {
  /** Which conversation this is; null while none shows. */
  readonly selectionKey: string | null;
  readonly target: EntryTarget | null;
  readonly view: ConversationView | null;
  /** In a bot's conversation, the bot: its turn under way shows in the timeline, once. */
  readonly bot: Bot | null;
  /** The element that scrolls the timeline, once it is mounted. */
  readonly timeline: HTMLElement | null;
  readonly markRead: (target: EntryTarget, through: EntryOrder) => void;
}) {
  const items = view?.items ?? null;
  // What the operator can see of the open conversation, they have read.
  useSeenEntries(timeline, (ids) => {
    if (target === null || items === null) return;
    const order = readThrough(
      items.map((i) => (i._tag !== "outgoing" && ids.has(i.id) ? i.order : null)),
    );
    if (order !== null) markRead(target, order);
  });
  const turn = useMemo(() => (bot === null ? null : liveTurn(bot)), [bot]);
  const rows = useMemo(() => withLiveTurn(buildTimeline(items ?? []), turn), [items, turn]);
  const folds = useMemo(
    () => (items ?? []).flatMap((entry) => (entry._tag === "work-fold" ? [entry] : [])),
    [items],
  );
  const arrived = useArrivals(
    selectionKey,
    rows.map((row) => row.key),
    view?.phase === "ready",
  );
  const end = useConversationEnd(selectionKey, arrived, arrivalCounts(rows, arrived), () =>
    scrollToEnd(timeline),
  );
  useScrollFollow(timeline, end.follow);
  // The card the conversation's bot waits on, and where it is.
  const waitingOn = bot?.state._tag === "waiting" ? bot.state.entryId : null;
  const waitingPlace = useCardPlace(timeline, waitingOn);
  return { rows, folds, arrived, end, waitingOn, waitingPlace };
}
