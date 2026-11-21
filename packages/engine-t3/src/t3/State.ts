// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Path from "effect/Path";
import { engineFolders } from "./PrivateFiles.ts";

// What an update of J3 Bots copies of the engine's own state before it starts
// a release pinned to another engine, and puts back if that release never
// becomes ready. The engine's migrations go forward only: once a newer engine
// has opened its database, an older one refuses it (docs/architecture/engine.md).

/** The engine's database, in its `userdata` folder (**Read** at `db51b67`: `apps/server/src/config.ts:146-151`). */
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
