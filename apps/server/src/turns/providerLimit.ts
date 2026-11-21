// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderId } from "@j3-bots/contracts";
import { TurnOutcome } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { EngineState } from "../engine/EngineState.ts";
import { json } from "../persistence/columns.ts";

/** A provider at its usage limit, until its reset when that is known. */
interface ProviderLimit {
  readonly resetsAt: DateTime.Utc | null;
}

const LastOutcome = Schema.Struct({ outcome_json: json(TurnOutcome) });

/**
 * Whether a provider is at its usage limit, which holds automated wakes until
 * its reset. The engine's status may say so; otherwise the turns the server
 * saw end on that provider, in any session of any bot, do: the newest one
 * that either completed or failed at the usage limit, when it failed with a
 * reset still ahead. A turn that completed after it shows the limit lifted.
 * A turn ran on its session's provider, which never changes.
 */
export const providerLimit = (sql: SqlClient.SqlClient, engineState: EngineState["Service"]) => {
  const lastOutcome = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: LastOutcome,
    execute: (providerId) => sql`
      SELECT t.outcome_json FROM turns t
      JOIN sessions s ON s.id = t.session_id
      WHERE s.provider_id = ${providerId} AND t.finished_at IS NOT NULL
        AND (json_extract(t.outcome_json, '$._tag') = 'completed'
          OR json_extract(t.outcome_json, '$.failure') = 'usage-limit')
      ORDER BY t.finished_at DESC
      LIMIT 1
    `,
  });

  return Effect.fn("providerLimit")(function* (
    providerId: ProviderId,
  ): Effect.fn.Return<Option.Option<ProviderLimit>> {
    const status = yield* engineState.current;
    const provider = status.providers.find((p) => p.id === providerId);
    if (provider?.status._tag === "limited") {
      return Option.some({ resetsAt: provider.status.resetsAt });
    }
    const last = yield* lastOutcome(providerId).pipe(Effect.orDie);
    if (Option.isNone(last)) return Option.none();
    const outcome = last.value.outcome_json;
    if (outcome._tag !== "failed" || outcome.retryAt === null) return Option.none();
    return DateTime.isGreaterThan(outcome.retryAt, yield* DateTime.now)
      ? Option.some({ resetsAt: outcome.retryAt })
      : Option.none();
  });
};
