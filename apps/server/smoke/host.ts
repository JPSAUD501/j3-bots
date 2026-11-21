// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// The host a release smoke runs J3 Bots on: a stranger's, with no Node.

/** The names Node goes by on a search path. */
const NODE_COMMANDS = ["node", "nodejs"];

/** Runs `command` to its end: its exit code and everything it wrote. */
export const runToEnd = Effect.fn("smoke.runToEnd")(function* (command: ChildProcess.Command) {
  const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(command);
  const [output, exitCode] = yield* Effect.all(
    [handle.all.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
    { concurrency: 2 },
  );
  return { output, exitCode: Number(exitCode) };
}, Effect.scoped);

/**
 * A search path of one new folder, `folder`, of links to every command on this
 * PATH but Node, wherever this machine has it, so that only a release's own
 * Node can run. Each command in `replaced` is a `sh` script instead, with that
 * body. Filtering PATH's folders would not do: runners keep `node` in
 * `/usr/bin`, beside `sh` and `tar`.
 */
export const searchPathWithoutNode = Effect.fn("smoke.searchPathWithoutNode")(function* (
  folder: string,
  replaced: Readonly<Record<string, string>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(folder);
  const linked = new Set(NODE_COMMANDS);
  for (const [name, body] of Object.entries(replaced)) {
    linked.add(name);
    yield* fs.writeFileString(path.join(folder, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  for (const directory of (yield* Config.String("PATH")).split(":")) {
    if (directory === "") continue;
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const name of names) {
      if (linked.has(name)) continue;
      linked.add(name);
      yield* fs.symlink(path.join(directory, name), path.join(folder, name));
    }
  }
  return folder;
});
