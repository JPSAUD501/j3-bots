// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, EntryId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Ids } from "../Ids.ts";
import { json, timeText } from "../persistence/columns.ts";
import {
  type Audience,
  audienceColumns,
  type DispatchSeq,
  PRIORITY,
  type WakeKind,
  WakePayload,
} from "./model.ts";
import { liveTarget } from "./liveTarget.ts";
import { Signals } from "./Signals.ts";
import { stopTargets } from "./stopTargets.ts";

/** A wake about to be written. */
export interface NewWake {
  readonly botId: BotId;
  readonly kind: WakeKind;
  readonly audience: Audience;
  readonly payload: WakePayload;
  /** The operator's message or the answered card that caused it. */
  readonly sourceEntryId: EntryId | null;
  readonly hops: number;
  /** The failed wake an operator's retry sends again. */
  readonly retryOf: string | null;
  /**
   * What led to it: the operator, whose word a Stop never cancels ahead of
   * time, or the bot's own work that began with the dispatch written at
   * `seq`, which a Stop covering it ended (`stopTargets.covers`) and an
   * archived or deleted room left with nowhere to go.
   */
  readonly cause:
    | { readonly _tag: "operator" }
    | { readonly _tag: "work"; readonly seq: DispatchSeq };
}

const encodePayload = Schema.encodeEffect(json(WakePayload));

/**
 * Writes wakes (`docs/architecture/server.md`, 1. A wake is recorded before
 * anything happens): in the caller's transaction, the one that writes their
 * cause, so a wake exists exactly when its cause does. A wake that follows
 * from work a Stop covers is not written: the operator stopped what it would
 * continue. Nor is one that follows from work for a room no longer active:
 * nobody is there to see it. The dispatcher looks once it commits.
 */
export class Wakes extends Context.Service<
  Wakes,
  { readonly record: (wakes: ReadonlyArray<NewWake>) => Effect.Effect<ReadonlyArray<string>> }
>()("@j3-bots/server/turns/Wakes") {}

export const layer = Layer.effect(
  Wakes,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* Ids;
    const signals = yield* Signals;
    const stops = stopTargets(sql);
    const live = liveTarget(sql);

    const record = Effect.fn("Wakes.record")(function* (wakes: ReadonlyArray<NewWake>) {
      const at = timeText(yield* DateTime.now);
      const written: Array<string> = [];
      for (const wake of wakes) {
        if (
          wake.cause._tag === "work" &&
          ((yield* stops.covers(wake.botId, wake.audience, wake.cause.seq)) ||
            (yield* live(wake.botId, wake.audience)) === null)
        ) {
          continue;
        }
        const id = yield* ids.make("wake");
        const { audience, roomId } = audienceColumns(wake.audience);
        yield* sql`
          INSERT INTO wakes (
            id, bot_id, kind, priority, audience, audience_room_id, hops, payload_json, status,
            source_entry_id, retry_of, created_at, updated_at
          ) VALUES (
            ${id}, ${wake.botId}, ${wake.kind}, ${PRIORITY[wake.kind]}, ${audience}, ${roomId},
            ${wake.hops}, ${yield* encodePayload(wake.payload)}, 'pending',
            ${wake.sourceEntryId}, ${wake.retryOf}, ${at}, ${at}
          )
        `;
        written.push(id);
      }
      if (written.length > 0) yield* sql.afterCommit(signals.dispatch.fire);
      return written;
    }, Effect.orDie);

    return Wakes.of({ record });
  }),
);
