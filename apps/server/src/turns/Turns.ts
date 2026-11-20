// SPDX-License-Identifier: AGPL-3.0-or-later
import { Engine } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BotStates } from "./BotStates.ts";
import { Cards } from "./Cards.ts";
import { Observer } from "./Observer.ts";
import { Pipeline } from "./Pipeline.ts";
import { Signals } from "./Signals.ts";
import { Stops } from "./Stops.ts";

/**
 * Starts the turn machinery once the engine is ready, in the order a restart
 * needs (`docs/architecture/server.md`, Failure handling): every unconfirmed
 * Stop round is sent again before any session's events are opened, then the
 * events resume from their cursors, submissions and recoveries left undecided
 * are settled, held queues are resumed, and only then does anything new go
 * out. Each later time the engine becomes ready, what waited on it is sent.
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

    const readiness = engine.status.pipe(
      Stream.map((status) => status.state._tag === "ready"),
      Stream.changes,
      Stream.filter((ready) => ready),
    );

    const start = Effect.gen(function* () {
      yield* stops.resendUnconfirmed;
      yield* observer.watchAll;
      yield* cards.checkSubmissions;
      yield* pipeline.recoverDue;
      yield* observer.resumeAllHeld;
      yield* cards.respondPending;
      yield* signals.dispatch.fire;
    }).pipe(Effect.withSpan("Turns.start"));

    /** The engine came back: what waited on it goes now. */
    const ready = Effect.gen(function* () {
      yield* stops.resendUnconfirmed;
      yield* observer.watchAll;
      yield* observer.resumeAllHeld;
      yield* cards.respondPending;
      yield* signals.recovery.fire;
      yield* signals.dispatch.fire;
    }).pipe(Effect.withSpan("Turns.ready"));

    const run = Effect.gen(function* () {
      yield* readiness.pipe(Stream.runHead);
      yield* start;
      yield* Effect.all(
        [
          readiness.pipe(
            Stream.drop(1),
            Stream.runForEach(() => ready),
          ),
          pipeline.run,
          stops.run,
          cards.run,
          states.watchStalls,
        ],
        { concurrency: "unbounded", discard: true },
      );
    });

    yield* Effect.forkScoped(run);
  }),
);
