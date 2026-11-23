// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Where `location` really is, symbolic links resolved. A path that does not
 * exist yet resolves through its nearest parent that does. `None` when a link
 * on the way points nowhere: creating the path would create it wherever that
 * link leads.
 */
export const realLocation = Effect.fn("realLocation")(function* (location: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const missing: Array<string> = [];
  let existing = path.resolve(location);
  // `lstat` sees a link itself, even one whose target is missing.
  while (Option.isNone(yield* fs.lstat(existing).pipe(Effect.option))) {
    const parent = path.dirname(existing);
    if (parent === existing) return Option.none<string>();
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const real = yield* fs.realPath(existing).pipe(Effect.option);
  return Option.map(real, (resolved) => path.join(resolved, ...missing));
});

/**
 * Whether `inner` is `outer` or inside it. Both absolute and normalized, as
 * `platform` writes paths: Windows separates segments with `\\` and, on its
 * file systems as they come, compares names without case, so a path that
 * differs from another only in case names the same place there.
 */
export const isWithin = (outer: string, inner: string, platform: string = process.platform) => {
  const windows = platform === "win32";
  const separator = windows ? "\\" : "/";
  const [within, without] = windows ? [inner.toLowerCase(), outer.toLowerCase()] : [inner, outer];
  return (
    within === without ||
    within.startsWith(without.endsWith(separator) ? without : `${without}${separator}`)
  );
};
