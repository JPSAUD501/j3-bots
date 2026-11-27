// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  Conflict,
  type DeviceId,
  type DeviceToken,
  HTTP_PATHS,
  MAX_ATTACHMENT_SIZE,
  MAX_INLINE_IMAGE_SIZE,
  NotAuthenticated,
  RECORDING_CHUNK_SIZE,
  RecordingOffset,
  RecordingUpload,
  type RecordingUploadId,
  RecordingUploadStart,
  type WorkImageId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { backoffDelay, Connection, NotPaired, ReconnectPolicy } from "../connection/Connection.ts";
import { transferDeadline, within } from "../connection/http.ts";
import { FileTransfer, ServerAddress } from "../ports.ts";
import { waitFor } from "../Store.ts";
import type { FileProblem } from "./limits.ts";

/**
 * The file cannot be uploaded, for good: sending it again would fail again.
 * The server refused it, or, for a recording, this device could no longer
 * read it (`unreadable`).
 */
export class UploadRefused extends Schema.TaggedError<UploadRefused>()("UploadRefused", {
  problem: Schema.Literals([
    "too-large",
    "recording-too-large",
    "refused",
    "server-setup",
    "no-space",
    "unreadable",
  ]),
}) {
  override get message(): string {
    return `The file cannot be uploaded: ${this.problem}.`;
  }
}

/**
 * A screen recording to upload (decision 0098): a zip on the device, read a
 * piece at a time, so the whole file is never in memory.
 */
export interface RecordingSource {
  /** The name the bot sees the file under. */
  readonly name: string;
  /** Bytes. */
  readonly size: number;
  /**
   * The file's bytes from `start` up to `end`, not included; null, or a
   * rejection, once the device can no longer read them, which ends the
   * upload. Each piece goes as a `Blob` made of these bytes, which a
   * browser's `Blob` takes and React Native's does not.
   */
  readonly read: (start: number, end: number) => Promise<Uint8Array | null>;
}

/** The file is not on the server, or the server could not be reached for it. */
export class AttachmentUnavailable extends Schema.TaggedError<AttachmentUnavailable>()(
  "AttachmentUnavailable",
  { reason: Schema.Literals(["not-found", "unreachable", "too-large"]) },
) {
  override get message(): string {
    return `The file is unavailable: ${this.reason}.`;
  }
}

/**
 * A file's bytes, ready for the platform to show or save. Plain bytes rather
 * than a `Blob`: React Native's `Blob` cannot be made from bytes, so each
 * platform wraps them as it shows or saves them.
 */
export interface Download {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mediaType: string;
}

/** What a failed upload means for the file in the composer. */
export const uploadProblem = (error: UploadRefused | NotPaired): FileProblem =>
  error._tag === "NotPaired" ? "not-paired" : error.problem;

/** A failure the next attempt may not meet: the network, or the server for a moment. */
class Transient extends Schema.TaggedError<Transient>()("Transient", {}) {}

const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(Attachment));
const decodeRecording = Schema.decodeUnknownEffect(Schema.fromJsonString(RecordingUpload));
const decodeOffset = Schema.decodeOption(Schema.fromJsonString(RecordingOffset));
const decodeConflict = Schema.decodeOption(Schema.fromJsonString(Conflict));
const encodeStart = Schema.encodeEffect(Schema.fromJsonString(RecordingUploadStart));
const isNotAuthenticated = (body: string) =>
  Option.isSome(Schema.decodeOption(Schema.fromJsonString(NotAuthenticated))(body));

/**
 * File bytes over HTTP, with the device token as a bearer. A transfer belongs
 * to the pairing it started under: it carries that pairing's token, read
 * once, and ends with `NotPaired` as soon as this window follows another
 * pairing or none. An upload waits for the server and tries again after a
 * network failure, or after it took longer than its size allows, so a file
 * the operator attached while offline goes as soon as the server answers. A
 * download gets the same time for its size, and then counts as unreachable.
 *
 * As for the socket ticket, only the server's own answer counts: a 401
 * means the device is not paired only when its body is the server's
 * `NotAuthenticated`, and an answer from another address, as from a proxy
 * that redirected the request to its own login page, did not come from the
 * server. Either is a failure the next attempt may not meet.
 */
