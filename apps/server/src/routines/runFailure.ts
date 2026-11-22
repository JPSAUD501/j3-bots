// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineRunFailure } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { json } from "../persistence/columns.ts";
import type { DispatchRowId } from "../turns/model.ts";

const encodeRunFailure = Schema.encodeEffect(json(RoutineRunFailure));

/**
 * Records why a routine's attempt failed, when J3 Bots can name it, on its
 * run, still running, whose attempt's wake `dispatchId` carries: the run's
 * history names it if the run fails for good, and its retry clears it
 * (`RoutineRuns`). Written in the transaction that fails the attempt.
 */
export const recordRunFailure = (sql: SqlClient.SqlClient) =>
  Effect.fn("recordRunFailure")(function* (dispatchId: DispatchRowId, failure: RoutineRunFailure) {
    const encoded = yield* encodeRunFailure(failure);
    yield* sql`
      UPDATE routine_runs SET failure_json = ${encoded}
      WHERE status = 'running'
        AND wake_id IN (SELECT id FROM wakes WHERE dispatch_id = ${dispatchId})
    `;
  }, Effect.orDie);
