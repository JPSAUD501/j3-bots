// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { PairingCode } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ServerConfig } from "../config.ts";
import { Devices } from "../devices/Devices.ts";
import * as Home from "../home/Home.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import * as WebClient from "../web/WebClient.ts";
import * as AdminClient from "./AdminClient.ts";
import * as AdminSocket from "./AdminSocket.ts";
import type { PairingOffer } from "./protocol.ts";

/**
 * The admin socket of a server holding the test home, with the server's web
 * client decision and the test domain's listener.
 */
const adminServer = AdminSocket.layer.pipe(Layer.provide(Home.layer));

/** The code an offer grants; anything else fails the test. */
const granted = <E, R>(
  offer: Effect.Effect<Option.Option<PairingOffer>, E, R>,
): Effect.Effect<Extract<PairingOffer, { readonly _tag: "granted" }>, E, R> =>
  offer.pipe(
    Effect.flatMap((answer) =>
      Option.isSome(answer) && answer.value._tag === "granted"
        ? Effect.succeed(answer.value)
        : Effect.die(`expected a code, got ${JSON.stringify(answer)}`),
    ),
  );

it.layer(AdminClient.layer.pipe(Layer.provideMerge(TestDomain.layer)))("admin socket", (it) => {
  it.effect("pairs a first device through the running server, and only then", () =>
    Effect.gen(function* () {
      const { adminSocket, home } = yield* ServerConfig;
      const admin = yield* AdminClient.AdminClient;
      const devices = yield* Devices;
      assert.isTrue(Option.isNone(yield* admin.startPairing(adminSocket, { unlock: false })));

      yield* Effect.gen(function* () {
        const before = yield* admin.status(adminSocket);
        assert.strictEqual(Option.getOrUndefined(before)?.pairedDevices, 0);
        assert.deepStrictEqual(Option.getOrUndefined(before)?.listener, {
          scheme: "http",
          address: "0.0.0.0",
          port: 3737,
          names: [],
        });

        const grant = yield* granted(admin.startPairing(adminSocket, { unlock: false }));
        yield* devices.pair({ code: grant.code, name: "Phone" });

        const after = yield* admin.status(adminSocket);
        assert.strictEqual(Option.getOrUndefined(after)?.pairedDevices, 1);

        // A second server for the same home stops before it opens anything.
        const second = yield* Home.reserve.pipe(Effect.scoped, Effect.exit);
        const refusal = Exit.isFailure(second) ? Exit.findErrorOption(second) : Option.none();
        assert.deepInclude(Option.getOrUndefined(refusal), { _tag: "ServerAlreadyRunning", home });
      }).pipe(
        Effect.provide(adminServer.pipe(Layer.provide(WebClient.statusLayer))),
        Effect.scoped,
      );

      // Closing removed the socket: the server is gone, not unreachable.
      assert.isTrue(Option.isNone(yield* admin.status(adminSocket)));
    }),
  );

  it.effect("lifts a lock on pairing from the host, and pairs at once", () =>
    Effect.gen(function* () {
      const { adminSocket } = yield* ServerConfig;
      const admin = yield* AdminClient.AdminClient;
      const devices = yield* Devices;
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 5; attempt++) {
          yield* devices
            .pair({ code: PairingCode.make("0000000000"), name: "Guess" })
            .pipe(Effect.ignore);
        }
        const locked = yield* admin.startPairing(adminSocket, { unlock: false });
        assert.strictEqual(Option.getOrUndefined(locked)?._tag, "locked");

        const grant = yield* granted(admin.startPairing(adminSocket, { unlock: true }));
        const paired = yield* devices.pair({ code: grant.code, name: "Phone" }).pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(paired));
      }).pipe(
        Effect.provide(adminServer.pipe(Layer.provide(WebClient.statusLayer))),
        Effect.scoped,
      );
    }),
  );

  it.effect("reports the web client as the server decided to serve it, not as it is on disk", () =>
    Effect.gen(function* () {
      const { adminSocket, webClient } = yield* ServerConfig;
      const admin = yield* AdminClient.AdminClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* Effect.gen(function* () {
        // Built after the server decided it had no client to serve.
        yield* fs.makeDirectory(webClient.directory, { recursive: true });
        yield* fs.writeFileString(path.join(webClient.directory, "index.html"), "<!doctype html>");
        yield* Effect.gen(function* () {
          const page = yield* HttpClient.execute(
            HttpClientRequest.get("/").pipe(HttpClientRequest.setHeader("accept", "text/html")),
          );
          assert.strictEqual(page.status, 404);
          const status = yield* admin.status(adminSocket);
          assert.strictEqual(Option.getOrUndefined(status)?.webClient, "not-built");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              adminServer,
              Ports.serve(WebClient.layer, NodeHttpServer.layerTest, { logAddress: false }),
            ),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.provide(WebClient.statusLayer));
    }),
  );
});
