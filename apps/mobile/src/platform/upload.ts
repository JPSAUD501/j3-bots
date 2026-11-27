// SPDX-License-Identifier: AGPL-3.0-or-later
import { TransferFailed, type UploadRequest, type UploadResponse } from "@j3-bots/client-runtime";
import * as Effect from "effect/Effect";

/**
 * Uploads through `fetch`, refusing any redirect as every other request of
 * the client does: a redirect would send the file and the device's token to
 * an address the operator never paired with. React Native's `XMLHttpRequest`
 * and Expo's upload task follow redirects with no way to refuse them, so the
 * phone gives up byte progress for this: `onProgress` is never called.
 */
export const makeUploader =
  (fetch: typeof globalThis.fetch) =>
  (request: UploadRequest): Effect.Effect<UploadResponse, TransferFailed> =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "error",
          signal,
        });
        return { url: response.url, status: response.status, body: await response.text() };
      },
      catch: () => new TransferFailed(),
    });
