// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, Label, ProviderId, RoutineId, type UsageTurn } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Time, timeText } from "../persistence/columns.ts";

const TurnRow = Schema.Struct({
  bot_id: BotId,
  purpose: Schema.Literals(["main", "side"]),
  routine_id: Schema.NullOr(RoutineId),
  routine_name: Schema.NullOr(Label),
  provider_id: ProviderId,
  started_at: Time,
  finished_at: Schema.NullOr(Time),
});

/**
 * What bots spent: every turn the engine ran for them, in any of their
 * sessions, with the provider it ran on. A session never changes provider,
 * so a turn's provider is its session's. A turn in a side session is a
 * routine run's, and names its routine. Deleting a routine unlinks its wakes
 * (`wakes.routine_id` is set null) but keeps its side sessions, so such a turn
 * is still told apart from the bot's own, as a deleted routine's.
 */
export class Usage extends Context.Service<
  Usage,
  {
    /**
     * Turns that started in the `period` before `readAt`, the moment they are
     * read, newest first, at most `limit`.
     */
    readonly turns: (input: {
      readonly period: Duration.Duration;
      readonly limit: number;
    }) => Effect.Effect<{
      readonly turns: ReadonlyArray<UsageTurn>;
      readonly readAt: DateTime.Utc;
      readonly hasMore: boolean;
    }>;
  }
>()("@j3-bots/server/turns/Usage") {}

const routineOf = (row: typeof TurnRow.Type): UsageTurn["routine"] => {
  if (row.purpose === "main") return null;
  return row.routine_id === null || row.routine_name === null
    ? { _tag: "deleted" }
    : { _tag: "routine", id: row.routine_id, name: row.routine_name };
};

export const layer = Layer.effect(
  Usage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inPeriod = SqlSchema.findAll({
      Request: Schema.Struct({ since: Schema.String, until: Schema.String, limit: Schema.Number }),
      Result: TurnRow,
      execute: ({ since, until, limit }) => sql`
        SELECT s.bot_id, s.purpose, r.id AS routine_id, r.name AS routine_name, s.provider_id,
          t.started_at, t.finished_at
        FROM turns t JOIN sessions s ON s.id = t.session_id
        LEFT JOIN wakes w ON w.id = s.side_wake_id
        LEFT JOIN routines r ON r.id = w.routine_id
        WHERE t.started_at > ${since} AND t.started_at <= ${until}
        ORDER BY t.started_at DESC, t.rowid DESC
        LIMIT ${limit}
      `,
    });

    const turns = Effect.fn("Usage.turns")(function* (input: {
      readonly period: Duration.Duration;
      readonly limit: number;
    }) {
      // One moment bounds the period on both ends, so a turn that starts
      // while the rows are read neither shows nor shifts the period.
      const readAt = yield* DateTime.now;
      const rows = yield* inPeriod({
        since: timeText(DateTime.subtractDuration(readAt, input.period)),
        until: timeText(readAt),
        // One more than asked says whether there are more.
        limit: input.limit + 1,
      });
      return {
        turns: rows.slice(0, input.limit).map((row): UsageTurn => ({
          botId: row.bot_id,
          routine: routineOf(row),
          providerId: row.provider_id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        })),
        readAt,
        hasMore: rows.length > input.limit,
      };
    }, Effect.orDie);

    return Usage.of({ turns });
  }),
);
