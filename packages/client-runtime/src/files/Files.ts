// SPDX-License-Identifier: AGPL-3.0-or-later
import { Attachment, type AttachmentId, HTTP_PATHS } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { backoffDelay, Connection, NotPaired, ReconnectPolicy } from "../connection/Connection.ts";
import { uploadDeadline, within } from "../connection/http.ts";
import { FileTransfer, ServerAddress } from "../ports.ts";
import type { FileProblem } from "./limits.ts";

/** The server refused the file, for good: sending it again would be refused again. */
export class UploadRefused extends Schema.TaggedError<UploadRefused>()("UploadRefused", {
  problem: Schema.Literals(["too-large", "refused"]),
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

/** A file's bytes, ready for the platform to show or save. */
export interface Download {
  readonly body: Blob;
  readonly mediaType: string;
}

/** What a failed upload means for the file in the composer. */
export const uploadProblem = (error: UploadRefused | NotPaired): FileProblem =>
  error._tag === "NotPaired" ? "not-paired" : error.problem;

/** A failure the next attempt may not meet: the network, or the server for a moment. */
class Transient extends Schema.TaggedError<Transient>()("Transient", {}) {}

const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(Attachment));

/**
 * File bytes over HTTP, with the device token as a bearer. An upload waits
 * for the server and tries again after a network failure, or after it took
 * longer than its size allows, so a file the operator attached while offline
 * goes as soon as the server answers.
 */
export class Files extends Context.Service<
  Files,
  {
    /**
     * Uploads `body` as a file named `name`, reporting the bytes sent so far.
     * `mediaType` must be normalized (see `normalizeMediaType`).
     */
    readonly upload: (input: {
      readonly name: string;
      readonly mediaType: string;
      readonly body: Blob;
      readonly onProgress: (sent: number) => void;
    }) => Effect.Effect<Attachment, UploadRefused | NotPaired>;
    readonly download: (
      id: AttachmentId,
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

    const uploadOnce = Effect.fnUntraced(function* (input: {
      readonly name: string;
      readonly mediaType: string;
      readonly body: Blob;
      readonly onProgress: (sent: number) => void;
    }) {
      yield* connection.awaitConnected;
      const token = yield* connection.bearer;
      const url = new URL(HTTP_PATHS.attachments, origin);
      url.searchParams.set("name", input.name);
      const response = yield* transfer
        .upload({
          url: url.toString(),
          headers: {
            authorization: `Bearer ${Redacted.value(token)}`,
            "content-type": input.mediaType,
          },
          body: input.body,
          onProgress: input.onProgress,
        })
        .pipe(
          Effect.mapError(() => new Transient()),
          within(uploadDeadline(input.body.size, policy.requestTimeout), () => new Transient()),
        );
      switch (response.status) {
        case 200:
          return yield* decodeAttachment(response.body).pipe(
            Effect.mapError(() => new UploadRefused({ problem: "refused" })),
          );
        case 400:
        // `Conflict("private-location")`: the server's attachments folder is
        // linked out of its private data, and stays refused until the
        // operator removes the link.
        case 409:
          return yield* new UploadRefused({ problem: "refused" });
        case 401:
          return yield* new NotPaired();
        case 413:
          return yield* new UploadRefused({ problem: "too-large" });
        default:
          return yield* new Transient();
      }
    });

    const upload = Effect.fn("Files.upload")(function* (input: {
      readonly name: string;
      readonly mediaType: string;
      readonly body: Blob;
      readonly onProgress: (sent: number) => void;
    }) {
      const name = input.name.trim() === "" ? "file" : input.name.trim();
      let failures = 0;
      while (true) {
        const result = yield* uploadOnce({ ...input, name }).pipe(
          Effect.map((attachment) => ({ _tag: "done", attachment }) as const),
          Effect.catchTag("Transient", () => Effect.succeed({ _tag: "again" } as const)),
        );
        if (result._tag === "done") return result.attachment;
        failures += 1;
        input.onProgress(0);
        yield* Effect.sleep(backoffDelay(failures, policy, yield* Random.next));
      }
    });

    const download = Effect.fn("Files.download")(function* (id: AttachmentId) {
      const token = yield* connection.bearer;
      const unreachable = new AttachmentUnavailable({ reason: "unreachable" });
      const response = yield* http
        .execute(
          HttpClientRequest.get(
            new URL(`${HTTP_PATHS.attachments}/${encodeURIComponent(id)}`, origin).toString(),
          ).pipe(HttpClientRequest.bearerToken(token)),
        )
        .pipe(Effect.mapError(() => unreachable));
      switch (response.status) {
        case 200: {
          const bytes = yield* response.arrayBuffer.pipe(Effect.mapError(() => unreachable));
          const mediaType = response.headers["content-type"] ?? "application/octet-stream";
          return { body: new Blob([bytes], { type: mediaType }), mediaType };
        }
        case 401:
          return yield* new NotPaired();
        case 404:
          return yield* new AttachmentUnavailable({ reason: "not-found" });
        default:
          return yield* unreachable;
      }
    });

    return Files.of({ upload, download });
  }),
);
