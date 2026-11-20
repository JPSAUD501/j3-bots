// SPDX-License-Identifier: AGPL-3.0-or-later
import { type CommandId, Conflict } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { json, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";

/**
 * Text that is equal for equal payloads: object keys sorted, times as ISO
 * strings. It is only ever compared with what this server wrote, so it needs to
 * be stable, not standard.
 */
const fingerprintText = (payload: unknown): string =>
  JSON.stringify(payload, (_key: string, member: unknown): unknown => {
    if (DateTime.isDateTime(member)) return DateTime.formatIso(member);
    return Predicate.isObject(member) && !Array.isArray(member)
      ? Object.fromEntries(
          Object.entries(member).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : member;
  });

const ReceiptRow = Schema.Struct({
  method: Schema.String,
  payload_hash: Schema.String,
  result_json: Schema.String,
});

/**
 * Applies each client command once. A command's writes and its receipt commit
 * in one transaction, so a retry after a lost reply finds the receipt and gets
 * the first result back instead of acting again. The same id reused for a
 * different command is refused.
 */
export class CommandReceipts extends Context.Service<
  CommandReceipts,
  {
    /**
     * Runs `apply` in a transaction that also stores its result under
     * `commandId`, or returns the stored result. `apply` must be the command's
     * only durable effect; work outside the database goes after it and must be
     * safe to repeat. A failure stores nothing, so the client may retry.
     */
    readonly once: <A, I, E, R>(input: {
      readonly commandId: CommandId;
      readonly method: string;
      readonly payload: unknown;
      readonly result: Schema.Codec<A, I>;
      readonly apply: Effect.Effect<A, E, R>;
    }) => Effect.Effect<A, E | Conflict, R>;
  }
>()("@j3-bots/server/commands/CommandReceipts") {}

export const layer = Layer.effect(
  CommandReceipts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const digest = yield* Digest.Digest;
    const transaction = transactional(sql);
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ReceiptRow,
      execute: (commandId) => sql`
        SELECT method, payload_hash, result_json FROM command_receipts
        WHERE command_id = ${commandId}
      `,
    });

    const once = <A, I, E, R>(input: {
      readonly commandId: CommandId;
      readonly method: string;
      readonly payload: unknown;
      readonly result: Schema.Codec<A, I>;
      readonly apply: Effect.Effect<A, E, R>;
    }): Effect.Effect<A, E | Conflict, R> =>
      Effect.gen(function* () {
        const codec = json(input.result);
        const hash = yield* digest.digestHex(
          Digest.sha256,
          new TextEncoder().encode(fingerprintText(input.payload)),
        );
        const stored = yield* find(input.commandId).pipe(Effect.orDie);
        if (Option.isSome(stored)) {
          if (stored.value.method !== input.method || stored.value.payload_hash !== hash) {
            return yield* new Conflict({ reason: "command-id-reused" });
          }
          return yield* Schema.decodeEffect(codec)(stored.value.result_json).pipe(Effect.orDie);
        }
        const result = yield* input.apply;
        const text = yield* Schema.encodeEffect(codec)(result).pipe(Effect.orDie);
        const at = timeText(yield* DateTime.now);
        yield* sql`
          INSERT INTO command_receipts (command_id, method, payload_hash, result_json, created_at)
          VALUES (${input.commandId}, ${input.method}, ${hash}, ${text}, ${at})
        `.pipe(Effect.orDie);
        return result;
      }).pipe(transaction);

    return CommandReceipts.of({ once });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
