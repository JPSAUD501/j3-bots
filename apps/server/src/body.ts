// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

// Bodies are read here, against a limit each route or call sets, so nothing
// buffers more than it can use, declared or chunked: a request's, and an
// answer the server reads from a remote server.

/** A body over its limit, refused before the rest of it is read. */
class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {}) {}

/** The length a message declares, if it declares a valid one. */
const declaredLength = <E>(message: HttpIncomingMessage.HttpIncomingMessage<E>) => {
  const header = message.headers["content-length"];
  return header !== undefined && /^\d+$/.test(header) ? Number(header) : undefined;
};

/**
 * The message's body, refused as soon as it declares or reaches more than
 * `limit` bytes: a declared length is refused before anything is read, and a
 * chunked body as the chunk that passes the limit arrives.
 */
export const readBody = <E>(message: HttpIncomingMessage.HttpIncomingMessage<E>, limit: number) => {
  const declared = declaredLength(message);
  if (declared !== undefined && declared > limit) return Effect.fail(new BodyTooLarge());
  return message.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: new Array<Uint8Array>(), size: 0 }),
      (read, chunk) => {
        const size = read.size + chunk.length;
        if (size > limit) return Effect.fail(new BodyTooLarge());
        read.chunks.push(chunk);
        return Effect.succeed({ chunks: read.chunks, size });
      },
    ),
    Effect.map(({ chunks, size }) => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }),
  );
};

/** The message's body as text, within `limit` bytes. */
export const readText = <E>(message: HttpIncomingMessage.HttpIncomingMessage<E>, limit: number) =>
  readBody(message, limit).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));
