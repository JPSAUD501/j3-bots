// SPDX-License-Identifier: AGPL-3.0-or-later
import { UPLOAD_TAGS, type UploadHandle } from "@j3-bots/desktop-bridge/channels";

// The preload script's side of an upload. It runs sandboxed, with no Node.js
// and nothing but the bridge's names: it passes values through as they are,
// and the page decodes the outcome.

/** How much of a file goes in one message to the main process. */
const CHUNK = 256 * 1024;

const FAILED = { _tag: UPLOAD_TAGS.failed };

/**
 * Uploads through the main process: `post` hands it the upload's start and
 * the port the upload's messages travel on. The body goes a chunk each time
 * the main process asks for one, so no more than a chunk of it is in flight.
 * The outcome settles once: with what the main process answers, or `failed`
 * when the upload is aborted, its port closes first, or a message on it
 * cannot be read.
 */
export const makeUpload =
  (
    post: (start: { readonly request: unknown; readonly size: number }, port: MessagePort) => void,
  ) =>
  (request: unknown, body: Blob, onProgress: (sent: unknown) => void): UploadHandle => {
    if (!(body instanceof Blob)) {
      return { done: Promise.resolve(FAILED), abort: () => undefined };
    }
    const { port1: port, port2 } = new MessageChannel();
    const { promise: done, resolve } = Promise.withResolvers<unknown>();
    let settled = false;
    const settle = (outcome: unknown) => {
      if (settled) return;
      settled = true;
      port.close();
      resolve(outcome);
    };
    let offset = 0;
    port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (settled) return;
      if (typeof data !== "object" || data === null) return settle(data);
      const tag: unknown = Reflect.get(data, "_tag");
      if (tag === UPLOAD_TAGS.progress) {
        const sent: unknown = Reflect.get(data, "sent");
        return onProgress(sent);
      }
      if (tag !== UPLOAD_TAGS.pull) return settle(data);
      const start = offset;
      offset = Math.min(body.size, start + CHUNK);
      if (start >= body.size) return port.postMessage({ _tag: UPLOAD_TAGS.end });
      body
        .slice(start, offset)
        .arrayBuffer()
        .then(
          (bytes) => {
            if (!settled) {
              port.postMessage({ _tag: UPLOAD_TAGS.chunk, bytes: new Uint8Array(bytes) });
            }
          },
          () => settle(FAILED),
        );
    };
    port.onmessageerror = () => settle(FAILED);
    port.addEventListener("close", () => settle(FAILED));
    post({ request, size: body.size }, port2);
    return { done, abort: () => settle(FAILED) };
  };
