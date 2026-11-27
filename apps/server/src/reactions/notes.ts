// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, EntryId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Ids } from "../Ids.ts";
import { json, timeText } from "../persistence/columns.ts";
import { CatchUpNote } from "../turns/model.ts";

const encodeNote = Schema.encodeEffect(json(CatchUpNote));

/**
 * A bot's waiting note that reactions on a message changed
 * (`docs/architecture/server.md`, Reactions): its next envelope in its main
 * session tells them as they stand then. One per bot and message while it
 * waits, so a burst of changes is told once.
 */
export const reactionNotes = (sql: SqlClient.SqlClient, ids: Ids["Service"]) => {
  const waiting = (botId: BotId, entryId: EntryId) => sql`
    bot_id = ${botId} AND consumed_dispatch_id IS NULL
    AND json_extract(note_json, '$._tag') = 'reactions'
    AND json_extract(note_json, '$.entryId') = ${entryId}
  `;

  /** Leaves a note for the bot, in the caller's transaction, unless one waits already. */
  const leave = Effect.fn("reactionNotes.leave")(function* (botId: BotId, entryId: EntryId) {
    const note = yield* encodeNote({ _tag: "reactions", entryId });
    yield* sql`
      INSERT INTO catch_up_notes (id, bot_id, text, created_at, note_json)
      SELECT ${yield* ids.make("note")}, ${botId}, ${"Reactions on a message changed."},
        ${timeText(yield* DateTime.now)}, ${note}
      WHERE NOT EXISTS (SELECT 1 FROM catch_up_notes WHERE ${waiting(botId, entryId)})
    `;
  }, Effect.orDie);

  /** Takes back the note waiting for the bot, which a wake about the same message tells instead. */
  const takeBack = Effect.fn("reactionNotes.takeBack")(function* (botId: BotId, entryId: EntryId) {
    yield* sql`DELETE FROM catch_up_notes WHERE ${waiting(botId, entryId)}`;
  }, Effect.orDie);

  return { leave, takeBack };
};
