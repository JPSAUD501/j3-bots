// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Effect's FileSystem cannot tell free space; Node's statfs can.
import * as NodeFs from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * The free space, in bytes, of the filesystem `target` is on, or would be
 * on once made: its nearest folder that exists. None when it cannot be read.
 */
export const freeSpaceAt = Effect.fn("freeSpaceAt")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let folder = path.resolve(target);
  while (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))) {
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return yield* Effect.tryPromise({
    try: () => NodeFs.statfs(folder),
    catch: () => "unreadable",
  }).pipe(
    Effect.map((stats) => Option.some(stats.bavail * stats.bsize)),
    Effect.orElseSucceed(() => Option.none<number>()),
  );
});
