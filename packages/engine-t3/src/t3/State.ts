// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Path from "effect/Path";
import { engineFolders } from "./PrivateFiles.ts";

// What an update of J3 Bots copies of the engine's own state before it starts
// a release pinned to another engine, and puts back if that release never
// becomes ready. The engine's migrations go forward only, and an older engine
// starts on a database a newer one migrated all the same, then fails on what
// it cannot read (docs/architecture/engine.md, "Upgrading the engine"). So the
// state an older engine runs on is always the copy from before the update.

/** The engine's database, in its `userdata` folder (**Read** at `bc0f04d`: `apps/server/src/config.ts:150-154`). */
const DATABASE = "statev2.sqlite";

/**
 * The engine's files an update copies, for an engine data directory at
 * `home`: its database, with the write-ahead log and its index beside it in
 * WAL mode, and its settings, which name the providers J3 Bots provisioned.
 * A file that does not exist is not copied.
 */
export const stateFiles = (path: Path.Path, home: string): ReadonlyArray<string> => {
  const { userdata } = engineFolders(path, home);
  return [
    ...["", "-wal", "-shm"].map((suffix) => path.join(userdata, `${DATABASE}${suffix}`)),
    path.join(userdata, "settings.json"),
  ];
};
