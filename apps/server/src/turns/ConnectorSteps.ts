// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConnectorId, EntryId, Label, WorkStep, WorkStepId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { json } from "../persistence/columns.ts";
import { SessionRowId } from "./model.ts";
import { WorkSteps } from "./WorkSteps.ts";

/**
 * What J3 Bots adds to the work step of a bot's call to a connector's tool:
 * which connector it is, the tool's `_meta.ui` (MCP Apps), and while the
 * call runs, how far it got. A step that loads a connector's skill gets the
 * connector too, and its skill names the connector as the operator does. The engine writes the step itself, as the call
 * starts and ends; the step's id is the engine's id of the call, which the
 * call's claim names. So what is added is kept by the session and the call
 * (`connector_steps`), applied to the step as it is now, and applied again
 * each time the engine writes the step (`annotate`).
 */

/** Where a connector's call is: its session, its turn, and the engine's id of the call, which is its step's. */
export interface CallPlace {
  readonly sessionId: SessionRowId;
  readonly turnId: TurnId;
  readonly callId: string;
}

export class ConnectorSteps extends Context.Service<
  ConnectorSteps,
  {
    /** The call to a tool of `connectorId` goes out; `ui` is the tool's `_meta.ui`. */
    readonly started: (
      place: CallPlace,
      call: { readonly connectorId: ConnectorId; readonly ui: Schema.JsonObject | null },
    ) => Effect.Effect<void>;
    /** What the call last said of how far it got, on one line. */
    readonly progress: (place: CallPlace, text: string) => Effect.Effect<void>;
  }
>()("@j3-bots/server/turns/ConnectorSteps") {}

/** The most characters a step's progress keeps. */
const MAX_PROGRESS = 200;

const Annotation = Schema.Struct({
  connector_id: ConnectorId,
  ui_json: Schema.NullOr(json(Schema.JsonObject)),
  progress: Schema.NullOr(Schema.String),
  /** The connector's name now; null once it is removed. */
  connector_name: Schema.NullOr(Label),
});
type Annotation = typeof Annotation.Type;

const applied = (step: WorkStep, annotation: Annotation): WorkStep => {
  const { progress: _, ...rest } = step;
  return {
    ...rest,
    connector: { connectorId: annotation.connector_id, ui: annotation.ui_json },
    ...(step.skill !== undefined && annotation.connector_name !== null
      ? { skill: { ...step.skill, connector: annotation.connector_name } }
      : {}),
    // Only while it runs: a finished step says how it ended.
    ...(step.status === "running" && annotation.progress !== null
      ? { progress: annotation.progress }
      : {}),
  };
};

/**
 * The step with what J3 Bots added to it, if it is a connector's call it
 * annotated; as it is otherwise. For the observer, as it writes a step.
 */
export const annotate = (sql: SqlClient.SqlClient) => {
  const find = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: SessionRowId, callId: WorkStepId }),
    Result: Annotation,
    execute: ({ sessionId, callId }) => sql`
      SELECT s.connector_id, s.ui_json, s.progress, c.name AS connector_name
      FROM connector_steps s LEFT JOIN connectors c ON c.id = s.connector_id
      WHERE s.session_id = ${sessionId} AND s.call_id = ${callId}
    `,
  });
  return (
    sessionId: SessionRowId,
    step: WorkStep,
  ): Effect.Effect<WorkStep, SqlError.SqlError | Schema.SchemaError> =>
    step.kind !== "tool" || (step.tool !== "connector" && step.tool !== "connector-skill")
      ? Effect.succeed(step)
      : Effect.map(find({ sessionId, callId: step.id }), (found) =>
          Option.match(found, { onNone: () => step, onSome: (a) => applied(step, a) }),
        );
};

const StepRow = Schema.Struct({ entry_id: EntryId, step_json: json(WorkStep) });
const encodeStep = Schema.encodeEffect(json(WorkStep));
const encodeUi = Schema.encodeEffect(json(Schema.JsonObject));

export const layer = Layer.effect(
  ConnectorSteps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workSteps = yield* WorkSteps;
    const withAnnotation = annotate(sql);

    const stepOf = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: SessionRowId,
        turnId: Schema.String,
        callId: Schema.String,
      }),
      Result: StepRow,
      execute: ({ sessionId, turnId, callId }) => sql`
        SELECT s.entry_id, s.step_json FROM work_steps s
        JOIN turns t ON t.work_fold_entry_id = s.entry_id
        WHERE t.session_id = ${sessionId} AND t.engine_turn_id = ${turnId}
          AND s.step_id = ${callId}
      `,
    });

    /** Applies what is kept for the call to its step, if the engine wrote it already. */
    const rewrite = Effect.fn("ConnectorSteps.rewrite")(function* (place: CallPlace) {
      const found = yield* stepOf(place);
      if (Option.isNone(found)) return;
      const step = yield* withAnnotation(place.sessionId, found.value.step_json);
      yield* sql`
        UPDATE work_steps SET step_json = ${yield* encodeStep(step)}
        WHERE entry_id = ${found.value.entry_id} AND step_id = ${step.id}
      `;
      yield* sql.afterCommit(workSteps.changed(found.value.entry_id, step));
    });

    const started = Effect.fn("ConnectorSteps.started")(
      function* (
        place: CallPlace,
        call: { readonly connectorId: ConnectorId; readonly ui: Schema.JsonObject | null },
      ) {
        const ui = call.ui === null ? null : yield* encodeUi(call.ui);
        yield* sql`
          INSERT INTO connector_steps (session_id, call_id, connector_id, ui_json, progress)
          VALUES (${place.sessionId}, ${place.callId}, ${call.connectorId}, ${ui}, NULL)
          ON CONFLICT (session_id, call_id) DO UPDATE SET
            connector_id = excluded.connector_id, ui_json = excluded.ui_json
        `;
        yield* rewrite(place);
      },
      sql.withTransaction,
      Effect.orDie,
    );

    const progress = Effect.fn("ConnectorSteps.progress")(
      function* (place: CallPlace, text: string) {
        const line = text.replace(/\s+/gu, " ").trim().slice(0, MAX_PROGRESS);
        if (line === "") return;
        const updated = yield* sql`
          UPDATE connector_steps SET progress = ${line}
          WHERE session_id = ${place.sessionId} AND call_id = ${place.callId}
          RETURNING call_id
        `;
        if (updated.length > 0) yield* rewrite(place);
      },
      sql.withTransaction,
      Effect.orDie,
    );

    return ConnectorSteps.of({ started, progress });
  }),
);
