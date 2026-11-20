// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { isWithin } from "../paths.ts";

/** The file a built client's folder must hold, and what a route of the app gets. */
export const INDEX = "index.html";

/**
 * Where `location` really is, links resolved, if that is a regular file
 * inside the folder whose real path is `realRoot`. The one check of what the
 * client's folder may serve.
 */
export const containedFile = Effect.fn("WebClient.containedFile")(function* (
  realRoot: string,
  location: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(location).pipe(Effect.option);
  if (Option.isNone(real) || !isWithin(realRoot, real.value)) return Option.none<string>();
  const info = yield* fs.stat(real.value).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File" ? real : Option.none<string>();
});

/**
 * Whether `directory` holds a built client the server would serve: an
 * `index.html` that is a regular file inside it, links resolved. A folder
 * there, or a link out of the folder, is not a build.
 */
export const isBuilt = Effect.fn("WebClient.isBuilt")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realRoot = yield* fs.realPath(directory).pipe(Effect.option);
  if (Option.isNone(realRoot)) return false;
  return Option.isSome(yield* containedFile(realRoot.value, path.join(directory, INDEX)));
});
