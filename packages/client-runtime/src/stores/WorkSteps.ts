// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId, WorkStep, WorkStepId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";
import { makeKeyed } from "./keyed.ts";

export interface WorkStepsState {
  /**
   * `finished`: the fold's turn ended and its steps so far have arrived. Work
   * the turn handed off may add more, read when the fold is opened again.
   */
  readonly phase: "loading" | "live" | "finished" | "not-found";
  readonly stale: boolean;
  /** In the order they started. A step that changes keeps its place. */
  readonly steps: ReadonlyArray<WorkStep>;
}

/** The steps behind a folded "Worked · 6 steps" line, while the operator has it open. */
export class WorkSteps extends Context.Service<
  WorkSteps,
  {
    readonly open: (foldId: EntryId) => Effect.Effect<Readable<WorkStepsState>, never, Scope.Scope>;
  }
>()("@j3-bots/client-runtime/stores/WorkSteps") {}

export const layer = Layer.effect(
  WorkSteps,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const scope = yield* Scope.Scope;

    const openStore = Effect.fnUntraced(function* (foldId: EntryId) {
      const steps = new Map<WorkStepId, WorkStep>();
      const state = new Cell<WorkStepsState>({ phase: "loading", stale: true, steps: [] });
      const publish = (phase: WorkStepsState["phase"], stale: boolean) =>
        state.set({
          phase,
          stale,
          steps: [...steps.values()].toSorted(
            (a, b) => a.startedAt.epochMilliseconds - b.startedAt.epochMilliseconds,
          ),
        });
      const finished = yield* Deferred.make<void>();

      const follow = connection.eachSession((client) =>
        client["entries.workSteps"]({ entryId: foldId }).pipe(
          Stream.runForEach((frame) =>
            Effect.sync(() => {
              if (frame._tag === "snapshot") {
                steps.clear();
                for (const step of frame.steps) steps.set(step.id, step);
              } else {
                steps.set(frame.step.id, frame.step);
              }
              publish("live", false);
            }),
          ),
          // The stream ends on its own only once the turn is over.
          Effect.andThen(
            Effect.sync(() => publish("finished", false)).pipe(
              Effect.andThen(Deferred.succeed(finished, void 0)),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              const current = state.get();
              if (current.phase !== "finished") publish(current.phase, true);
            }),
          ),
        ),
      );

      const run = follow.pipe(
        Effect.raceFirst(Deferred.await(finished)),
        Effect.catchTag("NotFound", () => Effect.sync(() => publish("not-found", false))),
      );
      const readable: Readable<WorkStepsState> = state;
      return { value: readable, run, close: () => {} };
    });

    const stores = makeKeyed(scope, (foldId: EntryId) => foldId, openStore);
    return WorkSteps.of({ open: stores.acquire });
  }),
);
