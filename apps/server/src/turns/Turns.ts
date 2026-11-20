// SPDX-License-Identifier: AGPL-3.0-or-later
import { Engine } from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BotStates } from "./BotStates.ts";
import { Cards } from "./Cards.ts";
import { Observer } from "./Observer.ts";
import { Pipeline } from "./Pipeline.ts";
import { Readiness } from "./Readiness.ts";
import { Signals } from "./Signals.ts";
import { Stops } from "./Stops.ts";

/**
 * Starts the turn machinery each time the engine becomes ready, in the order a
 * restart needs (`docs/architecture/server.md`, Failure handling): every
 * unconfirmed Stop round is sent again before any session's events are
 * opened, then the events resume from their cursors and the Stops observe
 * them, submissions and recoveries left undecided are settled, held queues
 * are resumed, and only then is the machinery released to send anything new.
 * While the engine is not ready it stays held, so no loop runs ahead of that
 * order.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Engine;
    const signals = yield* Signals;
    const stops = yield* Stops;
    const observer = yield* Observer;
    const pipeline = yield* Pipeline;
    const cards = yield* Cards;
    const states = yield* BotStates;
    const readiness = yield* Readiness;

    /** One step's failure is logged and the sequence goes on: each step is retried by its loop. */
    const step = (what: string, effect: Effect.Effect<unknown>) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError(what, cause),
        ),
      );

    const start = Effect.gen(function* () {
      yield* step("Stop rounds could not be sent again", stops.resendUnconfirmed);
      yield* step("Sessions could not be followed", observer.watchAll);
      yield* step("Stops could not be observed", stops.runPending);
      yield* step("Secret submissions could not be checked", cards.checkSubmissions);
      yield* step("Undecided dispatches could not be recovered", pipeline.recoverDue);
      yield* step("Held queues could not be resumed", observer.resumeAllHeld);
      yield* step("Answers could not be sent", cards.respondPending);
      yield* readiness.release;
      yield* signals.stops.fire;
      yield* signals.recovery.fire;
      yield* signals.dispatch.fire;
    }).pipe(Effect.withSpan("Turns.start"));

    const run = Effect.all(
      [
        engine.status.pipe(
          Stream.map((status) => status.state._tag === "ready"),
          Stream.changes,
          Stream.runForEach((ready) => (ready ? start : readiness.hold)),
        ),
        pipeline.run,
        stops.run,
        cards.run,
        states.watchStalls,
      ],
      { concurrency: "unbounded", discard: true },
    );

    yield* Effect.forkScoped(run);
  }),
);
