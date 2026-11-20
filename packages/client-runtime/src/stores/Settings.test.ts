// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { latestRead } from "./Settings.ts";

it.effect("shows only the answer of the read started last, whichever answers first", () =>
  Effect.gen(function* () {
    const shown: Array<string> = [];
    const latest = latestRead((value: string) => shown.push(value));
    const older = yield* Deferred.make<string>();
    const newer = yield* Deferred.make<string>();
    const first = yield* Effect.forkChild(latest(Deferred.await(older)), {
      startImmediately: true,
    });
    const second = yield* Effect.forkChild(latest(Deferred.await(newer)), {
      startImmediately: true,
    });

    // The older read answers while the newer one is on its way, then the newer one answers.
    yield* Deferred.succeed(older, "before the save");
    yield* Fiber.join(first);
    assert.deepStrictEqual(shown, []);
    yield* Deferred.succeed(newer, "after the save");
    yield* Fiber.join(second);
    assert.deepStrictEqual(shown, ["after the save"]);
  }),
);
