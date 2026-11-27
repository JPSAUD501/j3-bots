// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A bot's turn as its conversation shows it while it runs: one row where the
 * turn's work goes, with what the bot is doing, which becomes the turn's work
 * fold when it ends. Everything here comes from
 * what the server says: the bot's state for the turn and its start, the
 * conversation's entries for its fold. Nothing is made up on the client.
 */
import type { Bot, BotId, WorkFoldEntry } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import type { TimelineItem } from "./timeline.ts";
import { turnKey } from "./timeline.ts";

/** A turn under way in a bot's conversation. */
export interface LiveTurn {
  readonly botId: BotId;
  /** When the turn started, on the server: what its row and its fold are known by. */
  readonly startedAt: DateTime.Utc;
}

/**
 * The bot's turn under way, from its state: one that thinks, works, or waits
 * on a card within the turn. A bot that waits between turns, on a card it
 * asked, has none: its turn has ended.
 */
export function liveTurn(bot: Bot): LiveTurn | null {
  const { state } = bot;
  switch (state._tag) {
    case "thinking":
    case "working":
      return { botId: bot.id, startedAt: state.since };
    case "waiting":
      return state.since === null ? null : { botId: bot.id, startedAt: state.since };
    case "blocked":
    case "idle":
      return null;
  }
}

const sameTime = (a: DateTime.Utc, b: DateTime.Utc) =>
  DateTime.toEpochMillis(a) === DateTime.toEpochMillis(b);

/**
 * Whether `fold` is the work of the turn that started at `startedAt`. A fold
 * from a server that predates `turnStartedAt` is taken for the turn's when
 * it was written after the turn started, unless it finished before then: a
 * late fold of the turn before.
 */
export function foldOfTurn(fold: WorkFoldEntry, startedAt: DateTime.Utc): boolean {
  if (fold.turnStartedAt !== null) return sameTime(fold.turnStartedAt, startedAt);
  const start = DateTime.toEpochMillis(startedAt);
  return (
    DateTime.toEpochMillis(fold.createdAt) >= start &&
    (fold.status._tag !== "finished" || DateTime.toEpochMillis(fold.status.finishedAt) >= start)
  );
}

/**
 * The conversation's rows with the turn under way shown in them, once:
 *
 * - once the turn has done work, its fold is the row, in the fold's place;
 * - before that, a row at the end, where the bot's reply will appear, below
 *   anything the bot says meanwhile, until the turn ends;
 * - once its fold has finished, the turn is over, whatever the bot's state
 *   still says: the conversation can learn it before the roster does.
 *
 * The row's key comes from the turn's start, as its fold's does, so it is
 * the same element from the turn's first moment to its fold.
 */
export function withLiveTurn(
  rows: ReadonlyArray<TimelineItem>,
  turn: LiveTurn | null,
): ReadonlyArray<TimelineItem> {
  if (turn === null) return rows;
  const key = turnKey(turn.startedAt);
  const index = rows.findLastIndex(
    (row) => row.kind === "work" && row.fold !== null && foldOfTurn(row.fold, turn.startedAt),
  );
  const found = rows[index];
  if (found === undefined || found.kind !== "work" || found.fold === null) {
    return [...rows, { kind: "work", key, fold: null, live: true }];
  }
  if (found.fold.status._tag === "finished") return rows;
  return rows.map((row, i) => (i === index ? { ...found, key, live: true } : row));
}
