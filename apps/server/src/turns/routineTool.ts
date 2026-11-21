// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type Conflict,
  type Invalid,
  type NotFound,
  Routine,
  RoutineId,
  RoutineTrigger,
} from "@j3-bots/contracts";
import type { ToolInput } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { json } from "../persistence/columns.ts";
import { Routines } from "../routines/Routines.ts";
import { localInstant } from "../routines/schedule.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { TurnEnded, TurnToolRefused } from "../tools/TurnTools.ts";
import { SessionRowId } from "./model.ts";

/** The request a pinned `set_routine` call acts for. */
interface Request {
  readonly requestId: string;
  readonly sessionId: SessionRowId;
  readonly botId: BotId;
}

/**
 * Runs `apply` once for the request, in the transaction that pins it to its
 * call and stores its result, or returns the result stored for it already.
 */
export type Once = <E, R>(
  apply: Effect.Effect<Schema.Json, E, R>,
) => Effect.Effect<Schema.Json, E | TurnEnded | Conflict, R>;

type SetRoutineInput = ToolInput<"set_routine">;

const SessionOfCall = Schema.Struct({
  purpose: Schema.Literals(["main", "side"]),
  /** The routine a side session runs; null in a main session, or once the routine is deleted. */
  routine_id: Schema.NullOr(RoutineId),
});

const encodeRoutine = Schema.encodeEffect(Schema.toCodecJson(Routine));

const refuse = (reason: string) => new TurnToolRefused({ reason });

const notYours = (id: string | undefined) =>
  refuse(`You have no routine ${id}. list_routines shows your routines' ids.`);

/**
 * `set_routine` (`docs/architecture/server.md`, Bot tools): a bot creates,
 * changes, pauses, resumes or deletes one of its own routines through
 * `Routines`, the operator's path, with the bot as the change's author. A
 * schedule and a time without an offset are read in the operator's zone as
 * set now, also for a routine whose schedule kept another: the operator
 * speaks in their own. In a routine's side session the only call taken is
 * `pause` of the routine that session runs, so a routine can stop itself
 * once its job is done.
 *
 * The result is the routine as saved, its webhook's address included: that
 * address is a credential, which the server adds to no entry, notice or log.
 */
