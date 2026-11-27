// SPDX-License-Identifier: AGPL-3.0-or-later
import { isNewer } from "@j3-bots/release";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { timeText } from "../persistence/columns.ts";

// Which engine release may start on this home's engine data
// (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md). The
// engine migrates its own data forward when a newer release first starts on
// it, and an older release starts on that data all the same, then fails on
// what it cannot read (docs/architecture/engine.md, "Upgrading the engine").
// So the database records the newest release that ran, in the same snapshot
// as the engine's data, and the server starts no older one.

/** The home's engine data was last run by a newer engine than this release of J3 Bots runs. */
export class EngineDataNewer extends Schema.TaggedError<EngineDataNewer>()("EngineDataNewer", {
  recorded: Schema.String,
  pinned: Schema.String,
}) {
  override get message(): string {
    return `The engine's data on this home was last run by engine ${this.recorded}, which may have changed it in ways engine ${this.pinned}, the one this release of J3 Bots runs, cannot read. Run a release of J3 Bots pinned to engine ${this.recorded} or later, or put back the data from before it with \`j3-bots update --rollback\``;
  }
}

const Recorded = Schema.Struct({ version: Schema.String });

/**
 * Records `pinned` as the engine release that runs on this home's engine data,
 * before it starts. Refused when the release recorded is newer. One that
 * cannot be ordered against `pinned` is not shown to be newer, and is
 * replaced.
 */
export const claimEngineRelease = Effect.fn("claimEngineRelease")(function* (pinned: string) {
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Recorded,
    execute: () => sql`SELECT version FROM engine_release WHERE id = 1`,
  })(undefined).pipe(Effect.orDie);
  if (Option.isSome(recorded) && isNewer(recorded.value.version, pinned)) {
    return yield* new EngineDataNewer({ recorded: recorded.value.version, pinned });
  }
  if (Option.isSome(recorded) && recorded.value.version === pinned) return;
  yield* sql`
    INSERT INTO engine_release (id, version, recorded_at)
    VALUES (1, ${pinned}, ${timeText(yield* DateTime.now)})
    ON CONFLICT (id) DO UPDATE SET version = excluded.version, recorded_at = excluded.recorded_at
  `.pipe(Effect.orDie);
});
