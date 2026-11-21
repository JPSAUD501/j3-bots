// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Notice } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Entries } from "../entries/Entries.ts";
import { liveTarget } from "./liveTarget.ts";
import type { Audience, DispatchRowId } from "./model.ts";

/**
 * What a retryable notice's retry sends again: the operator wakes of
 * `dispatchId`, or the bot's opening it carried, because its delivery failed (`undelivered`), which a late
 * delivery makes moot, or because the turn that ran failed or delivered
 * nothing (`turn`).
 */
export interface NoticeRetry {
  readonly dispatchId: DispatchRowId;
  readonly reason: "undelivered" | "turn";
}

/** Notices, in the caller's transaction. */
export const notices = (sql: SqlClient.SqlClient, entries: Entries["Service"]) => {
  const targetOf = liveTarget(sql);

  /** Shows a notice where the audience's speech goes; without `retry` it is not retryable. */
  const notify = Effect.fn("notices.notify")(function* (
    botId: BotId,
    audience: Audience,
    notice: Notice,
    retry: NoticeRetry | null,
  ) {
    const target = yield* targetOf(botId, audience);
    if (target === null) return;
    const entry = yield* entries.append({
      target,
      entry: { _tag: "notice", author: { _tag: "system" }, notice, retryable: retry !== null },
    });
    if (retry !== null) {
      yield* sql`
        INSERT INTO notice_retries (entry_id, dispatch_id, reason)
        VALUES (${entry.id}, ${retry.dispatchId}, ${retry.reason})
      `;
    }
  }, Effect.orDie);

  return { notify };
};
