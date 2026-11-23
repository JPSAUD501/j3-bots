// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * A file system that reports the folders `apart`, and what is in them, on
 * another device, as `stat` does: through links.
 */
export const devicesApart = (fs: FileSystem.FileSystem, apart: ReadonlyArray<string>) =>
  FileSystem.FileSystem.of({
    ...fs,
    stat: (at) =>
      Effect.all([fs.stat(at), fs.realPath(at)]).pipe(
        Effect.map(([info, real]) =>
          apart.some((folder) => real === folder || real.startsWith(`${folder}/`))
            ? { ...info, dev: info.dev + 1n }
            : info,
        ),
      ),
  });
