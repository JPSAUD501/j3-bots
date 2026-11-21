// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Result from "effect/Result";

// What `electronFetch` makes of an answer, apart from Electron.

/** The most an answer's body may hold: a server check reads a few hundred bytes. */
export const BODY_LIMIT = 64 * 1024;

/**
 * The `Response` for an answer with `status`: the body only for a 200, and no
 * headers, which the server check does not read. A failure for anything
 * `Response` refuses, such as a status outside 200–599.
 */
export const responseOf = (
  status: number,
  body: Uint8Array<ArrayBuffer> | null,
): Result.Result<Response, unknown> =>
  Result.try(
    () =>
      new Response(status === 200 && body !== null && body.length > 0 ? body : null, { status }),
  );

/** Collects a body's chunks, up to `limit` bytes. */
export const bodyCollector = (limit: number) => {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  return {
    /** Adds `chunk`; `false` once the body is over the limit. */
    add: (chunk: Uint8Array): boolean => {
      size += chunk.length;
      if (size > limit) return false;
      chunks.push(chunk);
      return true;
    },
    bytes: (): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.concat(chunks)),
  };
};
