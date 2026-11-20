// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, ProviderId, type UsageTurn } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Time, timeText } from "../persistence/columns.ts";

const TurnRow = Schema.Struct({
  bot_id: BotId,
  provider_id: ProviderId,
  started_at: Time,
  finished_at: Schema.NullOr(Time),
});

/**
 * What bots spent: every turn the engine ran for them, in any of their
 * sessions, with the provider it ran on. A session never changes provider,
 * so a turn's provider is its session's.
 */
export class Usage extends Context.Service<
  Usage,
  {
    /** Turns that started after `since`, newest first, at most `limit`. */
    readonly turns: (input: {
      readonly since: DateTime.Utc;
      readonly limit: number;
    }) => Effect.Effect<{ readonly turns: ReadonlyArray<UsageTurn>; readonly hasMore: boolean }>;
  }
>()("@j3-bots/server/turns/Usage") {}

export const layer = Layer.effect(
  Usage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const after = SqlSchema.findAll({
      Request: Schema.Struct({ since: Schema.String, limit: Schema.Number }),
      Result: TurnRow,
      execute: ({ since, limit }) => sql`
        SELECT s.bot_id, s.provider_id, t.started_at, t.finished_at
        FROM turns t JOIN sessions s ON s.id = t.session_id
        WHERE t.started_at > ${since}
        ORDER BY t.started_at DESC, t.rowid DESC
        LIMIT ${limit}
      `,
    });

    const turns = Effect.fn("Usage.turns")(function* (input: {
      readonly since: DateTime.Utc;
      readonly limit: number;
    }) {
      // One more than asked says whether there are more.
      const rows = yield* after({ since: timeText(input.since), limit: input.limit + 1 });
      return {
        turns: rows.slice(0, input.limit).map((row): UsageTurn => ({
          botId: row.bot_id,
          // Side sessions, and so routine runs, come with routines.
          routineId: null,
          providerId: row.provider_id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        })),
        hasMore: rows.length > input.limit,
      };
    }, Effect.orDie);

    return Usage.of({ turns });
  }),
);
