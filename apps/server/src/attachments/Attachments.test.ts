// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Attachment, HTTP_PATHS, MAX_ATTACHMENT_SIZE } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import * as TestDomain from "../testing/domain.ts";

const server = Http.layer.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(TestDomain.layer),
);

const pairedToken = Effect.gen(function* () {
  const devices = yield* Devices;
  const { code } = yield* devices.startPairing;
  return (yield* devices.pair({ code, name: "Laptop" })).token;
});

const upload = (token: string, name: string, bytes: Uint8Array, mediaType = "text/plain") =>
  HttpClientRequest.post(HTTP_PATHS.attachments).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setUrlParam("name", name),
    HttpClientRequest.bodyUint8Array(bytes, mediaType),
    HttpClient.execute,
  );

const bytesOf = (text: string) => new TextEncoder().encode(text);

it.layer(server)("attachments", (it) => {
  it.effect("stores the same bytes once under two names, and serves each to a paired device", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const token = yield* pairedToken;
      const decode = HttpClientResponse.schemaBodyJson(Attachment);
      const first = yield* upload(
        token,
        " notes.txt ",
        bytesOf("same bytes"),
        "Text/Plain; charset=utf-8",
      ).pipe(Effect.flatMap(decode));
      const second = yield* upload(token, "copy.txt", bytesOf("same bytes")).pipe(
        Effect.flatMap(decode),
      );
      const [blobs] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM blobs`;

      assert.notStrictEqual(first.id, second.id);
      assert.strictEqual(first.name, "notes.txt");
      assert.strictEqual(first.mediaType, "text/plain");
      assert.strictEqual(blobs?.count, 1);

      const served = yield* HttpClientRequest.get(`${HTTP_PATHS.attachments}/${second.id}`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClient.execute,
      );
      assert.strictEqual(yield* served.text, "same bytes");
      const anonymous = yield* HttpClient.get(`${HTTP_PATHS.attachments}/${second.id}`);
      assert.strictEqual(anonymous.status, 401);
    }),
  );

  it.effect("refuses an empty file, unusable metadata and a file over the size limit", () =>
    Effect.gen(function* () {
      const token = yield* pairedToken;

      const empty = yield* upload(token, "empty.txt", new Uint8Array(0));
      const blank = yield* upload(token, "   ", bytesOf("x"));
      const badType = yield* upload(token, "a.txt", bytesOf("x"), "not a media type");
      const large = yield* upload(token, "big.bin", new Uint8Array(MAX_ATTACHMENT_SIZE + 1));

      assert.deepStrictEqual(
        [empty.status, blank.status, badType.status, large.status],
        [400, 400, 400, 413],
      );
    }),
  );
});
