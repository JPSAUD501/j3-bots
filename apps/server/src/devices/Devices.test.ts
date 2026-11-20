// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { PairingCode } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Ids from "../Ids.ts";
import * as TestDatabase from "../testing/database.ts";
import * as Devices from "./Devices.ts";

const devices = Devices.layer.pipe(
  Layer.provide(Ids.layer),
  Layer.provideMerge(TestDatabase.layer),
);

const WRONG = PairingCode.make("0000000000");

const failure = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.findErrorOption(exit).pipe(Option.map((error) => error._tag));

it.effect("locks pairing for fifteen minutes after five failures in fifteen minutes", () =>
  Effect.gen(function* () {
    const service = yield* Devices.Devices;
    const pair = (code: PairingCode) => service.pair({ code, name: "Phone" }).pipe(Effect.exit);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.deepStrictEqual(failure(yield* pair(WRONG)), Option.some("Invalid"));
      yield* TestClock.adjust("1 minute");
    }

    const { code } = yield* service.startPairing;
    const locked = yield* pair(code);
    const retryAt = Exit.findErrorOption(locked).pipe(
      Option.flatMap((error) =>
        error._tag === "RateLimited" ? Option.some(error.retryAt) : Option.none(),
      ),
    );
    assert.isTrue(Option.isSome(retryAt));

    yield* TestClock.adjust("15 minutes");
    const { code: fresh } = yield* service.startPairing;
    assert.isTrue(Exit.isSuccess(yield* pair(fresh)));
    assert.strictEqual(
      Option.getOrThrow(retryAt).epochMilliseconds,
      DateTime.makeUnsafe(4 * 60_000 + 15 * 60_000).epochMilliseconds,
    );
  }).pipe(Effect.provide(devices)),
);

it.effect("accepts a code once and not after five minutes", () =>
  Effect.gen(function* () {
    const service = yield* Devices.Devices;
    const pair = (code: PairingCode) => service.pair({ code, name: "Phone" }).pipe(Effect.exit);
    const { code } = yield* service.startPairing;
    const { code: late } = yield* service.startPairing;

    assert.isTrue(Exit.isSuccess(yield* pair(code)));
    assert.deepStrictEqual(failure(yield* pair(code)), Option.some("Invalid"));
    yield* TestClock.adjust("5 minutes");
    assert.deepStrictEqual(failure(yield* pair(late)), Option.some("Invalid"));
  }).pipe(Effect.provide(devices)),
);
