// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CommandId, type Device, type DeviceId, PushToken } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { CurrentDevice } from "../auth/DeviceAuth.ts";
import { Devices } from "../devices/Devices.ts";
import * as TestDomain from "../testing/domain.ts";
import { handlers, ServedRpcs } from "./handlers.ts";

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ServedRpcs>>;

/** Runs `use` with a client of a socket that `deviceId` opened. */
const asDevice = <A, E, R>(deviceId: DeviceId, use: (client: Client) => Effect.Effect<A, E, R>) =>
  RpcTest.makeClient(ServedRpcs).pipe(
    Effect.flatMap(use),
    Effect.scoped,
    Effect.provide(handlers),
    Effect.provideService(CurrentDevice, { id: deviceId }),
  );

/** What a device list says of each device, by name: whether it is this one, and has push on. */
const byName = (devices: ReadonlyArray<Device>) =>
  Object.fromEntries(
    devices.map((device) => [device.name, [device.current, device.pushRegistered]] as const),
  );

const pairDevice = (name: string) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const { code } = yield* devices.startPairing;
    return (yield* devices.pair({ code, name })).deviceId;
  });

it.effect("registers for push only the device whose socket asks, and lists only that it has", () =>
  Effect.gen(function* () {
    const laptop = yield* pairDevice("Laptop");
    const phone = yield* pairDevice("Phone");

    const listed = yield* asDevice(phone, (client) =>
      client["push.register"]({
        commandId: CommandId.make("register"),
        provider: "expo",
        token: PushToken.make("ExponentPushToken[fixture-1]"),
        platform: "android",
        language: "en",
      }).pipe(Effect.andThen(client["devices.list"]())),
    );

    // The list says which device has push on, and nothing of its token.
    const KEYS = ["current", "id", "lastSeenAt", "name", "pairedAt", "pushRegistered"];
    for (const device of listed) assert.deepStrictEqual(Object.keys(device).sort(), KEYS);
    assert.deepStrictEqual(byName(listed), { Laptop: [false, false], Phone: [true, true] });
    const fromLaptop = yield* asDevice(laptop, (client) => client["devices.list"]());
    assert.deepStrictEqual(byName(fromLaptop), { Laptop: [true, false], Phone: [false, true] });
  }).pipe(Effect.provide(TestDomain.layer)),
);
