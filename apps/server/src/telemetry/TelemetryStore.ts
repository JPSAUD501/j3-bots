// SPDX-License-Identifier: AGPL-3.0-or-later
import { type TelemetryIdHash, telemetryIdHash } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { timeText } from "../persistence/columns.ts";

/** How many sent events "See what is sent" keeps: the newest. */
export const KEPT_SENT_EVENTS = 100;

const InstallRow = Schema.Struct({
  install_id: Schema.String,
  active_day: Schema.NullOr(Schema.String),
  last_version: Schema.NullOr(Schema.String),
  told_update_run: Schema.NullOr(Schema.String),
});

/** What the server remembers of what it already told, so it tells each thing once. */
export interface TelemetryMarks {
  /** The UTC day (`YYYY-MM-DD`) the install last said it was in use. */
  readonly activeDay: string | null;
  /** The release the server ran when it last started. */
  readonly lastVersion: string | null;
  /** The client-started update whose outcome it last told. */
  readonly toldUpdateRun: string | null;
}

const SentRow = Schema.Struct({ body: Schema.String });

/**
 * What the server keeps of its usage data, in its database: the install's
 * random id, the day it last said it was in use, and the newest events as
 * they left, each the JSON text that was sent.
 */
export class TelemetryStore extends Context.Service<
  TelemetryStore,
  {
    /** The hash of the install's random id, made and kept the first time it is asked for. */
    readonly install: Effect.Effect<TelemetryIdHash>;
    readonly marks: Effect.Effect<TelemetryMarks>;
    /** Records the marks `changes` names; the others keep theirs. */
    readonly mark: (changes: Partial<TelemetryMarks>) => Effect.Effect<void>;
    /** Keeps `bodies` as sent at `at`, and drops all but the newest `KEPT_SENT_EVENTS`. */
    readonly keepSent: (
      sent: ReadonlyArray<{ readonly uuid: string; readonly body: string }>,
      at: DateTime.Utc,
    ) => Effect.Effect<void>;
    /** The kept events' JSON text, newest first. */
    readonly sent: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@j3-bots/server/telemetry/TelemetryStore") {}

export const layer = Layer.effect(
  TelemetryStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const readInstall = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: InstallRow,
      execute: () => sql`
        SELECT install_id, active_day, last_version, told_update_run FROM telemetry_install
        WHERE id = 1
      `,
    });
    const readSent = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SentRow,
      execute: () =>
        sql`SELECT body FROM telemetry_sent ORDER BY sent_at DESC, rowid DESC LIMIT ${KEPT_SENT_EVENTS}`,
    });

    const install = Effect.gen(function* () {
      const kept = yield* readInstall(undefined);
      if (Option.isSome(kept)) return telemetryIdHash(kept.value.install_id);
      const made = Array.from(yield* random.randomBytes(32), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      // Another start that made one first keeps its own.
      yield* sql`INSERT INTO telemetry_install (id, install_id) VALUES (1, ${made}) ON CONFLICT (id) DO NOTHING`;
      const now = yield* readInstall(undefined);
      return telemetryIdHash(
        Option.match(now, { onNone: () => made, onSome: (row) => row.install_id }),
      );
    }).pipe(Effect.orDie, Effect.withSpan("TelemetryStore.install"));

    return TelemetryStore.of({
      install,
      marks: Effect.gen(function* () {
        yield* install;
        const row = yield* readInstall(undefined).pipe(Effect.orDie);
        return Option.match(row, {
          onNone: (): TelemetryMarks => ({
            activeDay: null,
            lastVersion: null,
            toldUpdateRun: null,
          }),
          onSome: (each): TelemetryMarks => ({
            activeDay: each.active_day,
            lastVersion: each.last_version,
            toldUpdateRun: each.told_update_run,
          }),
        });
      }),
      mark: Effect.fn("TelemetryStore.mark")(function* (changes: Partial<TelemetryMarks>) {
        yield* install;
        if (changes.activeDay !== undefined) {
          yield* sql`UPDATE telemetry_install SET active_day = ${changes.activeDay} WHERE id = 1`;
        }
        if (changes.lastVersion !== undefined) {
          yield* sql`UPDATE telemetry_install SET last_version = ${changes.lastVersion} WHERE id = 1`;
        }
        if (changes.toldUpdateRun !== undefined) {
          yield* sql`
            UPDATE telemetry_install SET told_update_run = ${changes.toldUpdateRun} WHERE id = 1
          `;
        }
      }, Effect.orDie),
      keepSent: Effect.fn("TelemetryStore.keepSent")(function* (sent, at) {
        if (sent.length === 0) return;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const { uuid, body } of sent) {
              yield* sql`
                  INSERT INTO telemetry_sent (uuid, sent_at, body) VALUES (${uuid}, ${timeText(at)}, ${body})
                  ON CONFLICT (uuid) DO NOTHING
                `;
            }
            yield* sql`
                DELETE FROM telemetry_sent WHERE uuid NOT IN (
                  SELECT uuid FROM telemetry_sent ORDER BY sent_at DESC, rowid DESC LIMIT ${KEPT_SENT_EVENTS}
                )
              `;
          }),
        );
      }, Effect.orDie),
      sent: readSent(undefined).pipe(
        Effect.map((rows) => rows.map((row) => row.body)),
        Effect.orDie,
      ),
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
