// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  Attachment,
  Conflict,
  HTTP_PATHS,
  MAX_ATTACHMENT_SIZE,
  MAX_RECORDING_SIZE,
  RECORDING_CHUNK_SIZE,
  RecordingOffset,
  RecordingUpload,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../config.ts";
import { transactional } from "../persistence/transaction.ts";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import * as Ids from "../Ids.ts";
import * as Layout from "../Layout.ts";
import * as Attachments from "./Attachments.ts";
import * as RecordingUploads from "./RecordingUploads.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDatabase from "../testing/database.ts";
import * as TestDisk from "../testing/diskSpace.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as RefusedNames from "../web/RefusedNames.ts";
import * as WebClient from "../web/WebClient.ts";

const server = Ports.serve(Http.app, NodeHttpServer.layerTest, { logAddress: false }).pipe(
  Layer.provide([WebClient.statusLayer, RefusedNames.layer, TestUpdates.layer]),
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

/**
 * `size` bytes that end as a zip does: bytes that vary, then the record that
 * closes a zip, with no comment.
 */
const zipOf = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size - 22; at++) bytes[at] = (at * 7) % 251;
  bytes.set([0x50, 0x4b, 0x05, 0x06], size - 22);
  return bytes;
};

const recordingOf = (id: string) => `${HTTP_PATHS.recordingUploads}/${id}`;

const beginRecording = (token: string, name: string, size: number) =>
  HttpClientRequest.post(HTTP_PATHS.recordingUploads).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyText(JSON.stringify({ name, size }), "application/json"),
    HttpClient.execute,
  );

const recordingPiece = (token: string, id: string, offset: number, bytes: Uint8Array) =>
  HttpClientRequest.put(recordingOf(id)).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setUrlParam("offset", String(offset)),
    HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
    HttpClient.execute,
  );

const recordingStatus = (token: string, id: string) =>
  HttpClientRequest.get(recordingOf(id)).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClient.execute,
  );

const asRecording = HttpClientResponse.schemaBodyJson(RecordingUpload);

