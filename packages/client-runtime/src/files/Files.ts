// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  type DeviceId,
  type DeviceToken,
  HTTP_PATHS,
  NotAuthenticated,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { backoffDelay, Connection, NotPaired, ReconnectPolicy } from "../connection/Connection.ts";
import { transferDeadline, within } from "../connection/http.ts";
import { FileTransfer, ServerAddress } from "../ports.ts";
import { waitFor } from "../Store.ts";
import type { FileProblem } from "./limits.ts";

/** The server refused the file, for good: sending it again would be refused again. */
export class UploadRefused extends Schema.TaggedError<UploadRefused>()("UploadRefused", {
  problem: Schema.Literals(["too-large", "refused", "server-setup"]),
}) {
  override get message(): string {
    return `The server refused the file: ${this.problem}.`;
  }
}

/** The file is not on the server, or the server could not be reached for it. */
export class AttachmentUnavailable extends Schema.TaggedError<AttachmentUnavailable>()(
  "AttachmentUnavailable",
  { reason: Schema.Literals(["not-found", "unreachable"]) },
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
    readonly download: (
      attachment: Attachment,
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

    const download = Effect.fn("Files.download")(function* (attachment: Attachment) {
      const pairing = connection.pairing.get();
      if (pairing === null) return yield* new NotPaired();
      const token = yield* connection.bearer(pairing);
      const unreachable = new AttachmentUnavailable({ reason: "unreachable" });
      const url = new URL(`${HTTP_PATHS.attachments}/${encodeURIComponent(attachment.id)}`, origin);
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
        within(transferDeadline(attachment.size, policy.requestTimeout), () => unreachable),
        Effect.raceFirst(ended(pairing)),
      );
    });

    return Files.of({ upload, download });
  }),
);
