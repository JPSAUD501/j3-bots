// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { HTTP_PATHS, MAX_PROVIDER_KEY_LENGTH } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import * as Listener from "../listener.ts";
import * as TestDomain from "../testing/domain.ts";
import * as WebClient from "../web/WebClient.ts";

/** Every line the server logs while these tests run, at any level, as JSON. */
const logged: Array<string> = [];
const recordLogs = Layer.merge(
  Logger.layer([
    Logger.map(Logger.formatJson, (line) => {
      logged.push(line);
    }),
  ]),
  Layer.succeed(References.MinimumLogLevel, "All"),
);

/** What a client could send as `provider.connect`, unchecked: a key of any length. */
const UncheckedRpcs = RpcGroup.make(
  Rpc.make("provider.connect", {
    payload: { baseUrl: Schema.String, key: Schema.String, stopWork: Schema.Boolean },
    success: Schema.Unknown,
  }),
);

const KEY = "sk-not-a-real-endpoint-key";

// The client listener as the server runs it, on a port the system chooses.
it.layer(
  Http.serve(Listener.layer, { logAddress: false }).pipe(
    Layer.provide(recordLogs),
    Layer.provide(WebClient.statusLayer),
    Layer.provideMerge(TestDomain.servedLayer),
  ),
  { excludeTestServices: true },
)("an endpoint's key over the socket", (it) => {
  it.effect("is in no answer and no log, whether the server refuses it or stores it", () =>
    Effect.gen(function* () {
      const devices = yield* Devices;
      const { code } = yield* devices.startPairing;
      const { token } = yield* devices.pair({ code, name: "Laptop" });
      const bound = yield* Deferred.await(yield* Listener.Listener);
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            NodeSocket.layerWebSocket(`ws://${bound.address}:${bound.port}${HTTP_PATHS.rpc}`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
          Layer.provide(RpcSerialization.layerJson),
        ),
      );
      const client = yield* RpcClient.make(UncheckedRpcs).pipe(Effect.provide(protocol));
      const connect = (key: string) =>
        client["provider.connect"]({ baseUrl: "https://proxy.example", key, stopWork: true }).pipe(
          Effect.exit,
        );

      const oversized = KEY.repeat(Math.ceil((MAX_PROVIDER_KEY_LENGTH + 1) / KEY.length));
      const refused = yield* connect(oversized);
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused)) assert.notInclude(Cause.pretty(refused.cause), KEY);

      const stored = yield* connect(KEY);
      assert.isTrue(Exit.isSuccess(stored));
      assert.notInclude(JSON.stringify(Exit.isSuccess(stored) ? stored.value : null), KEY);

      assert.isFalse(logged.some((line) => line.includes(KEY)));
    }).pipe(Effect.scoped),
  );
});
