// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SendPause from "./SendPause.ts";

const noWork = (bots: number) => bots === 0;

/** A first send under `pause`, and whether it went. */
const firstSend = (pause: SendPause.SendPause["Service"]) =>
  Effect.gen(function* () {
    const sent = { done: false };
    const fiber = yield* pause
      .sending(
        Effect.sync(() => {
          sent.done = true;
        }),
      )
      .pipe(Effect.forkChild);
    return { sent, fiber };
  });

it.effect("holds first sends once no work ran, until the lease ends; not once some ran", () =>
  Effect.gen(function* () {
    const pause = yield* SendPause.SendPause;
    assert.strictEqual(yield* pause.held(Effect.succeed(0), noWork, "2 minutes"), 0);
    const held = yield* firstSend(pause);
    yield* TestClock.adjust("119 seconds");
    assert.isFalse(held.sent.done);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(held.fiber);
    assert.isTrue(held.sent.done);

    assert.strictEqual(yield* pause.held(Effect.succeed(2), noWork, "2 minutes"), 2);
    const free = yield* firstSend(pause);
    yield* Fiber.join(free.fiber);
    assert.isTrue(free.sent.done);
  }).pipe(Effect.provide(SendPause.layer)),
);

it.effect("does not keep the server from stopping while it holds", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(SendPause.layer, scope);
    yield* Effect.service(SendPause.SendPause).pipe(
      Effect.flatMap((pause) => pause.held(Effect.succeed(0), noWork, "2 minutes")),
      Effect.provide(context),
    );
    // No time passes: the stop does not wait out the lease.
    yield* Scope.close(scope, Exit.void);
  }),
);