export class Files extends Context.Service<
  Files,
  {
    /**
     * Uploads `body` as a file named `name` for `pairing`, reporting the
     * bytes sent so far. `mediaType` must be normalized (see `normalizeMediaType`).
     */
    readonly upload: (input: {
      readonly pairing: DeviceId;
      readonly name: string;
      readonly mediaType: string;
      readonly body: Blob;
      readonly onProgress: (sent: number) => void;
    }) => Effect.Effect<Attachment, UploadRefused | NotPaired>;
    /**
     * Uploads a screen recording for `pairing` in pieces of
     * `RECORDING_CHUNK_SIZE`, reporting the bytes the server holds so far. A
     * piece that fails is sent again from where the server stands, and an
     * upload the server no longer knows starts over. Only a server that
     * carries `screenRecordings` takes one. An upload that fails or is
     * interrupted is removed from the server, as far as it can be reached.
     */
    readonly uploadRecording: (
      input: RecordingSource & {
        readonly pairing: DeviceId;
        readonly onProgress: (received: number) => void;
      },
    ) => Effect.Effect<Attachment, UploadRefused | NotPaired>;
    readonly download: (
      attachment: Attachment,
    ) => Effect.Effect<Download, AttachmentUnavailable | NotPaired>;
    /**
     * The image a step of a bot's work looked at (`WorkStep.image`), as the
     * server reads it now: `not-found` once the file is gone or is no longer
     * an image it shows.
     */
    readonly workImage: (
      id: WorkImageId,
    ) => Effect.Effect<Download, AttachmentUnavailable | NotPaired>;
  }
>()("@j3-bots/client-runtime/files/Files") {}

