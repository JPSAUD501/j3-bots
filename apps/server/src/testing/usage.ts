// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, ProviderId } from "@j3-bots/contracts";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { timeText } from "../persistence/columns.ts";
import { until } from "./turns.ts";

let sessions = 0;

/**
 * Turns the bot ran on `providerId`, each finished as it started, in a session
 * of its own retired since: what `usage.turns` reads, without the engine
 * running them. For a client test of what it shows of usage.
 */
export const pastTurns = (
  botId: BotId,
  providerId: ProviderId,
  startedAt: Arr.NonEmptyReadonlyArray<DateTime.Utc>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessionId = `past-turns-${++sessions}`;
    const first = timeText(Arr.min(startedAt, DateTime.Order));
    yield* sql`
      INSERT INTO sessions (id, bot_id, purpose, provider_id, prompt_version, created_at, retired_at)
      VALUES (${sessionId}, ${botId}, 'main', ${providerId}, 'past', ${first}, ${first})
    `;
    yield* sql`INSERT INTO turns ${sql.insert(
      Arr.map(startedAt, (at, index) => ({
        session_id: sessionId,
        engine_turn_id: `turn-${index}`,
        audience: "conversation",
        started_at: timeText(at),
        last_activity_at: timeText(at),
        finished_at: timeText(at),
        outcome_json: JSON.stringify({ _tag: "completed" }),
      })),
    )}`;
  }).pipe(Effect.orDie);

/** Waits until the server has recorded a turn of the bot: for a new bot, its first. */
export const turnRecorded = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* until(
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM turns t JOIN sessions s ON s.id = t.session_id
        WHERE s.bot_id = ${botId}
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) > 0),
      ),
    );
  });
