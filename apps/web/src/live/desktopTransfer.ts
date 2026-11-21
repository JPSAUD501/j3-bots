// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  FileTransfer,
  TransferFailed,
  type UploadRequest,
  type UploadResponse,
} from "@j3-bots/client-runtime";
import * as Effect from "effect/Effect";
import type { Desktop } from "./desktop";

/**
 * Uploads through the desktop app's main process, which streams the file to
 * the server and reports the bytes sent as they go. Interrupting the upload
 * aborts it there.
 */
export const desktopTransfer = (upload: Desktop["upload"]) =>
  FileTransfer.of({
    upload: Effect.fn("FileTransfer.upload")((request: UploadRequest) =>
      Effect.callback<UploadResponse, TransferFailed>((resume) => {
        const handle = upload(
          { url: request.url, headers: request.headers },
          request.body,
          request.onProgress,
        );
        void handle.done.then((answer) =>
          resume(
            answer === null
              ? Effect.fail(new TransferFailed())
              : Effect.succeed({ url: answer.url, status: answer.status, body: answer.body }),
          ),
        );
        return Effect.sync(handle.abort);
      }),
    ),
  });
