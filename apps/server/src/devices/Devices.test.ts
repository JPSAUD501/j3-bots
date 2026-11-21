// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type DeviceId,
  J3Rpcs,
  MAX_PUSH_TOKEN_LENGTH,
  PairingCode,
  PushToken,
  type PushRegistration,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import * as CommandReceipts from "../commands/CommandReceipts.ts";
import * as Ids from "../Ids.ts";
import * as TestDatabase from "../testing/database.ts";
import * as TestDomain from "../testing/domain.ts";
import * as Devices from "./Devices.ts";

const devices = Devices.layer.pipe(
  Layer.provide(Layer.mergeAll(Ids.layer, CommandReceipts.layer)),
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

const pairDevice = (name: string) =>
  Effect.gen(function* () {
    const service = yield* Devices.Devices;
    const { code } = yield* service.startPairing;
    return (yield* service.pair({ code, name })).deviceId;
  });

const expo = (token: string): PushRegistration => ({
  provider: "expo",
  token: PushToken.make(token),
  platform: "ios",
  language: "pt-BR",
});

/** Which devices the list shows with push on, by name. */
const registered = (current: DeviceId) =>
  Effect.gen(function* () {
    const list = yield* (yield* Devices.Devices).list(current);
    return list.filter((device) => device.pushRegistered).map((device) => device.name);
  });

/** Every stored push token. */
const pushTokens = SqlClient.SqlClient.use(
  (sql) => sql<{ readonly token: string }>`SELECT token FROM push_registrations ORDER BY token`,
).pipe(Effect.map((rows) => rows.map((row) => row.token)));

it.effect(
  "registers a device for push once per command, and a later registration replaces it",
  () =>
    Effect.gen(function* () {
      const service = yield* Devices.Devices;
      const phone = yield* pairDevice("Phone");
      const register = (commandId: string, token: string) =>
        service.registerPush({
          commandId: CommandId.make(commandId),
          deviceId: phone,
          registration: expo(token),
        });

      yield* register("register-1", "ExponentPushToken[fixture-1]");
      yield* service.unregisterPush({ commandId: CommandId.make("off-1"), deviceId: phone });
      // A retry of the first command after a lost reply registers nothing again.
      yield* register("register-1", "ExponentPushToken[fixture-1]");
      assert.deepStrictEqual(yield* registered(phone), []);
      // The same id for another registration is a different command.
      assert.deepStrictEqual(
        failure(yield* register("register-1", "ExponentPushToken[fixture-2]").pipe(Effect.exit)),
        Option.some("Conflict"),
      );

      yield* register("register-2", "ExponentPushToken[fixture-1]");
      yield* register("register-3", "ExponentPushToken[fixture-2]");
      assert.deepStrictEqual(yield* registered(phone), ["Phone"]);
      assert.deepStrictEqual(yield* pushTokens, ["ExponentPushToken[fixture-2]"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("gives a token to the device that registered it last", () =>
  Effect.gen(function* () {
    const service = yield* Devices.Devices;
    const before = yield* pairDevice("Phone, before pairing again");
    const after = yield* pairDevice("Phone");
    for (const [commandId, deviceId] of [
      ["before", before],
      ["after", after],
    ] as const) {
      yield* service.registerPush({
        commandId: CommandId.make(commandId),
        deviceId,
        registration: expo("ExponentPushToken[fixture-1]"),
      });
    }
    assert.deepStrictEqual(yield* registered(after), ["Phone"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends a registration when the device unregisters, signs out or is revoked", () =>
  Effect.gen(function* () {
    const service = yield* Devices.Devices;
    const auth = yield* DeviceAuth;
    const laptop = yield* pairDevice("Laptop");
    const phone = yield* pairDevice("Phone");
    const tablet = yield* pairDevice("Tablet");
    for (const [index, deviceId] of [laptop, phone, tablet].entries()) {
      yield* service.registerPush({
        commandId: CommandId.make(`register-${index}`),
        deviceId,
        registration: expo(`ExponentPushToken[fixture-${index}]`),
      });
    }

    yield* service.unregisterPush({ commandId: CommandId.make("off"), deviceId: laptop });
    // Signing out is the device revoking itself; revoking is another device doing it.
    yield* auth.revoke(phone);
    yield* auth.revoke(tablet);
    assert.deepStrictEqual(yield* registered(laptop), []);
    assert.deepStrictEqual(yield* pushTokens, []);

    // A revoked device's socket, until it closes, cannot register again, and
    // a command it sent before is not answered from its receipt.
    const refused = <A, E extends { readonly _tag: string }>(command: Effect.Effect<A, E>) =>
      command.pipe(Effect.exit, Effect.map(failure));
    assert.deepStrictEqual(
      yield* refused(
        service.registerPush({
          commandId: CommandId.make("late"),
          deviceId: phone,
          registration: expo("ExponentPushToken[fixture-late]"),
        }),
      ),
      Option.some("NotFound"),
    );
    assert.deepStrictEqual(
      yield* refused(
        service.registerPush({
          commandId: CommandId.make("register-1"),
          deviceId: phone,
          registration: expo("ExponentPushToken[fixture-1]"),
        }),
      ),
      Option.some("NotFound"),
    );
    yield* auth.revoke(laptop);
    assert.deepStrictEqual(
      yield* refused(
        service.unregisterPush({ commandId: CommandId.make("off"), deviceId: laptop }),
      ),
      Option.some("NotFound"),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it("refuses a push token that is not printable ASCII or is over its limit", () => {
  const request = J3Rpcs.requests.get("push.register");
  assert.isDefined(request);
  const decode = Schema.decodeUnknownExit(request.payloadSchema);
  const payload = (token: string) => ({
    commandId: "register",
    provider: "expo",
    token,
    platform: "android",
    language: "en",
  });
  assert.isTrue(Exit.isSuccess(decode(payload("x".repeat(MAX_PUSH_TOKEN_LENGTH)))));
  assert.isTrue(Exit.isFailure(decode(payload("x".repeat(MAX_PUSH_TOKEN_LENGTH + 1)))));
  assert.isTrue(Exit.isSuccess(decode(payload("ExponentPushToken[fixture-1]"))));
  assert.isTrue(Exit.isFailure(decode(payload("ExponentPushToken[fixture 1]"))));
  assert.isTrue(Exit.isFailure(decode(payload("ExponentPushToken[fixture-é]"))));
});
