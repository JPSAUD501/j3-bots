// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { Engine, SessionId } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { EngineSessions } from "../bots/EngineSessions.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { Flag, json, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { UNNAMED_OPERATOR } from "../settings/BasePrompt.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { conversationDigest, DIGEST_ENTRIES } from "./digest.ts";
import { CatchUpNote, SessionRowId } from "./model.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { onePassAtATime, type Pass, passOutcome, reconcile } from "./reconciler.ts";
import { RotationReason, rotationRequests } from "./rotationRequests.ts";
import { Signals } from "./Signals.ts";
import { isIdle, sessionWork } from "./sessionWork.ts";

/**
 * A main session that ran this many turns is replaced. Provisional, until
 * real conversations tune it (`docs/open-questions.md`, 8).
 */
export const ROTATE_AFTER_RUNS = 200;

const Due = Schema.Struct({
  id: SessionRowId,
  bot_id: BotId,
  lost: Flag,
  rotation_reason: Schema.NullOr(RotationReason),
});

const Retired = Schema.Struct({ id: SessionRowId, engine_session_id: SessionId });

const encodeNote = Schema.encodeEffect(json(CatchUpNote));

/**
 * The rotator (`docs/architecture/server.md`, Rotation): it replaces a bot's
 * main session that is due for it once nothing runs there, and a lost one at
 * once. In one transaction the old session is retired and a catch-up note
 * carrying a digest of the conversation is written, so the new session's first
 * envelope brings it. The bot's new main session is then opened as any is
 * (`EngineSessions.provision`), and the old engine thread is taken out of use,
 * retried until the engine answers. It also asks for the rotation of a session
 * that ran `ROTATE_AFTER_RUNS` turns.
 */
export class Rotations extends Context.Service<
  Rotations,
  {
    /** One pass over the sessions due. */
    readonly rotateDue: Effect.Effect<void>;
    /** The rotator, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/turns/Rotations") {}

export const layer = Layer.effect(
  Rotations,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const engine = yield* Engine;
    const sessions = yield* EngineSessions;
    const entries = yield* Entries;
    const settings = yield* SettingsStore;
    const observer = yield* Observer;
    const signals = yield* Signals;
    const readiness = yield* Readiness;
    const ids = yield* Ids;
    const workOf = sessionWork(sql);
    const { requestRotation } = rotationRequests(sql, signals);

    const overRuns = SqlSchema.findAll({
      Request: Schema.Number,
      Result: Schema.Struct({ id: SessionRowId }),
      execute: (limit) => sql`
        SELECT s.id FROM sessions s
        WHERE s.purpose = 'main' AND s.retired_at IS NULL AND s.lost_at IS NULL
          AND s.rotation_reason IS NULL
          AND (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) >= ${limit}
      `,
    });

    const due = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Due,
      execute: () => sql`
        SELECT id, bot_id, lost_at IS NOT NULL AS lost, rotation_reason FROM sessions
        WHERE purpose = 'main' AND retired_at IS NULL
          AND (lost_at IS NOT NULL OR rotation_reason IS NOT NULL)
        ORDER BY rowid
      `,
    });

    const retiredInUse = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Retired,
      execute: () => sql`
        SELECT id, engine_session_id FROM sessions
        WHERE retired_at IS NOT NULL AND lost_at IS NULL AND engine_session_id IS NOT NULL
          AND engine_retired_at IS NULL
        ORDER BY rowid
      `,
    });

    /** Nothing runs in the session or is on its way to it, as far as its known events say. */
    const quiet = Effect.fn("Rotations.quiet")(function* (sessionId: SessionRowId) {
      const work = yield* workOf(sessionId);
      return isIdle(work) && work.continuations === 0 && !work.stopUnsettled;
    });

    /**
     * Retires the session and writes the digest for the next one, unless the
     * session changed meanwhile: whether it was retired by this call.
     */
    const retire = Effect.fn("Rotations.retire")(function* (session: typeof Due.Type) {
      return yield* transaction(
        Effect.gen(function* () {
          if (!session.lost && !(yield* quiet(session.id))) return false;
          const now = yield* DateTime.now;
          const retired = yield* sql`
            UPDATE sessions SET retired_at = ${timeText(now)}
            WHERE id = ${session.id} AND retired_at IS NULL
            RETURNING id
          `;
          if (retired.length === 0) return false;
          const operator = (yield* settings.get).operatorName ?? UNNAMED_OPERATOR;
          const latest = yield* entries.latest(
            { _tag: "conversation", botId: session.bot_id },
            DIGEST_ENTRIES,
          );
          const note: CatchUpNote = {
            _tag: "session-rotated",
            digest: conversationDigest(latest, operator),
          };
          yield* sql`
            INSERT INTO catch_up_notes (id, bot_id, text, created_at, note_json)
            VALUES (
              ${yield* ids.make("note")}, ${session.bot_id},
              ${"The bot's main session was replaced."}, ${timeText(now)},
              ${yield* encodeNote(note)}
            )
          `;
          return true;
        }),
      ).pipe(Effect.orDie);
    });

    const rotatePass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        for (const { id } of yield* overRuns(ROTATE_AFTER_RUNS).pipe(Effect.orDie)) {
          yield* requestRotation(id, "runs");
        }
        let replaced = false;
        for (const session of yield* due(undefined).pipe(Effect.orDie)) {
          if (!session.lost) {
            // Its idleness counts only once its events are known.
            yield* observer.watch(session.id);
            if (!(yield* observer.ready(session.id))) {
              outcome.defer();
              continue;
            }
            if (!(yield* quiet(session.id))) continue;
          }
          if (!(yield* retire(session))) continue;
          replaced = true;
          yield* Effect.logInfo("A bot's main session was replaced").pipe(
            Effect.annotateLogs({
              botId: session.bot_id,
              reason: session.lost ? "lost" : session.rotation_reason,
            }),
          );
          // Opened now if the engine takes it, or when it is next ready.
          yield* sessions.provision(session.bot_id).pipe(
            Effect.catch((error) =>
              Effect.logWarning("A bot's new main session could not be opened yet", {
                botId: session.bot_id,
                error: error._tag,
              }),
            ),
          );
        }
        for (const session of yield* retiredInUse(undefined).pipe(Effect.orDie)) {
          const retired = yield* Effect.exit(engine.retireSession(session.engine_session_id));
          if (retired._tag === "Failure") return { _tag: "unavailable" } as const;
          yield* sql`
            UPDATE sessions SET engine_retired_at = ${timeText(yield* DateTime.now)}
            WHERE id = ${session.id}
          `.pipe(Effect.orDie);
        }
        if (replaced) yield* signals.dispatch.fire;
        return outcome.done();
      }).pipe(Effect.withSpan("Rotations.rotateDue")),
    );

    return Rotations.of({
      rotateDue: Effect.asVoid(rotatePass),
      run: reconcile({
        name: "The rotator",
        pass: rotatePass,
        signal: signals.rotations,
        readiness,
      }),
    });
  }),
);
