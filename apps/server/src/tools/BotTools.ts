// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, CommandId, Profile, Routine } from "@j3-bots/contracts";
import { DECODE_OPTIONS, type ToolName, tools } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import { type BotSession, EngineSessions } from "../bots/EngineSessions.ts";
import { Memory } from "../memory/Memory.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Routines } from "../routines/Routines.ts";
import type { ToolCallRequest, ToolCallResponse } from "./protocol.ts";
import { type TurnToolCall, type TurnToolRetry, TurnTools } from "./TurnTools.ts";

/** Why a call did nothing, in words the bot reads. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

const encodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.encodeEffect(Schema.toCodecJson(schema));

/**
 * The `j3` tools' server side. A call is accepted only from a live session of
 * a bot, with arguments that decode under the tool's own schema. The tools
 * that act for a turn go to `TurnTools`; the rest are answered here. A call
 * that could not be matched to its turn yet fails with `TurnToolRetry`, for
 * the bridge to forward again.
 */
export class BotTools extends Context.Service<
  BotTools,
  { readonly call: (request: ToolCallRequest) => Effect.Effect<ToolCallResponse, TurnToolRetry> }
>()("@j3-bots/server/tools/BotTools") {}

export const layer = Layer.effect(
  BotTools,
  Effect.gen(function* () {
    const sessions = yield* EngineSessions;
    const store = yield* BotStore;
    const bots = yield* Bots;
    const memory = yield* Memory;
    const rooms = yield* Rooms;
    const routines = yield* Routines;
    const turnTools = yield* TurnTools;

    /** A command id for a tool call, the same on every retry of its forward. */
    const commandIdOf = (requestId: string) => CommandId.make(`tool:${requestId}`);

    const refuseFailure = <A, E extends { readonly message: string }, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.mapError(effect, (error) => new Refused({ reason: error.message }));

    const requirePrimary = Effect.fn("BotTools.requirePrimary")(function* (caller: BotSession) {
      const self = yield* store.find(caller.botId);
      if (Option.isNone(self) || !self.value.bot.primary) {
        return yield* new Refused({ reason: "Only the primary bot can do this." });
      }
    });

    interface Call {
      readonly requestId: string;
      readonly caller: BotSession;
      readonly arguments: Schema.Json;
    }

    /** A handler that decodes its arguments with the tool's schema, then runs. */
    const handler =
      <S extends Schema.Decoder<unknown>, E, R>(
        schema: S,
        run: (input: S["Type"], call: Call) => Effect.Effect<Schema.Json, E, R>,
      ) =>
      (call: Call) =>
        Schema.decodeEffect(schema)(call.arguments, DECODE_OPTIONS).pipe(
          Effect.mapError((error) => new Refused({ reason: error.message })),
          Effect.flatMap((input) => run(input, call)),
        );

    /** Hands a turn tool's call to the turn it belongs to. */
    const admit = (call: TurnToolCall) =>
      turnTools.call(call).pipe(
        Effect.catchTags({
          TurnToolUnavailable: (error) => new Refused({ reason: error.message }),
          TurnEnded: (error) => new Refused({ reason: error.message }),
          TurnToolRefused: (error) => new Refused({ reason: error.message }),
          Conflict: (error) => new Refused({ reason: error.message }),
        }),
      );

    const handlers: {
      readonly [N in ToolName]: (call: Call) => Effect.Effect<Schema.Json, Refused | TurnToolRetry>;
    } = {
      say: handler(tools.say.input, (input, call) => admit({ tool: "say", input, ...call })),
      ask: handler(tools.ask.input, (input, call) => admit({ tool: "ask", input, ...call })),
      message_bot: handler(tools.message_bot.input, (input, call) =>
        admit({ tool: "message_bot", input, ...call }),
      ),
      set_routine: handler(tools.set_routine.input, (input, call) =>
        admit({ tool: "set_routine", input, ...call }),
      ),
      remember: handler(tools.remember.input, (input, { caller }) =>
        memory
          .remember({
            botId: caller.botId,
            fact: input.fact,
            tier: input.tier ?? "log",
            scope: input.scope ?? "bot",
          })
          .pipe(
            refuseFailure,
            Effect.map((result): Schema.Json => ({ ...result })),
          ),
      ),
      forget: handler(tools.forget.input, (input, { caller }) =>
        memory.forget({ botId: caller.botId, fact: input.fact, scope: input.scope ?? "bot" }).pipe(
          refuseFailure,
          Effect.map((result): Schema.Json => ({ ...result })),
        ),
      ),
      recall: handler(tools.recall.input, (input, { caller }) =>
        memory
          .recall({
            botId: caller.botId,
            query: input.query,
            scope: input.scope,
            limit: input.limit ?? 10,
          })
          .pipe(
            Effect.map((facts): Schema.Json => ({ facts: facts.map((fact) => ({ ...fact })) })),
          ),
      ),
      list_routines: handler(tools.list_routines.input, (_input, { caller }) =>
        routines.list(caller.botId).pipe(
          Effect.flatMap(encodeJson(Schema.Array(Routine))),
          Effect.orDie,
          Effect.map((list): Schema.Json => ({ routines: list })),
        ),
      ),
      list_teammates: handler(tools.list_teammates.input, (_input, { caller }) =>
        Effect.gen(function* () {
          const teammates = (yield* store.list)
            .filter(({ bot }) => bot.id !== caller.botId)
            .map(({ bot }) => ({
              id: bot.id,
              name: bot.profile.name,
              title: bot.profile.title,
              job: bot.profile.job,
            }));
          const joined = (yield* rooms.ofBot(caller.botId)).map((room) => ({
            id: room.id,
            name: room.name,
            members: [...room.members],
            archived: room.status === "archived",
          }));
          return { teammates, rooms: joined } satisfies Schema.Json;
        }),
      ),
      create_bot: handler(tools.create_bot.input, (input, call) =>
        Effect.gen(function* () {
          yield* requirePrimary(call.caller);
          const bot = yield* bots
            .create({ commandId: commandIdOf(call.requestId), draft: input })
            .pipe(refuseFailure);
          return { id: bot.id } satisfies Schema.Json;
        }),
      ),
      update_bot: handler(tools.update_bot.input, (input, call) =>
        Effect.gen(function* () {
          yield* requirePrimary(call.caller);
          const { id, ...profile } = input;
          const bot = yield* bots
            .update({
              commandId: commandIdOf(call.requestId),
              botId: BotId.make(id),
              changes: { profile },
            })
            .pipe(refuseFailure);
          return yield* encodeJson(Profile)(bot.profile).pipe(Effect.orDie);
        }),
      ),
      update_profile: handler(tools.update_profile.input, (input, call) =>
        Effect.gen(function* () {
          const bot = yield* bots
            .update({
              commandId: commandIdOf(call.requestId),
              botId: call.caller.botId,
              changes: { profile: input },
            })
            .pipe(refuseFailure);
          return yield* encodeJson(Profile)(bot.profile).pipe(Effect.orDie);
        }),
      ),
    };

    const isToolName = (name: string): name is ToolName => Object.hasOwn(handlers, name);

    const call = Effect.fn("BotTools.call")(function* (request: ToolCallRequest) {
      const caller = yield* sessions.ofEngineSession(request.sessionId);
      if (Option.isNone(caller)) {
        return { _tag: "refused", message: "This is not a J3 Bots session." } as const;
      }
      if (!isToolName(request.tool)) {
        return { _tag: "refused", message: `There is no tool named ${request.tool}.` } as const;
      }
      return yield* handlers[request.tool]({
        requestId: request.requestId,
        caller: caller.value,
        arguments: request.arguments,
      }).pipe(
        Effect.map((value): ToolCallResponse => ({ _tag: "result", value })),
        Effect.catchTag("Refused", (refused) =>
          Effect.succeed<ToolCallResponse>({ _tag: "refused", message: refused.reason }),
        ),
      );
    });

    return BotTools.of({ call });
  }),
);