const startedRecording = (token: string, name: string, size: number) =>
  beginRecording(token, name, size).pipe(Effect.flatMap(asRecording));

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
        const layout = yield* Layout.Layout;
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
      const layout = yield* Layout.Layout;
      const attachments = yield* Attachments.Attachments;
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

  it.effect("removes the bytes a store wrote for a transaction that rolled back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const layout = yield* Layout.Layout;
      const attachments = yield* Attachments.Attachments;
      yield* fs.makeDirectory(layout.attachments, { recursive: true });
      const before = yield* fs.readDirectory(layout.attachments, { recursive: true });

      const failed = yield* attachments
        .withStore((put) =>
          transactional(sql)(
            put({ name: "draft.txt", mediaType: "text/plain", bytes: bytesOf("rolled back") }).pipe(
              Effect.andThen(Effect.fail("after the file" as const)),
            ),
          ),
        )
        .pipe(Effect.flip);

      assert.strictEqual(failed, "after the file");
      const [blobs] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM blobs b JOIN attachments a ON a.sha256 = b.sha256
        WHERE a.name = 'draft.txt'
      `;
      assert.strictEqual(blobs?.count, 0);
      const after = yield* fs.readDirectory(layout.attachments, { recursive: true });
      assert.deepStrictEqual(
        after.filter((entry) => !before.includes(entry) && entry.length > 2),
        [],
      );
    }),
  );

  it.effect(
    "uploads a recording in pieces, resumes where it stands, and stores the whole file",
    () =>
      Effect.gen(function* () {
        const token = yield* pairedToken;
        const bytes = zipOf(RECORDING_CHUNK_SIZE + 100);
        const upload = yield* startedRecording(token, " screen.zip ", bytes.length);
        assert.strictEqual(upload.received, 0);

        const first = yield* recordingPiece(
          token,
          upload.id,
          0,
          bytes.subarray(0, RECORDING_CHUNK_SIZE),
        ).pipe(Effect.flatMap(asRecording));
        assert.strictEqual(first.received, RECORDING_CHUNK_SIZE);
        assert.isUndefined(first.attachment);
        const standing = yield* recordingStatus(token, upload.id).pipe(Effect.flatMap(asRecording));
        assert.strictEqual(standing.received, RECORDING_CHUNK_SIZE);

        // A piece sent again, its answer lost, is told where the upload stands.
        const stale = yield* recordingPiece(token, upload.id, 0, bytes.subarray(0, 10));
        assert.strictEqual(stale.status, 409);
        const offset = yield* HttpClientResponse.schemaBodyJson(RecordingOffset)(stale);
        assert.strictEqual(offset.received, RECORDING_CHUNK_SIZE);

        const last = yield* recordingPiece(
          token,
          upload.id,
          RECORDING_CHUNK_SIZE,
          bytes.subarray(RECORDING_CHUNK_SIZE),
        ).pipe(Effect.flatMap(asRecording));
        assert.isDefined(last.attachment);
        assert.strictEqual(last.attachment.name, "screen.zip");
        assert.strictEqual(last.attachment.mediaType, "application/zip");
        assert.strictEqual(last.attachment.size, bytes.length);
        // The answer to the last piece, lost too, is given again.
        const again = yield* recordingPiece(token, upload.id, bytes.length, new Uint8Array(0)).pipe(
          Effect.flatMap(asRecording),
        );
        assert.strictEqual(again.attachment?.id, last.attachment.id);

        const served = yield* HttpClientRequest.get(
          `${HTTP_PATHS.attachments}/${last.attachment.id}`,
        ).pipe(HttpClientRequest.bearerToken(token), HttpClient.execute);
        assert.isTrue(Buffer.from(yield* served.arrayBuffer).equals(Buffer.from(bytes)));
      }),
  );

  it.effect("keeps what arrived of a piece cut off, and goes on from there", () =>
    Effect.gen(function* () {
      const uploads = yield* RecordingUploads.RecordingUploads;
      const bytes = zipOf(1000);
      const upload = yield* uploads.begin({ name: "cut.zip", size: bytes.length });

      const cut = yield* uploads
        .append({
          id: upload.id,
          offset: 0,
          bytes: Stream.make(bytes.subarray(0, 300)).pipe(
            Stream.concat(Stream.fail(new RecordingUploads.PieceCutOff())),
          ),
        })
        .pipe(Effect.flip);
      assert.strictEqual(cut._tag, "PieceCutOff");
      assert.strictEqual((yield* uploads.status(upload.id)).received, 300);

      const rest = yield* uploads.append({
        id: upload.id,
        offset: 300,
        bytes: Stream.make(bytes.subarray(300)),
      });
      assert.strictEqual(rest.attachment?.size, bytes.length);
    }),
  );

  it.effect(
    "refuses a recording over the limit, a piece too large, bytes past the size and a file that is not a zip",
    () =>
      Effect.gen(function* () {
        const token = yield* pairedToken;
        assert.strictEqual(
          (yield* beginRecording(token, "huge.zip", MAX_RECORDING_SIZE + 1)).status,
          413,
        );
        assert.strictEqual((yield* beginRecording(token, "   ", 10)).status, 400);

        const upload = yield* startedRecording(token, "a.zip", RECORDING_CHUNK_SIZE * 2);
        const large = yield* recordingPiece(
          token,
          upload.id,
          0,
          new Uint8Array(RECORDING_CHUNK_SIZE + 1),
        );
        assert.strictEqual(large.status, 413);

        // Either of these removes the upload: what arrived cannot be the file.
        const short = yield* startedRecording(token, "b.zip", 10);
        const past = yield* recordingPiece(token, short.id, 0, new Uint8Array(11));
        const plain = yield* startedRecording(token, "c.zip", 100);
        const notZip = yield* recordingPiece(token, plain.id, 0, new Uint8Array(100));
        assert.deepStrictEqual(
          [
            past.status,
            notZip.status,
            (yield* recordingStatus(token, short.id)).status,
            (yield* recordingStatus(token, plain.id)).status,
          ],
          [400, 400, 404, 404],
        );
      }),
  );

  it.effect("never takes what a link at an upload's file leads to as the recording", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* Layout.Layout;
      const token = yield* pairedToken;
      const bytes = zipOf(100);
      const upload = yield* startedRecording(token, "linked.zip", bytes.length);
      // Another file of the declared size, put at the upload's name by a link.
      const elsewhere = path.join(layout.attachments, "..", "elsewhere.zip");
      yield* fs.writeFile(elsewhere, bytes);
      yield* fs.symlink(elsewhere, path.join(layout.attachments, "uploads", `${upload.id}.part`));

      const finishing = yield* recordingPiece(token, upload.id, bytes.length, new Uint8Array(0));
      assert.strictEqual(finishing.status, 409);
      const offset = yield* HttpClientResponse.schemaBodyJson(RecordingOffset)(finishing);
      assert.strictEqual(offset.received, 0);
      const written = yield* recordingPiece(token, upload.id, 0, bytes);
      assert.strictEqual(written.status, 409);
      const standing = yield* recordingStatus(token, upload.id).pipe(Effect.flatMap(asRecording));
      assert.isUndefined(standing.attachment);
    }),
  );

  it.effect("removes an upload the device gives up", () =>
    Effect.gen(function* () {
      const token = yield* pairedToken;
      const upload = yield* startedRecording(token, "gone.zip", 100);

      const cancelled = yield* HttpClientRequest.delete(recordingOf(upload.id)).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClient.execute,
      );

      assert.strictEqual(cancelled.status, 204);
      assert.strictEqual((yield* recordingStatus(token, upload.id)).status, 404);
      assert.strictEqual((yield* recordingPiece(token, upload.id, 0, zipOf(100))).status, 404);
    }),
  );

  it.effect("refuses a recording the disk has no room for, as it begins and as it goes on", () =>
    Effect.gen(function* () {
      const disk = yield* TestDisk.TestDiskSpace;
      const token = yield* pairedToken;
      const bytes = zipOf(1000);
      // Room for the upload and the bot's copy of it, with the reserve kept free.
      const needed = 2 * bytes.length + RecordingUploads.SPACE_RESERVE;

      yield* disk.set(Option.some(needed - 1));
      const refused = yield* beginRecording(token, "full.zip", bytes.length);
      assert.strictEqual(refused.status, 507);
      assert.strictEqual(
        (yield* HttpClientResponse.schemaBodyJson(Conflict)(refused)).reason,
        "no-space",
      );

      yield* disk.set(Option.some(needed));
      const upload = yield* startedRecording(token, "full.zip", bytes.length);
      yield* disk.set(Option.some(RecordingUploads.SPACE_RESERVE));
      assert.strictEqual((yield* recordingPiece(token, upload.id, 0, bytes)).status, 507);
      const standing = yield* recordingStatus(token, upload.id).pipe(Effect.flatMap(asRecording));
      assert.strictEqual(standing.received, 0);

      // A disk whose free space cannot be read is not refused.
      yield* disk.set(Option.none());
      const stored = yield* recordingPiece(token, upload.id, 0, bytes).pipe(
        Effect.flatMap(asRecording),
      );
      assert.isDefined(stored.attachment);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* (yield* TestDisk.TestDiskSpace).set(Option.some(1024 ** 4));
        }),
      ),
    ),
  );
});

/**
 * Uploads over the store and the disk alone: a day passes for them without
 * every loop of the whole server running through it.
 */
const uploadsAlone = RecordingUploads.layer.pipe(
  Layer.provideMerge(Attachments.layer),
  Layer.provideMerge(Layer.mergeAll(Ids.layer, Layout.layer)),
  Layer.provideMerge(Layer.mergeAll(TestDatabase.layer, TestDisk.layer)),
);

it.layer(uploadsAlone)("recording uploads left alone", (it) => {
  it.effect("forgets an upload untouched for a day, and removes what arrived of it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* Layout.Layout;
      const uploads = yield* RecordingUploads.RecordingUploads;
      const upload = yield* uploads.begin({ name: "left.zip", size: 1000 });
      yield* uploads.append({
        id: upload.id,
        offset: 0,
        bytes: Stream.make(zipOf(1000).subarray(0, 300)),
      });
      const files = fs
        .readDirectory(path.join(layout.attachments, "uploads"))
        .pipe(Effect.map((names) => names.filter((name) => name.startsWith(upload.id))));
      assert.lengthOf(yield* files, 2);

      yield* TestClock.adjust("23 hours");
      assert.strictEqual((yield* uploads.status(upload.id)).received, 300);
      yield* TestClock.adjust("2 hours");

      const gone = yield* uploads.status(upload.id).pipe(Effect.flip);
      assert.strictEqual(gone._tag, "NotFound");
      assert.deepStrictEqual(yield* files, []);
    }),
  );
});
