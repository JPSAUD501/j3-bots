// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { Engine, SessionId } from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { conversationDigest } from "./digest.ts";
import { Ledger } from "./Ledger.ts";
import { CatchUpNote, SessionRowId } from "./model.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { onePassAtATime, type Pass, passOutcome, reconcile } from "./reconciler.ts";
import { RotationReason, rotationRequests } from "./rotationRequests.ts";
import { sessionLoss } from "./sessionRecords.ts";
import { Signals } from "./Signals.ts";
import { isIdle, sessionWork } from "./sessionWork.ts";
import { WorkSteps } from "./WorkSteps.ts";

/**
 * A main session that ran this many turns is replaced. Provisional, until
 * real conversations tune it (`docs/open-questions.md`, 8).
 */
export const ROTATE_AFTER_RUNS = 200;

/**
 * How soon a rotation held by background work looks again: such work may end
 * without an event telling of it.
 */
const BACKGROUND_RECHECK = Duration.seconds(30);

/** A failed opening of a bot's main session is tried again: from 5 s, doubling up to 5 min. */
const openRetry = (failures: number) =>
  Duration.min(Duration.seconds(5 * 2 ** Math.min(failures - 1, 6)), Duration.minutes(5));

/** How many entries a digest reads at a time, going back until it is full. */
const DIGEST_PAGE = 100;

const Due = Schema.Struct({
  id: SessionRowId,
  bot_id: BotId,
  engine_session_id: Schema.NullOr(SessionId),
  lost: Flag,
  rotation_reason: Schema.NullOr(RotationReason),
});
type Due = typeof Due.Type;

const Retired = Schema.Struct({ id: SessionRowId, engine_session_id: SessionId });

const encodeNote = Schema.encodeEffect(json(CatchUpNote));

/**
 * What a session due for rotation waits for before it is retired. A lost
 * session, and one never opened, run nothing: it is replaced at once. One the
 * engine could not resume is replaced once no turn runs or can run there,
 * whatever background work it still has, which the retirement ends, as for a
 * lost one. Any other waits until the session is quiet by the engine's own
 * stop rule: no turn, and no background work pending. For the operator's own
 * actions a Stop ran first, so it is quiet once that Stop settles; the run
 * limit waits for the work to end by itself, and its session takes new work
 * meanwhile.
 */
type Waits = "nothing" | "turns" | "everything";

const waitsFor = (session: Due): Waits =>
  session.lost || session.engine_session_id === null
    ? "nothing"
    : session.rotation_reason === "context-recovered"
      ? "turns"
      : "everything";

/**
 * The rotator (`docs/architecture/server.md`, Rotation). It replaces each
 * bot's main session that is due, as its reason says (`waitsFor`). Quiet is
 * the engine's word: a marker taken after the session's events are known says
 * whether a turn can still run or background work is pending, and what the
 * server knows (a dispatch on its way, a turn, a Stop, a continuation) is
 * checked again in the transaction that retires the session. That transaction
 * also writes the digest the next session's first envelope carries, unless the
 * operator asked for a fresh start. The old engine thread is then taken out of
 * use, retried until the engine answers, and its events are no longer
 * followed.
 *
 * It also keeps every live bot's main session opened: a missing or unopened
 * one is opened under its existing key on each pass, with backoff after a
 * failure, so a bot never waits for an engine restart to get one. And it asks
 * for the rotation of a session that ran `ROTATE_AFTER_RUNS` turns.
 */