export const routineTool = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const routines = yield* Routines;
  const settings = yield* SettingsStore;

  const sessionOf = SqlSchema.findOneOption({
    Request: SessionRowId,
    Result: SessionOfCall,
    execute: (id) => sql`
      SELECT s.purpose, w.routine_id FROM sessions s
      LEFT JOIN wakes w ON w.id = s.side_wake_id
      WHERE s.id = ${id}
    `,
  });

  const ownerOf = SqlSchema.findOneOption({
    Request: RoutineId,
    Result: Schema.Struct({ bot_id: BotId, trigger_json: json(RoutineTrigger) }),
    execute: (id) => sql`SELECT bot_id, trigger_json FROM routines WHERE id = ${id}`,
  });

  /** Refuses every call a routine run may not make. */
  const requireAllowed = Effect.fn("RoutineTool.requireAllowed")(function* (
    request: Request,
    input: SetRoutineInput,
  ) {
    const session = yield* sessionOf(request.sessionId).pipe(Effect.orDie);
    if (Option.isNone(session)) return yield* new TurnEnded();
    const { purpose, routine_id: running } = session.value;
    if (purpose === "main") return;
    if (input.action === "pause" && running !== null && input.id === running) return;
    return yield* refuse(
      running === null
        ? "A routine run cannot change routines, and this run's routine was deleted."
        : `A routine run can only pause its own routine: set_routine with action pause and id ${running}. Put any other change in your say message, for your user to ask for.`,
    );
  });

  /**
   * The operator's zone, which a schedule and a time without an offset are
   * read in. One the server does not know refuses every such call: only the
   * operator can choose another, so the bot is told to ask them.
   */
  const operatorZone = Effect.fn("RoutineTool.operatorZone")(function* () {
    const { timeZone } = yield* settings.get;
    const zone = DateTime.zoneMakeNamed(timeZone);
    if (Option.isNone(zone)) {
      return yield* refuse(
        `Your user's time zone, ${timeZone}, is not one the server knows, so no schedule or time can be set until they choose another in their settings. Tell them so in your reply.`,
      );
    }
    return { name: timeZone, zone: zone.value };
  });

  /** The trigger the call gives, with its times in the operator's zone. */
  const triggerOf = Effect.fn("RoutineTool.triggerOf")(function* (input: SetRoutineInput) {
    if (input.webhook === true) return { _tag: "webhook" } satisfies RoutineTrigger;
    if (input.schedule !== undefined) {
      const { name } = yield* operatorZone();
      return { _tag: "schedule", cron: input.schedule, timeZone: name } satisfies RoutineTrigger;
    }
    if (input.at === undefined) return undefined;
    const { zone } = yield* operatorZone();
    const instant = localInstant(input.at, zone);
    if (Option.isNone(instant)) {
      return yield* refuse(`${input.at} is not a date and time that exists.`);
    }
    return { _tag: "once", at: instant.value } satisfies RoutineTrigger;
  });

  /** The routine's saved trigger, if the routine is one of the caller's. */
  const requireOwn = Effect.fn("RoutineTool.requireOwn")(function* (
    request: Request,
    id: RoutineId,
  ) {
    const owner = yield* ownerOf(id).pipe(Effect.orDie);
    if (Option.isNone(owner) || owner.value.bot_id !== request.botId) {
      return yield* notYours(id);
    }
    return owner.value.trigger_json;
  });

  /**
   * Why a command of `Routines` refused the call, in words for the bot.
   * `checked` is the trigger the command checked: the one the call gives, or
   * else the routine's saved one, which a resume plans again.
   */
  const explained =
    (
      id: string | undefined,
      checked: { readonly trigger: RoutineTrigger; readonly given: boolean },
    ) =>
    (error: NotFound | Invalid): Effect.Effect<never, TurnEnded | TurnToolRefused> => {
      if (error._tag === "NotFound") {
        return Effect.fail(error.resource === "bot" ? new TurnEnded() : notYours(id));
      }
      const { trigger, given } = checked;
      switch (trigger._tag) {
        case "schedule":
          return Effect.fail(
            refuse(
              error.reason === "time-zone"
                ? `The time zone ${trigger.timeZone} is not one the server knows. Give the routine a new schedule with update, which uses your user's zone.`
                : given
                  ? `The schedule "${trigger.cron}" cannot be used: it needs five cron fields that name a date that exists, and at most one run every five minutes.`
                  : `This routine's schedule "${trigger.cron}" cannot run any more. Give it a new one with update.`,
            ),
          );
        case "once":
          return Effect.fail(
            refuse(
              given
                ? "That time has already passed. Give a time ahead."
                : "This routine's one-time run has passed. Give it a new time, schedule or webhook with update; that starts it again.",
            ),
          );
        case "webhook":
          return Effect.die("A webhook trigger is never refused: it has no time to check");
      }
    };

  const saved = (routine: Routine) =>
    encodeRoutine(routine).pipe(
      Effect.orDie,
      Effect.map((json): Schema.Json => json),
    );

  /** Applies the call, pinned to it through `once`. */
  const setRoutine = Effect.fn("RoutineTool.setRoutine")(function* (
    request: Request,
    input: SetRoutineInput,
    once: Once,
  ) {
    yield* requireAllowed(request, input);
    const trigger = yield* triggerOf(input);
    const author = { _tag: "bot", botId: request.botId } as const;
    // The pin in `once` makes the call act once, so no command receipt keeps
    // another copy of the routine, and of a webhook's address.
    const commandId = null;
    if (input.action === "create") {
      const { name, instruction } = input;
      if (name === undefined || instruction === undefined || trigger === undefined) {
        return yield* Effect.die("The tool's schema lets no create through without these");
      }
      const explain = explained(input.id, { trigger, given: true });
      return yield* once(
        routines
          .create({
            commandId,
            botId: request.botId,
            draft: { name, instruction, trigger },
            author,
          })
          .pipe(Effect.catchTags({ NotFound: explain, Invalid: explain }), Effect.flatMap(saved)),
      );
    }
    if (input.id === undefined) {
      return yield* Effect.die("The tool's schema lets no call but create through without an id");
    }
    const routineId = RoutineId.make(input.id);
    if (input.action === "delete") {
      return yield* once(
        Effect.gen(function* () {
          const current = yield* requireOwn(request, routineId);
          const explain = explained(input.id, { trigger: current, given: false });
          yield* routines
            .remove({ commandId, routineId, author })
            .pipe(Effect.catchTags({ NotFound: explain, Invalid: explain }));
          return { status: "deleted", id: routineId } satisfies Schema.Json;
        }),
      );
    }
    const changes =
      input.action === "update"
        ? {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
            ...(trigger === undefined ? {} : { trigger }),
          }
        : { enabled: input.action === "resume" };
    return yield* once(
      Effect.gen(function* () {
        const current = yield* requireOwn(request, routineId);
        const explain = explained(
          input.id,
          trigger === undefined ? { trigger: current, given: false } : { trigger, given: true },
        );
        const routine = yield* routines
          .update({ commandId, routineId, changes, author })
          .pipe(Effect.catchTags({ NotFound: explain, Invalid: explain }));
        return yield* saved(routine);
      }),
    );
  });

  return setRoutine;
});
