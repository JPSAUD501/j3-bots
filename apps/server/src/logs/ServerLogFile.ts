// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";

// The server's log, kept in its home as well as written to the console
// (docs/operations/operating.md, "Logs"). A service writes the console to the
// journal, and the desktop app to a file of its own, but a diagnostics zip
// needs the last days of it wherever the server runs, and without asking the
// journal: so the server keeps its own copy, the same JSON lines, in
// `<J3_HOME>/logs/server.log`, moved aside to `server.log.1` and on as it
// grows, at most `KEPT_FILES` files of `MAX_FILE_BYTES` each.

/** The log's file in the logs folder; older ones carry `.1`, `.2`, … after it. */
export const SERVER_LOG = "server.log";

/** The size at which the file is moved aside and a new one begun. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** How many files are kept, the current one included: at most 20 MiB of log. */
export const KEPT_FILES = 5;

/** How long lines wait to be written together: the log is never more than this behind. */
const WRITE_WINDOW = "1 second";

/** The log's file in `folder` that is `index` moves old: `server.log`, then `server.log.1`, … */
const fileAt = (path: Path.Path, folder: string, index: number) =>
  path.join(folder, index === 0 ? SERVER_LOG : `${SERVER_LOG}.${index}`);

/** The log's files in `folder`, newest first: `server.log`, `server.log.1`, … */
export const logFiles = (path: Path.Path, folder: string): ReadonlyArray<string> =>
  Array.from({ length: KEPT_FILES }, (_, index) => fileAt(path, folder, index));

/**
 * Appends `lines` to the log in `folder`, first moving the files aside when
 * the current one would pass `MAX_FILE_BYTES`, the oldest dropped. Lines are
 * never split between two files. A batch larger than a file on its own is
 * still written whole, to a new file.
 */
export const appendLines = Effect.fnUntraced(function* (
  folder: string,
  lines: ReadonlyArray<string>,
) {
  if (lines.length === 0) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = fileAt(path, folder, 0);
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
  const size = yield* fs.stat(current).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
  if (size > 0 && size + bytes.length > MAX_FILE_BYTES) {
    yield* fs.remove(fileAt(path, folder, KEPT_FILES - 1), { force: true });
    for (let index = KEPT_FILES - 2; index >= 0; index--) {
      const from = fileAt(path, folder, index);
      if (yield* fs.exists(from)) yield* fs.rename(from, fileAt(path, folder, index + 1));
    }
  }
  yield* fs.writeFile(current, bytes, { flag: "a", mode: 0o600 });
});

/**
 * Adds the file to the loggers already in place, for everything built with
 * this layer: the server's console log goes on as it was. A write that fails
 * is dropped: the log never stops the server.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { home } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const folder = path.join(home, HOME_ENTRIES.logs);
    const file = Logger.batched(Logger.formatJson, {
      window: WRITE_WINDOW,
      flush: (lines) => appendLines(folder, lines).pipe(Effect.provide(context), Effect.ignore),
    });
    return Logger.layer([file], { mergeWithExisting: true });
  }),
);