export class Rotations extends Context.Service<
  Rotations,
  {
    /** One pass over the sessions due and the bots without an opened main session. */
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
    const { requestRotation, dropDigests } = rotationRequests(sql, signals);
    const { sessionLost } = sessionLoss(sql, entries, yield* Ledger, yield* WorkSteps, signals);
    /** Bots whose main session failed to open: how often in a row, and when it is tried again. */
    const openFailures = new Map<BotId, { readonly failures: number; readonly at: DateTime.Utc }>();

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

    const dueRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Due,
      execute: () => sql`
        SELECT id, bot_id, engine_session_id, lost_at IS NOT NULL AS lost, rotation_reason
        FROM sessions
        WHERE purpose = 'main' AND retired_at IS NULL
          AND (lost_at IS NOT NULL OR rotation_reason IS NOT NULL)
        ORDER BY rowid
      `,
    });

    /** The session as it stands now, if it is still live. */
    const dueRow = SqlSchema.findOneOption({
      Request: SessionRowId,
      Result: Due,
      execute: (id) => sql`
        SELECT id, bot_id, engine_session_id, lost_at IS NOT NULL AS lost, rotation_reason
        FROM sessions WHERE id = ${id} AND retired_at IS NULL
      `,
    });

    /** Live bots whose main session is missing, or not opened yet. */
    const unopened = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: BotId }),
      execute: () => sql`
        SELECT b.id FROM bots b WHERE NOT EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.bot_id = b.id AND s.purpose = 'main' AND s.retired_at IS NULL
            AND s.engine_session_id IS NOT NULL
        )
        ORDER BY b.rowid
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

    /** Nothing runs in the session or is on its way to it, as far as the server knows. */
    const locallyQuiet = Effect.fn("Rotations.locallyQuiet")(function* (sessionId: SessionRowId) {
      const work = yield* workOf(sessionId);
      return isIdle(work) && work.continuations === 0 && !work.stopUnsettled;
    });

    /**
     * The conversation's digest, read back from its latest entries until it
     * holds as many messages as a digest takes, or the conversation's start.
     */
    const digestOf = Effect.fn("Rotations.digestOf")(function* (botId: BotId) {
      const operator = (yield* settings.get).operatorName ?? UNNAMED_OPERATOR;
      const target = { _tag: "conversation", botId } as const;
      // Pages newest first, each oldest first; the digest reads them all oldest first.
      const pages = [yield* entries.latest(target, DIGEST_PAGE)];
      let older = pages[0]?.length === DIGEST_PAGE;
      let digest = conversationDigest(pages.toReversed().flat(), operator);
      while (!digest.full && older) {
        const first = pages.at(-1)?.[0];
        if (first === undefined) break;
        const page = yield* entries
          .history({ target, before: first.order, limit: DIGEST_PAGE })
          .pipe(Effect.orDie);
        pages.push(page.entries);
        older = page.hasOlder;
        digest = conversationDigest(pages.toReversed().flat(), operator);
      }
      return digest.text;
    });

    /**
     * Retires the session and writes what the next one is told, unless it
     * changed meanwhile or is no longer quiet as its reason requires: whether
     * it was retired by this call. A digest supersedes one no envelope carried
     * yet; a fresh start drops it and writes none.
     */
    const retire = Effect.fn("Rotations.retire")(function* (sessionId: SessionRowId) {
      return yield* transaction(
        Effect.gen(function* () {
          const found = yield* dueRow(sessionId);
          if (Option.isNone(found)) return null;
          const session = found.value;
          if (!session.lost && session.rotation_reason === null) return null;
          if (waitsFor(session) !== "nothing" && !(yield* locallyQuiet(session.id))) return null;
          const now = yield* DateTime.now;
          yield* sql`UPDATE sessions SET retired_at = ${timeText(now)} WHERE id = ${session.id}`;
          yield* dropDigests(session.bot_id);
          if (session.rotation_reason !== "fresh-start") {
            const note: CatchUpNote = {
              _tag: "session-rotated",
              digest: yield* digestOf(session.bot_id),
            };
            yield* sql`
              INSERT INTO catch_up_notes (id, bot_id, text, created_at, note_json)
              VALUES (
                ${yield* ids.make("note")}, ${session.bot_id},
                ${"The bot's main session was replaced."}, ${timeText(now)},
                ${yield* encodeNote(note)}
              )
            `;
          }
          return session;
        }),
      ).pipe(Effect.orDie);
    });

    /**
     * Whether the engine shows the session quiet as `waits` requires, from a
     * marker taken after its events are known: no turn it can still run, and
     * for `everything` no background work pending.
     */
    const engineQuiet = Effect.fn("Rotations.engineQuiet")(function* (
      session: Due,
      engineSessionId: SessionId,
      waits: Waits,
    ) {
      return yield* observer.synchronize(session.id, engineSessionId).pipe(
        Effect.map(({ backgroundWork, runnableTurns }) =>
          runnableTurns.length > 0
            ? ("busy" as const)
            : waits === "everything" && backgroundWork
              ? ("background" as const)
              : ("quiet" as const),
        ),
        Effect.catchTags({
          // The engine has no such session: recorded lost, and replaced as one.
          SessionNotFound: () =>
            transaction(sessionLost(session.id)).pipe(Effect.as("lost" as const)),
          NotObserved: () => Effect.succeed("deferred" as const),
          EngineIndeterminate: () => Effect.succeed("deferred" as const),
          EngineUnavailable: () => Effect.succeed("deferred" as const),
          EngineIncompatible: () => Effect.succeed("unavailable" as const),
        }),
      );
    });

    type Replacement = "replaced" | "waits" | "deferred" | "unavailable";

    /** One session due: replaced now, or left until what it waits for has ended. */
    const replace = Effect.fn("Rotations.replace")(function* (
      session: Due,
      outcome: ReturnType<typeof passOutcome>,
    ) {
      const waits = waitsFor(session);
      if (waits !== "nothing" && session.engine_session_id !== null) {
        // Its state counts only once its events are known.
        yield* observer.watch(session.id);
        if (!(yield* observer.ready(session.id))) return "deferred" satisfies Replacement;
        // The end of a turn, a dispatch or a Stop nudges the rotator again.
        if (!(yield* locallyQuiet(session.id))) return "waits" satisfies Replacement;
        const engineShows = yield* engineQuiet(session, session.engine_session_id, waits);
        switch (engineShows) {
          case "busy":
            return "waits" satisfies Replacement;
          case "background":
            outcome.until(DateTime.addDuration(yield* DateTime.now, BACKGROUND_RECHECK));
            return "waits" satisfies Replacement;
          case "lost":
            // Replaced at once on the next pass, which the loss nudges.
            return "waits" satisfies Replacement;
          case "deferred":
          case "unavailable":
            return engineShows satisfies Replacement;
          case "quiet":
            break;
        }
      }
      const retired = yield* retire(session.id);
      if (retired === null) return "waits" satisfies Replacement;
      yield* Effect.logInfo("A bot's main session was replaced").pipe(
        Effect.annotateLogs({
          botId: retired.bot_id,
          reason: retired.lost ? "lost" : retired.rotation_reason,
        }),
      );
      if (retired.rotation_reason === "context-recovered" && retired.engine_session_id !== null) {
        yield* Effect.logInfo(
          "Background work the replaced session still had ends with its retirement",
        ).pipe(Effect.annotateLogs({ botId: retired.bot_id }));
      }
      return "replaced" satisfies Replacement;
    });

    /**
     * Opens the bot's main session under its existing key, or a new one if it
     * has none. An engine that takes no commands ends the pass, which runs
     * again once it is ready; any other failure is tried again with backoff.
     */
    const open = Effect.fn("Rotations.open")(function* (
      botId: BotId,
      outcome: ReturnType<typeof passOutcome>,
    ) {
      const now = yield* DateTime.now;
      const failed = openFailures.get(botId);
      if (failed !== undefined && DateTime.isGreaterThan(failed.at, now)) {
        outcome.until(failed.at);
        return "done" as const;
      }
      const opened = yield* Effect.exit(sessions.provision(botId));
      if (opened._tag === "Success") {
        openFailures.delete(botId);
        return "done" as const;
      }
      const error = Cause.findErrorOption(opened.cause);
      if (
        Option.isSome(error) &&
        (error.value._tag === "EngineUnavailable" || error.value._tag === "EngineIncompatible")
      ) {
        return "unavailable" as const;
      }
      const failures = (failed?.failures ?? 0) + 1;
      const at = DateTime.addDuration(now, openRetry(failures));
      openFailures.set(botId, { failures, at });
      outcome.until(at);
      yield* Effect.logWarning("A bot's main session could not be opened; it is tried again", {
        botId,
        cause: opened.cause,
      });
      return "done" as const;
    });

    const rotatePass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        for (const { id } of yield* overRuns(ROTATE_AFTER_RUNS).pipe(Effect.orDie)) {
          yield* requestRotation(id, "runs");
        }
        let replaced = false;
        for (const session of yield* dueRows(undefined).pipe(Effect.orDie)) {
          const result = yield* replace(session, outcome);
          if (result === "unavailable") return { _tag: "unavailable" } as const;
          if (result === "deferred") outcome.defer();
          if (result === "replaced") replaced = true;
        }
        for (const { id } of yield* unopened(undefined).pipe(Effect.orDie)) {
          if ((yield* open(id, outcome)) === "unavailable") return { _tag: "unavailable" } as const;
        }
        // Wakes held for a replaced session go to the new one, opened by now
        // if the engine took it.
        if (replaced) yield* signals.dispatch.fire;
        for (const session of yield* retiredInUse(undefined).pipe(Effect.orDie)) {
          const retired = yield* Effect.exit(engine.retireSession(session.engine_session_id));
          if (retired._tag === "Failure") return { _tag: "unavailable" } as const;
          yield* sql`
            UPDATE sessions SET engine_retired_at = ${timeText(yield* DateTime.now)}
            WHERE id = ${session.id}
          `.pipe(Effect.orDie);
          yield* observer.close(session.id);
        }
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
