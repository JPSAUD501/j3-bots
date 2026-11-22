// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, WorkStep } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { json } from "../persistence/columns.ts";

/**
 * The step that says what a work fold's work is doing or did: one still
 * running first, since steps run in parallel and a later one may finish
 * first; then one that is not housekeeping, such as updating the plan or
 * looking in on a background task, which a turn often ends with; then the
 * newest. Both the roster's preview and a working bot's state show it.
 */
export const shownStep = (sql: SqlClient.SqlClient) => {
  const row = SqlSchema.findOneOption({
    Request: EntryId,
    Result: Schema.Struct({ step_json: json(WorkStep) }),
    execute: (entryId) => sql`
      SELECT step_json FROM work_steps WHERE entry_id = ${entryId}
      ORDER BY json_extract(step_json, '$.status') = 'running' DESC,
        coalesce(json_extract(step_json, '$.tool'), '') IN ('plan', 'task-status') ASC,
        position DESC
      LIMIT 1
    `,
  });
  return (entryId: EntryId): Effect.Effect<Option.Option<WorkStep>> =>
    row(entryId).pipe(Effect.map(Option.map((found) => found.step_json)), Effect.orDie);
};
