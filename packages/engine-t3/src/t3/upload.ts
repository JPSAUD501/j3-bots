// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { EngineIndeterminate } from "../errors.ts";

const MEBIBYTE = 1024 * 1024;
/** The longest any upload may take, whatever its size. */
const UPLOAD_TIMEOUT_MAX = Duration.minutes(2);

/**
 * Uploads a staged file's bytes to the URL the engine signed for it. The
 * engine runs on this machine, so the upload gets a command's time plus a
 * second per MiB, and never more than two minutes: one still open past that
 * is stalled, and would hold its session's gate. Any failure, that deadline
 * included, is `EngineIndeterminate`: the engine may have stored the bytes,
 * and staging is tried again with its backoff.
 */
export const upload = (
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  options: { readonly size: number; readonly commandTimeout: Duration.Duration },
): Effect.Effect<void, EngineIndeterminate> =>
  http.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.mapError(() => new EngineIndeterminate()),
    Effect.timeoutOrElse({
      duration: Duration.min(
        Duration.sum(options.commandTimeout, Duration.seconds(options.size / MEBIBYTE)),
        UPLOAD_TIMEOUT_MAX,
      ),
      orElse: () => Effect.fail(new EngineIndeterminate()),
    }),
    Effect.asVoid,
  );
