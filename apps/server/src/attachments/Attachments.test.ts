// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Attachment, Conflict, HTTP_PATHS, MAX_ATTACHMENT_SIZE } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { transactional } from "../persistence/transaction.ts";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import { Layout } from "../Layout.ts";
import { Attachments } from "./Attachments.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import * as WebClient from "../web/WebClient.ts";

const server = Ports.serve(Http.app, NodeHttpServer.layerTest, { logAddress: false }).pipe(
  Layer.provide(WebClient.statusLayer),
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

  it.effect(
    "stores nothing, and says why, while the attachments folder leads into the web client",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* Layout;
        const { webClient } = yield* ServerConfig;
        const token = yield* pairedToken;
        const published = path.join(webClient.directory, "attachments");
        yield* fs.makeDirectory(published, { recursive: true });
        yield* fs.remove(layout.attachments, { recursive: true, force: true });
        yield* fs.symlink(published, layout.attachments);

        const refused = yield* upload(token, "secret.txt", bytesOf("private"));

        assert.strictEqual(refused.status, 409);
        const conflict = yield* HttpClientResponse.schemaBodyJson(Conflict)(refused);
        assert.strictEqual(conflict.reason, "private-location");
        assert.deepStrictEqual(yield* fs.readDirectory(published), []);
        yield* fs.remove(layout.attachments);
      }),
  );

  it.effect("removes unreferenced bytes, but never through a link above them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const layout = yield* Layout;
      const attachments = yield* Attachments;
      const { webClient } = yield* ServerConfig;
      const token = yield* pairedToken;
      const decode = HttpClientResponse.schemaBodyJson(Attachment);
      const kept = yield* upload(token, "kept.txt", bytesOf("bytes under a link")).pipe(
        Effect.flatMap(decode),
      );
      const removed = yield* upload(token, "removed.txt", bytesOf("bytes in place")).pipe(
        Effect.flatMap(decode),
      );
      const storagePath = (id: string) =>
        sql<{ readonly storage_path: string }>`
          SELECT b.storage_path FROM blobs b JOIN attachments a ON a.sha256 = b.sha256
          WHERE a.id = ${id}
        `.pipe(Effect.map(([row]) => path.join(layout.attachments, row?.storage_path ?? "")));
      const keptFile = yield* storagePath(kept.id);
      const removedFile = yield* storagePath(removed.id);
      assert.notStrictEqual(path.dirname(keptFile), path.dirname(removedFile));
      // The kept blob's folder is moved into the web client's and linked back.
      const published = path.join(webClient.directory, path.basename(path.dirname(keptFile)));
      yield* fs.makeDirectory(webClient.directory, { recursive: true });
      yield* fs.rename(path.dirname(keptFile), published);
      yield* fs.symlink(published, path.dirname(keptFile));

      yield* transactional(sql)(attachments.purge([kept.id, removed.id]));

      assert.isFalse(yield* fs.exists(removedFile));
      assert.isTrue(yield* fs.exists(path.join(published, path.basename(keptFile))));
      yield* fs.remove(path.dirname(keptFile));
    }),
  );
});
