// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { checkOwnFolder } from "./layout.ts";

/** A folder of this user's in a new folder `shared`, given `mode`, in a temporary folder. */
const within = (mode: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const shared = path.join(yield* fs.realPath(yield* fs.makeTempDirectoryScoped()), "shared");
    yield* fs.makeDirectory(shared);
    yield* fs.chmod(shared, mode);
    const install = path.join(shared, "j3-bots");
    yield* fs.makeDirectory(install, { mode: 0o755 });
    return { shared, install };
  });

/** What `checkOwnFolder` found wrong with `folder`, if anything. */
const exposed = (folder: string) =>
  checkOwnFolder(folder).pipe(
    Effect.exit,
    Effect.map((exit) => {
      const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
      return Option.map(error, (found) =>
        found._tag === "InstallFolderExposed"
          ? { folder: found.folder, reason: found.reason, holds: found.holds }
          : { folder: found._tag, reason: "other", holds: undefined },
      );
    }),
  );

it.layer(NodeServices.layer)("an install's folder", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "is refused in a folder another account may write to, as a link into one is",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, install } = yield* within(0o777);
        assert.deepStrictEqual(
          yield* exposed(install),
          Option.some({ folder: shared, reason: "writable-by-all", holds: install }),
        );

        const link = path.join(yield* fs.makeTempDirectoryScoped(), "j3-bots");
        yield* fs.symlink(install, link);
        assert.deepStrictEqual(
          yield* exposed(link),
          Option.some({ folder: shared, reason: "writable-by-all", holds: link }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "is taken in a sticky folder, as /tmp is, and in one only this user's group may write",
    () =>
      Effect.gen(function* () {
        for (const mode of [0o1777, 0o775]) {
          const { install } = yield* within(mode);
          assert.isTrue(Option.isNone(yield* exposed(install)), mode.toString(8));
        }
      }).pipe(Effect.scoped),
  );
});