export const layer = Layer.effect(
  Files,
  Effect.gen(function* () {
    const { origin } = yield* ServerAddress;
    const connection = yield* Connection;
    const transfer = yield* FileTransfer;
    const http = yield* HttpClient.HttpClient;
    const policy = yield* ReconnectPolicy;
    const scope = yield* Scope.Scope;
    /** Whether `url`, where an answer came from, is `path` on the server. */
    const fromServer = (url: string, path: string) => {
      const answered = new URL(url, origin);
      return answered.origin === origin.origin && answered.pathname === path;
    };

    /** Fails with `NotPaired` once this window follows another pairing than `pairing`, or none. */
    const ended = (pairing: DeviceId) =>
      waitFor(connection.pairing, (current) => current !== pairing).pipe(
        Effect.andThen(Effect.fail(new NotPaired())),
      );

    const uploadOnce = Effect.fnUntraced(function* (input: {
      readonly token: Redacted.Redacted<DeviceToken>;
      readonly name: string;
      readonly mediaType: string;
      readonly body: Blob;
      readonly onProgress: (sent: number) => void;
    }) {
      yield* connection.awaitConnected;
      const url = new URL(HTTP_PATHS.attachments, origin);
      url.searchParams.set("name", input.name);
      const response = yield* transfer
        .upload({
          method: "POST",
          url: url.toString(),
          headers: {
            authorization: `Bearer ${Redacted.value(input.token)}`,
            "content-type": input.mediaType,
          },
          body: input.body,
          onProgress: input.onProgress,
        })
        .pipe(
          Effect.mapError(() => new Transient()),
          within(transferDeadline(input.body.size, policy.requestTimeout), () => new Transient()),
        );
      if (!fromServer(response.url, HTTP_PATHS.attachments)) return yield* new Transient();
      switch (response.status) {
        case 200:
          return yield* decodeAttachment(response.body).pipe(
            Effect.mapError(() => new UploadRefused({ problem: "refused" })),
          );
        case 400:
          return yield* new UploadRefused({ problem: "refused" });
        // `Conflict("private-location")`: the server's attachments folder is
        // linked out of its private data, and stays refused until the
        // operator removes the link.
        case 409:
          return yield* new UploadRefused({ problem: "server-setup" });
        case 401:
          return yield* isNotAuthenticated(response.body) ? new NotPaired() : new Transient();
        case 413:
          return yield* new UploadRefused({ problem: "too-large" });
        default:
          return yield* new Transient();
      }
    });

    const upload = Effect.fn("Files.upload")(function* (input: {
      readonly pairing: DeviceId;
      readonly name: string;
      readonly mediaType: string;
      readonly body: Blob;
      readonly onProgress: (sent: number) => void;
    }) {
      const name = input.name.trim() === "" ? "file" : input.name.trim();
      const token = yield* connection.bearer(input.pairing);
      return yield* Effect.gen(function* () {
        let failures = 0;
        while (true) {
          const result = yield* uploadOnce({ ...input, token, name }).pipe(
            Effect.map((attachment) => ({ _tag: "done", attachment }) as const),
            Effect.catchTag("Transient", () => Effect.succeed({ _tag: "again" } as const)),
          );
          if (result._tag === "done") return result.attachment;
          failures += 1;
          input.onProgress(0);
          yield* Effect.sleep(backoffDelay(failures, policy, yield* Random.next));
        }
      }).pipe(Effect.raceFirst(ended(input.pairing)));
    });

    /** Why the server refused a recording with 409, unless the answer is not the server's. */
    const conflictProblem = (body: string) =>
      Option.match(decodeConflict(body), {
        onNone: () => new Transient(),
        onSome: (conflict) =>
          new UploadRefused({
            problem: conflict.reason === "private-location" ? "server-setup" : "refused",
          }),
      });

    /** Begins a recording upload: the upload as the server holds it. */
    const beginRecording = Effect.fnUntraced(function* (
      token: Redacted.Redacted<DeviceToken>,
      source: RecordingSource,
    ) {
      // A size the server would not take is refused as the server would.
      const start = yield* encodeStart({ name: source.name, size: source.size }).pipe(
        Effect.mapError(() => new UploadRefused({ problem: "refused" })),
      );
      yield* connection.awaitConnected;
      const url = new URL(HTTP_PATHS.recordingUploads, origin);
      const answer = yield* http
        .execute(
          HttpClientRequest.post(url.toString()).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyText(start, "application/json"),
          ),
        )
        .pipe(
          Effect.flatMap((response) => Effect.map(response.text, (body) => ({ response, body }))),
          Effect.catchTag("HttpClientError", () => Effect.fail(new Transient())),
          within(policy.requestTimeout, () => new Transient()),
        );
      if (!fromServer(answer.response.url, url.pathname)) return yield* new Transient();
      switch (answer.response.status) {
        case 200:
          return yield* decodeRecording(answer.body).pipe(
            Effect.mapError(() => new UploadRefused({ problem: "refused" })),
          );
        case 400:
          return yield* new UploadRefused({ problem: "refused" });
        case 401:
          return yield* isNotAuthenticated(answer.body) ? new NotPaired() : new Transient();
        case 409:
          return yield* conflictProblem(answer.body);
        case 413:
          return yield* new UploadRefused({ problem: "recording-too-large" });
        case 507:
          return yield* new UploadRefused({ problem: "no-space" });
        default:
          return yield* new Transient();
      }
    });

    /**
     * Sends the recording's next piece, from where the server last said the
     * upload stands: the upload as the server holds it now, or none once the
     * server no longer knows it.
     */
    const sendPiece = Effect.fnUntraced(function* (input: {
      readonly token: Redacted.Redacted<DeviceToken>;
      readonly source: RecordingSource;
      readonly upload: RecordingUpload;
      readonly onProgress: (received: number) => void;
    }) {
      const { upload } = input;
      const end = Math.min(upload.received + RECORDING_CHUNK_SIZE, upload.size);
      const unreadable = new UploadRefused({ problem: "unreadable" });
      const bytes = yield* Effect.tryPromise({
        try: () => input.source.read(upload.received, end),
        catch: () => unreadable,
      });
      if (bytes === null || bytes.length !== end - upload.received) return yield* unreadable;
      // Copied into a buffer of its own, which a `Blob` takes.
      const body = new Blob([new Uint8Array(bytes)]);
      yield* connection.awaitConnected;
      const path = `${HTTP_PATHS.recordingUploads}/${encodeURIComponent(upload.id)}`;
      const url = new URL(path, origin);
      url.searchParams.set("offset", String(upload.received));
      const response = yield* transfer
        .upload({
          method: "PUT",
          url: url.toString(),
          headers: {
            authorization: `Bearer ${Redacted.value(input.token)}`,
            "content-type": "application/octet-stream",
          },
          body,
          onProgress: (sent) => input.onProgress(upload.received + sent),
        })
        .pipe(
          Effect.mapError(() => new Transient()),
          within(transferDeadline(body.size, policy.requestTimeout), () => new Transient()),
        );
      if (!fromServer(response.url, path)) return yield* new Transient();
      switch (response.status) {
        case 200:
          return Option.some(
            yield* decodeRecording(response.body).pipe(
              Effect.mapError(() => new UploadRefused({ problem: "refused" })),
            ),
          );
        // The server removed the upload: what arrived was not the recording it began as.
        case 400:
        // A piece over what the server takes at once, which this runtime never sends.
        case 413:
          return yield* new UploadRefused({ problem: "refused" });
        case 401:
          return yield* isNotAuthenticated(response.body) ? new NotPaired() : new Transient();
        // Unknown, or left alone past its lifetime: the upload starts over.
        case 404:
          return Option.none<RecordingUpload>();
        // The server holds another amount than the piece was sent after: it goes on from there.
        case 409:
          return yield* Option.match(decodeOffset(response.body), {
            onNone: () => Effect.fail(conflictProblem(response.body)),
            onSome: ({ received }) => Effect.succeedSome({ ...upload, received }),
          });
        case 507:
          return yield* new UploadRefused({ problem: "no-space" });
        default:
          return yield* new Transient();
      }
    });

    /** Removes a recording upload from the server, as far as it can be reached. */
    const removeRecording = (token: Redacted.Redacted<DeviceToken>, id: RecordingUploadId) =>
      http
        .execute(
          HttpClientRequest.delete(
            new URL(`${HTTP_PATHS.recordingUploads}/${encodeURIComponent(id)}`, origin).toString(),
          ).pipe(HttpClientRequest.bearerToken(token)),
        )
        .pipe(Effect.timeoutOption(policy.requestTimeout), Effect.ignore);

    const uploadRecording = Effect.fn("Files.uploadRecording")(function* (
      input: RecordingSource & {
        readonly pairing: DeviceId;
        readonly onProgress: (received: number) => void;
      },
    ) {
      const name = input.name.trim() === "" ? "recording.zip" : input.name.trim();
      const source: RecordingSource = { name, size: input.size, read: input.read };
      const token = yield* connection.bearer(input.pairing);
      // Where the server last said the upload stands; none before it begins.
      let upload = Option.none<RecordingUpload>();
      const received = () =>
        Option.match(upload, { onNone: () => 0, onSome: (now) => now.received });
      return yield* Effect.gen(function* () {
        let failures = 0;
        while (true) {
          const result = yield* (
            Option.isNone(upload)
              ? beginRecording(token, source).pipe(Effect.asSome)
              : sendPiece({ token, source, upload: upload.value, onProgress: input.onProgress })
          ).pipe(
            Effect.map((next) => ({ _tag: "answered", next }) as const),
            Effect.catchTag("Transient", () => Effect.succeed({ _tag: "again" } as const)),
          );
          if (result._tag === "answered") {
            upload = result.next;
            const attachment = Option.getOrUndefined(upload)?.attachment;
            if (attachment !== undefined) return attachment;
            failures = 0;
            input.onProgress(received());
            continue;
          }
          failures += 1;
          input.onProgress(received());
          yield* Effect.sleep(backoffDelay(failures, policy, yield* Random.next));
        }
      }).pipe(
        Effect.raceFirst(ended(input.pairing)),
        // What arrived of it is of no use: the server need not keep it for a day.
        Effect.onError(() =>
          Option.match(upload, {
            onNone: () => Effect.void,
            onSome: ({ id }) =>
              removeRecording(token, id).pipe(Effect.forkIn(scope), Effect.asVoid),
          }),
        ),
      );
    });

    /** The bytes at `path` on the server, given the time `size` bytes take to arrive. */
    const get = Effect.fnUntraced(function* (path: string, size: number) {
      const pairing = connection.pairing.get();
      if (pairing === null) return yield* new NotPaired();
      const token = yield* connection.bearer(pairing);
      const unreachable = new AttachmentUnavailable({ reason: "unreachable" });
      const url = new URL(path, origin);
      // The deadline runs until the last byte is read, not only to the headers.
      return yield* Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.bearerToken(token)),
        );
        if (!fromServer(response.url, url.pathname)) return yield* unreachable;
        switch (response.status) {
          case 200: {
            const bytes = new Uint8Array(yield* response.arrayBuffer);
            const mediaType = response.headers["content-type"] ?? "application/octet-stream";
            return { bytes, mediaType };
          }
          case 401:
            return yield* isNotAuthenticated(yield* response.text) ? new NotPaired() : unreachable;
          case 404:
            return yield* new AttachmentUnavailable({ reason: "not-found" });
          default:
            return yield* unreachable;
        }
      }).pipe(
        Effect.catchTag("HttpClientError", () => Effect.fail(unreachable)),
        within(transferDeadline(size, policy.requestTimeout), () => unreachable),
        Effect.raceFirst(ended(pairing)),
      );
    });

    const download = Effect.fn("Files.download")(function* (attachment: Attachment) {
      // A download is held in memory whole, which a screen recording, the one
      // file past every other file's limit, would not fit.
      if (attachment.size > MAX_ATTACHMENT_SIZE)
        return yield* new AttachmentUnavailable({ reason: "too-large" });
      return yield* get(
        `${HTTP_PATHS.attachments}/${encodeURIComponent(attachment.id)}`,
        attachment.size,
      );
    });

    // Its size is known only as it arrives: it is given the time the largest takes.
    const workImage = Effect.fn("Files.workImage")(function* (id: WorkImageId) {
      return yield* get(
        `${HTTP_PATHS.workImages}/${encodeURIComponent(id)}`,
        MAX_INLINE_IMAGE_SIZE,
      );
    });

    return Files.of({ upload, uploadRecording, download, workImage });
  }),
);
