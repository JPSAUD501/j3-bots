// SPDX-License-Identifier: AGPL-3.0-or-later
import { readDocument } from "@j3-bots/client-runtime/documents";
import { ReadRequest } from "./readRequest";

/**
 * Reads one document, off the page's thread, so a file that takes long to
 * read keeps nothing else waiting. Only the app's readers run here, never
 * anything of the file. The page ends the worker once it has the answer, or
 * when it takes too long, which also frees all it held.
 */
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = ReadRequest.decode(event.data);
  const read =
    request === null
      ? { _tag: "unreadable" }
      : readDocument(request.kind, request.bytes, request.locale);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker answers only the page that made it, and takes no target
  self.postMessage(read);
});
