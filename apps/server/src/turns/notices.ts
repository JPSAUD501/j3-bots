// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type Notice } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Entries } from "../entries/Entries.ts";
import { timeText } from "../persistence/columns.ts";
import { liveTarget } from "./liveTarget.ts";
import { type Audience, conversation, type DispatchRowId, type SessionRowId } from "./model.ts";

const LostRow = Schema.Struct({ bot_id: BotId, purpose: Schema.Literals(["main", "side"]) });

/**
 * Notices, and the one state change that always shows one: a session the
 * engine no longer has. Runs in the caller's transaction.
 */
export const notices = (sql: SqlClient.SqlClient, entries: Entries["Service"]) => {
  const targetOf = liveTarget(sql);

  /**
   * Shows a notice where the audience's speech goes. `retry` is the dispatch
   * whose operator wakes `notice.retry` sends again; without one it is not
   * retryable.
   */
  const notify = Effect.fn("notices.notify")(function* (
    botId: BotId,
    audience: Audience,
    notice: Notice,
    retry: DispatchRowId | null,
  ) {
    const target = yield* targetOf(botId, audience);
    if (target === null) return;
    const entry = yield* entries.append({
      target,
      entry: { _tag: "notice", author: { _tag: "system" }, notice, retryable: retry !== null },
    });
    if (retry !== null) {
      yield* sql`INSERT INTO notice_retries (entry_id, dispatch_id) VALUES (${entry.id}, ${retry})`;
    }
  }, Effect.orDie);

  const markLost = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, at: Schema.String }),
    Result: LostRow,
    execute: ({ sessionId, at }) => sql`
      UPDATE sessions SET lost_at = ${at}
      WHERE id = ${sessionId} AND lost_at IS NULL
      RETURNING bot_id, purpose
    `,
  });

  /**
   * The engine answered that it has no such session. Nothing is planned into
   * it or watched there again, and nothing runs there to stop: its Stop
   * targets are settled. A main session's loss shows in the bot's
   * conversation, once; part 2b gives the bot a new one.
   */
  const sessionLost = Effect.fn("notices.sessionLost")(function* (sessionId: SessionRowId) {
    const at = timeText(yield* DateTime.now);
    const [lost] = yield* markLost({ sessionId, at });
    if (lost === undefined) return false;
    yield* sql`
      UPDATE stop_targets SET sent_at = COALESCE(sent_at, ${at}),
        observed_at = COALESCE(observed_at, ${at}), stopped_at = ${at}
      WHERE session_id = ${sessionId} AND stopped_at IS NULL
    `;
    if (lost.purpose === "main") {
      yield* notify(lost.bot_id, conversation, { _tag: "session-lost" }, null);
    }
    return true;
  }, Effect.orDie);

  return { notify, sessionLost };
};
