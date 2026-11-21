// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Listing and opening without following links has no Effect API.
import * as NodeFs from "node:fs/promises";
import * as Effect from "effect/Effect";

/** The first line of a PEM or OpenSSH private key, whatever its algorithm and whether or not encrypted. */
const PRIVATE_KEY_HEADER = /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
/** Enough of a file to hold the longest such line. */
const KEY_HEADER_BYTES = 64;

/**
 * Opened for reading without following a link, and without waiting: a pipe
 * opened this way does not block until a writer comes.
 */
const OPEN_FLAGS =
  NodeFs.constants.O_RDONLY | NodeFs.constants.O_NOFOLLOW | NodeFs.constants.O_NONBLOCK;

/** Up to the first `KEY_HEADER_BYTES` of `file`, if it is a regular file that is not a link. */
const headOf = Effect.fn("sshKeys.headOf")(function* (file: string) {
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => NodeFs.open(file, OPEN_FLAGS), catch: () => "unopened" }),
    (handle) =>
      Effect.tryPromise({
        try: async () => {
          // Checked on what was opened, so a file swapped after the listing is not read.
          if (!(await handle.stat()).isFile()) return "";
          const bytes = new Uint8Array(KEY_HEADER_BYTES);
          const { bytesRead } = await handle.read(bytes, 0, KEY_HEADER_BYTES, 0);
          return new TextDecoder().decode(bytes.subarray(0, bytesRead));
        },
        catch: () => "unreadable",
      }),
    (handle) =>
      Effect.tryPromise({ try: () => handle.close(), catch: () => "unclosed" }).pipe(Effect.ignore),
  ).pipe(Effect.orElseSucceed(() => ""));
});

/**
 * The files directly in `folder` that hold a private key, told by their first
 * line, by path. Only regular files are opened, and of each, up to its first
 * 64 bytes are read. No symbolic link is followed: neither one in `folder`
 * nor `folder` itself when it is one, which then counts as holding none.
 */
export const privateKeysIn = Effect.fn("sshKeys.privateKeysIn")(function* (folder: string) {
  const listed = yield* Effect.tryPromise({
    try: async () =>
      (await NodeFs.lstat(folder)).isDirectory()
        ? await NodeFs.readdir(folder, { withFileTypes: true })
        : [],
    catch: () => "unlisted",
  }).pipe(Effect.orElseSucceed(() => []));
  const keys: Array<string> = [];
  for (const entry of listed
    .filter((each) => each.isFile())
    .map((each) => each.name)
    .toSorted()) {
    const file = `${folder}/${entry}`;
    if (PRIVATE_KEY_HEADER.test(yield* headOf(file))) keys.push(file);
  }
  return keys;
});
