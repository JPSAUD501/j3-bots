// SPDX-License-Identifier: AGPL-3.0-or-later
import { Engine } from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BotStates } from "./BotStates.ts";
import { Cards } from "./Cards.ts";
import { HeldQueues } from "./HeldQueues.ts";
import { Observer } from "./Observer.ts";
import { Pipeline } from "./Pipeline.ts";
import { Readiness } from "./Readiness.ts";
import { DEFECT_RETRY } from "./reconciler.ts";
import { Signals } from "./Signals.ts";
import { Stops } from "./Stops.ts";

/**
 * Starts the turn machinery each time the engine becomes ready
 * (`docs/architecture/server.md`, Failure handling): every session's events
 * start to be followed again from their cursors, and the workers are released
 * at once. What a restart must do before anything new reaches a session is
 * each worker's own rule for that session, read from the database: no first
 * send while a Stop of it is unsettled or a dispatch of it is undecided, no
 * send before its events are known, no resume before they are caught up. So
 * one session's slow marker never holds up another's work. While the engine
 * is not ready the workers stay held. Each loop is supervised on its own: a
 * defect in one never stops the others.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Engine;
    const signals = yield* Signals;
    const stops = yield* Stops;
    const observer = yield* Observer;
    const pipeline = yield* Pipeline;
    const cards = yield* Cards;
    const held = yield* HeldQueues;
    const states = yield* BotStates;
    const readiness = yield* Readiness;
    const scope = yield* Effect.scope;

    /** A failure is logged and the sequence goes on. */
    const step = (what: string, effect: Effect.Effect<unknown>) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError(what, cause),
        ),
      );

    const start = Effect.gen(function* () {
      yield* step("Sessions could not be followed", observer.watchAll);
      yield* readiness.release;
      yield* signals.stops.fire;
      yield* signals.recovery.fire;
      yield* signals.resumes.fire;
      yield* signals.responses.fire;
      yield* signals.dispatch.fire;
      // A submission whose answer was lost, in the background: its card's
      // own lock keeps the next submission to it behind this check.
      yield* step("Secret submissions could not be checked", cards.checkSubmissions).pipe(
        Effect.forkIn(scope),
      );
    }).pipe(Effect.withSpan("Turns.start"));

    /**
     * A loop that fails unexpectedly is logged and started again after a
     * pause, alone: the others go on.
     */
    const supervised = (name: string, loop: Effect.Effect<unknown>) =>
      loop.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError(`${name} failed; it starts again`, cause),
        ),
        Effect.andThen(Effect.sleep(DEFECT_RETRY)),
        Effect.forever,
      );

    const run = Effect.all(
      [
        supervised(
          "Following the engine's readiness",
          engine.status.pipe(
            Stream.map((status) => status.state._tag === "ready"),
            Stream.changes,
            Stream.runForEach((ready) => (ready ? start : readiness.hold)),
          ),
        ),
        supervised("The dispatcher and the recovery", pipeline.run),
        supervised("The Stop runner", stops.run),
        supervised("The responder", cards.run),
        supervised("The held-queue resumer", held.run),
        supervised("Watching for stalled turns", states.watchStalls),
      ],
      { concurrency: "unbounded", discard: true },
    );

    yield* Effect.forkScoped(run);
  }),
);
