// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ServerConfig } from "../../config.ts";
import * as Layout from "../../Layout.ts";
import * as TestDatabase from "../../testing/database.ts";
import { chromeFolders, ensureChrome } from "./chrome.ts";

/** A client that answers every request with `status` and `body`. */
const answering = (status: number, body: Uint8Array) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
  );

const install = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const files = yield* Layout.Layout;
    return yield* ensureChrome({ home, platform: "linux64", files, client }).pipe(Effect.flip);
  });

const layer = Layout.layer.pipe(
  Layer.provideMerge(TestDatabase.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("the server's browser download", (it) => {
  it.effect("refuses a download that is not the pinned one, and keeps none of it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home } = yield* ServerConfig;
      const failed = yield* install(answering(200, new Uint8Array([1, 2, 3])));
      assert.strictEqual(failed.reason, "checksum");
      assert.isFalse(yield* fs.exists(chromeFolders(path, home, "linux64").partial));
    }),
  );

  it.effect("says Google could not be reached when the download is refused", () =>
    Effect.gen(function* () {
      const failed = yield* install(answering(503, new Uint8Array()));
      assert.strictEqual(failed.reason, "unreachable");
    }),
  );
});
