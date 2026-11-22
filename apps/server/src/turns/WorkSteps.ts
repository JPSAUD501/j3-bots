// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, NotFound, WorkStep } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import { json } from "../persistence/columns.ts";

/**
 * What `entries.workSteps` streams: every step so far, then each step as it
 * changes, until the fold's turn ends and the work it handed off with it.
 */
export type WorkStepsFrame =
  | { readonly _tag: "snapshot"; readonly steps: ReadonlyArray<WorkStep> }
  | { readonly _tag: "step"; readonly step: WorkStep };

type Change =
  | { readonly _tag: "step"; readonly entryId: EntryId; readonly step: WorkStep }
  | { readonly _tag: "finished"; readonly entryId: EntryId };

/**
 * The steps of a turn's work fold, as the observer applies them. A step that
 * changes in place (a running command, then its result) changes no entry, so
 * the steps are followed here rather than through the entry's changes.
 */
export class WorkSteps extends Context.Service<
  WorkSteps,
  {
    /** Tells followers about a step the observer just committed. */
    readonly changed: (entryId: EntryId, step: WorkStep) => Effect.Effect<void>;
    /**
     * Tells followers the fold's turn ended, and the work it handed off with
     * it: its steps change no more.
     */
    readonly finished: (entryId: EntryId) => Effect.Effect<void>;
    readonly follow: (entryId: EntryId) => Stream.Stream<WorkStepsFrame, NotFound>;
    /**
     * The step that says what the fold's work is doing or did: the newest
     * one still running, since steps run in parallel and a later one may
     * finish first; else the newest.
     */
    readonly shown: (entryId: EntryId) => Effect.Effect<Option.Option<WorkStep>>;
  }
>()("@j3-bots/server/turns/WorkSteps") {}

export const layer = Layer.effect(
  WorkSteps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = yield* Entries;
    const pubsub = yield* PubSub.unbounded<Change>();

    const stepsOf = SqlSchema.findAll({
      Request: EntryId,
      Result: Schema.Struct({ step_json: json(WorkStep) }),
      execute: (entryId) => sql`
        SELECT step_json FROM work_steps WHERE entry_id = ${entryId} ORDER BY position
      `,
    });

    const shownRow = SqlSchema.findOneOption({
      Request: EntryId,
      Result: Schema.Struct({ step_json: json(WorkStep) }),
      execute: (entryId) => sql`
        SELECT step_json FROM work_steps WHERE entry_id = ${entryId}
        ORDER BY json_extract(step_json, '$.status') = 'running' DESC, position DESC LIMIT 1
      `,
    });

    const shown = (entryId: EntryId) =>
      shownRow(entryId).pipe(Effect.map(Option.map((row) => row.step_json)), Effect.orDie);

    const changed = (entryId: EntryId, step: WorkStep) =>
      PubSub.publish(pubsub, { _tag: "step", entryId, step }).pipe(Effect.asVoid);

    const finished = (entryId: EntryId) =>
      PubSub.publish(pubsub, { _tag: "finished", entryId }).pipe(Effect.asVoid);

    const follow = (entryId: EntryId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribed before the snapshot is read, so no step falls between.
          const live = yield* PubSub.subscribe(pubsub);
          const fold = yield* entries.find(entryId);
          if (Option.isNone(fold) || fold.value.entry._tag !== "work-fold") {
            return yield* new NotFound({ resource: "entry" });
          }
          const steps = (yield* stepsOf(entryId).pipe(Effect.orDie)).map((row) => row.step_json);
          const snapshot = Stream.succeed<WorkStepsFrame>({ _tag: "snapshot", steps });
          const { status } = fold.value.entry;
          if (status._tag === "finished" && !status.background) return snapshot;
          return Stream.concat(
            snapshot,
            Stream.fromSubscription(live).pipe(
              Stream.filter((change) => change.entryId === entryId),
              Stream.takeWhile(
                (change): change is Extract<Change, { readonly _tag: "step" }> =>
                  change._tag === "step",
              ),
              Stream.map((change): WorkStepsFrame => ({ _tag: "step", step: change.step })),
            ),
          );
        }),
      );

    return WorkSteps.of({ changed, finished, follow, shown });
  }),
);
