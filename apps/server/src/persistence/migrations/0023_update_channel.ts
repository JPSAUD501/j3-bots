// SPDX-License-Identifier: AGPL-3.0-or-later
import { channelOf } from "@j3-bots/release";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import packageJson from "../../../package.json" with { type: "json" };

// Which releases the server is offered: `stable` or `nightly`
// (`releases/ReleaseFeed.ts`). The channel starts as the one of the release
// that first runs this, so a home installed from a nightly build follows
// nightly builds, and one installed or updated from a stable release, or a
// release candidate, follows stable releases. Like any migration, it makes the
// release before refuse the database; going back to it restores the snapshot
// the update took (`j3-bots update --rollback`).

/** The migration as `running`, the version of the release that runs it, makes it. */
export const updateChannelMigration = Effect.fn("updateChannelMigration")(function* (
  running: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable'
      CHECK (update_channel IN ('stable', 'nightly'))
  `;
  if (Option.getOrNull(channelOf(running)) === "nightly") {
    yield* sql`UPDATE settings SET update_channel = 'nightly'`;
  }
});

export default updateChannelMigration(packageJson.version);
