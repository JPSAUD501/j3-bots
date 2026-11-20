// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { Devices } from "../devices/Devices.ts";
import * as TestDomain from "../testing/domain.ts";
import * as AdminClient from "./AdminClient.ts";
import * as AdminSocket from "./AdminSocket.ts";

it.layer(AdminClient.layer.pipe(Layer.provideMerge(TestDomain.layer)))("admin socket", (it) => {
  it.effect("pairs a first device through the running server, and only then", () =>
    Effect.gen(function* () {
      const { adminSocket } = yield* ServerConfig;
      const admin = yield* AdminClient.AdminClient;
      const devices = yield* Devices;
      assert.isTrue(Option.isNone(yield* admin.startPairing(adminSocket)));

      yield* Effect.gen(function* () {
        const before = yield* admin.status(adminSocket);
        assert.strictEqual(Option.getOrUndefined(before)?.pairedDevices, 0);

        const grant = yield* admin.startPairing(adminSocket);
        assert.isTrue(Option.isSome(grant));
        if (Option.isNone(grant)) return;
        yield* devices.pair({ code: grant.value.code, name: "Phone" });

        const after = yield* admin.status(adminSocket);
        assert.strictEqual(Option.getOrUndefined(after)?.pairedDevices, 1);

        // A second server for the same home stops before it starts anything.
        const second = yield* AdminSocket.claim.pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(second));
      }).pipe(Effect.provide(AdminSocket.layer), Effect.scoped);

      // Closing removed the socket: the server is gone, not unreachable.
      assert.isTrue(Option.isNone(yield* admin.status(adminSocket)));
    }),
  );

  it.effect("takes over the socket a crashed server left behind", () =>
    Effect.gen(function* () {
      const { adminSocket } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(adminSocket, "");
      yield* AdminSocket.claim;
      assert.isFalse(yield* fs.exists(adminSocket));
    }),
  );
});
