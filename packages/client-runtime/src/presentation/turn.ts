// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A bot's turn as its conversation shows it while it runs: one row where the
 * turn's work goes, with what the bot is doing and how long the turn has run,
 * which becomes the turn's work fold when it ends. Everything here comes from
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
  /** When the turn started, on the server: what its clock counts from. */
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
 * it was written after the turn started.
 */
export function foldOfTurn(fold: WorkFoldEntry, startedAt: DateTime.Utc): boolean {
  return fold.turnStartedAt === null
    ? DateTime.toEpochMillis(fold.createdAt) >= DateTime.toEpochMillis(startedAt)
    : sameTime(fold.turnStartedAt, startedAt);
}

/**
 * The conversation's rows with the turn under way shown in them, once:
 *
 * - once the turn has done work, its fold is the row, in the fold's place;
 * - before that, a row at the end, where the bot's reply will appear, until
 *   the bot says something in the turn: the reply then takes its place.
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
    (row) =>
      row.kind === "work" &&
      row.fold !== null &&
      row.fold.status._tag === "running" &&
      foldOfTurn(row.fold, turn.startedAt),
  );
  if (index !== -1) {
    return rows.map((row, i) =>
      i === index && row.kind === "work" ? { ...row, key, live: true } : row,
    );
  }
  const started = DateTime.toEpochMillis(turn.startedAt);
  const spoke = rows.some(
    (row) =>
      row.kind === "message" &&
      row.message._tag === "message" &&
      row.message.author._tag === "bot" &&
      row.message.author.botId === turn.botId &&
      DateTime.toEpochMillis(row.message.createdAt) >= started,
  );
  if (spoke) return rows;
  return [...rows, { kind: "work", key, fold: null, live: true }];
}

/** How long the turn has run at `now`, in ms; never less than none, whatever the device's clock says. */
export const turnElapsed = (turn: LiveTurn, now: number): number =>
  Math.max(0, now - DateTime.toEpochMillis(turn.startedAt));

/** A turn's clock: "0:07", "12:40", then "1:02:03" past an hour. */
export function turnClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, "0");
  return hours === 0
    ? `${minutes}:${seconds}`
    : `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}
