// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HTTP_PATHS, PROTOCOL_VERSION, ServerInfo } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Http from "./http.ts";
import * as TestDomain from "./testing/domain.ts";

it.layer(
  Http.layer.pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(TestDomain.layer)),
)("http", (it) => {
  it.effect("tells a client which protocol it speaks before it pairs", () =>
    Effect.gen(function* () {
      const info = yield* HttpClient.get(HTTP_PATHS.server).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ServerInfo)),
      );
      assert.strictEqual(info.protocolVersion, PROTOCOL_VERSION);
    }),
  );
});
