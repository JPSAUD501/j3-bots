// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Where `location` really is, symbolic links resolved. A path that does not
 * exist yet resolves through its nearest existing parent.
 */
export const realLocation = Effect.fn("realLocation")(function* (location: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const missing: Array<string> = [];
  let current = path.resolve(location);
  while (true) {
    const real = yield* fs.realPath(current).pipe(Effect.option);
    if (Option.isSome(real)) return path.join(real.value, ...missing.reverse());
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(location);
    missing.push(path.basename(current));
    current = parent;
  }
});

/** Whether `inner` is `outer` or inside it. Both absolute and normalized. */
export const isWithin = (outer: string, inner: string) =>
  inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
