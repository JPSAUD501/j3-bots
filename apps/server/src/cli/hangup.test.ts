// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { endedOnHangup } from "./hangup.ts";

it.effect("ends a command when its terminal hangs up, cleaning up what it made", () =>
  Effect.gen(function* () {
    const cleaned = yield* Ref.make(false);
    const started = yield* Deferred.make<void>();
    const fiber = yield* Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Ref.set(cleaned, true));
      yield* Deferred.succeed(started, undefined);
      return yield* Effect.never;
    }).pipe(Effect.scoped, endedOnHangup, Effect.forkChild);
    yield* Deferred.await(started);
    // Both sides of the race have started once the hangup is listened for.
    while (process.listenerCount("SIGHUP") === 0) yield* Effect.yieldNow;
    // What an SSH connection that drops sends.
    process.emit("SIGHUP", "SIGHUP");
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.isTrue(yield* Ref.get(cleaned));
    // Done, it leaves Node's own answer to the next hangup in place.
    assert.strictEqual(process.listenerCount("SIGHUP"), 0);
  }),
);
