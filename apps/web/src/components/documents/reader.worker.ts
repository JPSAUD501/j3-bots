// SPDX-License-Identifier: AGPL-3.0-or-later
import { readDocument } from "@j3-bots/client-runtime/documents";
import { ReadRequest } from "./readRequest";

/**
 * Reads one document, off the page: a worker has no page, no storage of the
 * app's and no credential, and a file that takes long to read keeps nothing
 * else waiting. The page ends the worker once it has the answer, or when it
 * takes too long.
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
