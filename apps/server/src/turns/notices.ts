// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, EntryId, type Notice } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";
import type { Entries } from "../entries/Entries.ts";
import { liveTarget } from "./liveTarget.ts";
import type { Audience, DispatchRowId } from "./model.ts";

/**
 * What a retryable notice's retry sends again: the operator wakes of
 * `dispatchId`, or the bot's opening it carried, because its delivery failed
 * (`undelivered`), which a late delivery makes moot, or because the turn that
 * ran failed or delivered nothing (`turn`).
 */
export interface NoticeRetry {
  readonly dispatchId: DispatchRowId;
  readonly reason: "undelivered" | "turn";
}

/**
 * Whether the operator has written in the conversation of `botId`, a bot id or
 * a column holding one. A bot's opening is then never offered again: there is
 * no conversation left to open, and its envelope says the operator has not
 * written.
 */
export const operatorWroteSql = (
  sql: SqlClient.SqlClient,
  botId: BotId | Statement.Fragment,
) => sql`
  EXISTS (
    SELECT 1 FROM entries ow_entry
    WHERE ow_entry.conversation_bot_id = ${botId} AND ow_entry.kind = 'message'
      AND ow_entry.author_kind = 'operator'
  )
`;

/** Notices, in the caller's transaction. */
export const notices = (sql: SqlClient.SqlClient, entries: Entries["Service"]) => {
  const targetOf = liveTarget(sql);

  /** Whether the dispatch carried the bot's opening, and the operator has written since. */
  const openingOvertaken = Effect.fn("notices.openingOvertaken")(function* (
    dispatchId: DispatchRowId,
  ) {
    const rows = yield* sql`
      SELECT 1 FROM wakes w
      WHERE w.dispatch_id = ${dispatchId} AND json_extract(w.payload_json, '$._tag') = 'first-run'
        AND ${operatorWroteSql(sql, sql.literal("w.bot_id"))}
    `;
    return rows.length > 0;
  }, Effect.orDie);

  /**
   * Shows a notice where the audience's speech goes. Without `retry`, or for
   * an opening the operator has overtaken, it is not retryable.
   */
  const notify = Effect.fn("notices.notify")(function* (
    botId: BotId,
    audience: Audience,
    notice: Notice,
    retry: NoticeRetry | null,
  ) {
    const target = yield* targetOf(botId, audience);
    if (target === null) return;
    const retryable = retry !== null && !(yield* openingOvertaken(retry.dispatchId));
    const entry = yield* entries.append({
      target,
      entry: { _tag: "notice", author: { _tag: "system" }, notice, retryable },
    });
    if (retry !== null) {
      yield* sql`
        INSERT INTO notice_retries (entry_id, dispatch_id, reason)
        VALUES (${entry.id}, ${retry.dispatchId}, ${retry.reason})
      `;
    }
  }, Effect.orDie);

  /**
   * The operator wrote to the bot: the notices that offer its opening again
   * offer it no more, and clients drop their retry.
   */
  const closeOpeningRetries = Effect.fn("notices.closeOpeningRetries")(function* (botId: BotId) {
    const shown = yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ entry_id: EntryId }),
      execute: (id) => sql`
        SELECT DISTINCT n.entry_id FROM notice_retries n
        JOIN wakes w ON w.dispatch_id = n.dispatch_id
        WHERE w.bot_id = ${id} AND json_extract(w.payload_json, '$._tag') = 'first-run'
      `,
    })(botId);
    for (const row of shown) {
      const found = yield* entries.find(row.entry_id);
      if (Option.isNone(found) || found.value.entry._tag !== "notice") continue;
      const notice = found.value.entry;
      if (notice.retryable) yield* entries.update({ ...notice, retryable: false });
    }
  }, Effect.orDie);

  return { notify, openingOvertaken, closeOpeningRetries };
};
