// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HOME_ENTRIES } from "../home/entries.ts";

// Where `j3-bots import` works in the home it imports into (`Import.ts`):
// the archive is unpacked and made ready in `state/import/`, then, with the
// mark written, put in place of what the home held. While the mark is there,
// the home is part one, part the other, and no server starts on it.

/** Where an import unpacks the archive and readies it, inside the home. */
export const importStaging = (path: Path.Path, home: string) =>
  path.join(home, HOME_ENTRIES.state, "import");

/** The mark an import leaves while it puts the archive in place. */
export const importMark = (path: Path.Path, home: string) =>
  path.join(home, HOME_ENTRIES.state, "import-underway");

/** Whether an import into `home` began putting an archive in place and did not finish. */
export const unfinishedImport = Effect.fn("transfer.unfinishedImport")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(importMark(yield* Path.Path, home));
});
