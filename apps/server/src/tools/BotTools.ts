// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, CommandId, type FillOutcome, Profile, Routine } from "@j3-bots/contracts";
import type { SessionId } from "@j3-bots/engine-t3";
import {
  DECODE_OPTIONS,
  FILL_NOTES,
  inputCapRefusal,
  isConnectorTool,
  type ToolName,
  tools,
} from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import { type BotSession, EngineSessions } from "../bots/EngineSessions.ts";
import { Connectors } from "../connectors/Connectors.ts";
import { Memory } from "../memory/Memory.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Routines } from "../routines/Routines.ts";
import { CredentialFills, type ListAnswer } from "../vault/Fill.ts";
import type { ToolCallRequest, ToolCallResponse } from "./protocol.ts";
import { type TurnToolCall, TurnToolRefused, type TurnToolRetry, TurnTools } from "./TurnTools.ts";

/** Why a call did nothing, in words the bot reads. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

const encodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.encodeEffect(Schema.toCodecJson(schema));

const isJsonObject = Schema.is(Schema.JsonObject);

/** A fill's outcome as the bot reads it: a status and fixed words, never a value. */
const fillAnswer = (outcome: FillOutcome): Schema.Json => {
  switch (outcome._tag) {
    case "filled":
      return {
        status: "filled",
        submitted: outcome.submitted,
        note: FILL_NOTES[outcome.submitted ? "submitted" : "filled"],
      };
    case "refused":
      return { status: "refused", reason: outcome.reason, note: FILL_NOTES[outcome.reason] };
    case "locked":
      return { status: "locked", note: FILL_NOTES.locked };
  }
};

const listAnswer = (answer: ListAnswer): Schema.Json => {
  switch (answer._tag) {
    case "listed":
      return {
        status: "listed",
        credentials: answer.credentials.map((credential) => ({
          name: credential.name,
          origins: [...credential.origins],
        })),
        note: FILL_NOTES.listed,
      };
    case "refused":
      return { status: "refused", reason: answer.reason, note: FILL_NOTES[answer.reason] };
    case "locked":
      return { status: "locked", note: FILL_NOTES.locked };
  }
};

/**
 * The `j3` tools' server side. A call is accepted only from a live session of
 * a bot, with arguments that decode under the tool's own schema. The tools
 * that act for a turn go to `TurnTools`; the rest are answered here. A
 * connector tool's call is made only for a bot it is offered to, once it is
 * claimed for the bot's running turn, and what the connector answers goes
 * back as it is (`Connectors` frames it). A call that could not be matched to
 * its turn yet fails with `TurnToolRetry`, for the bridge to forward again.
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
    const logins = yield* CredentialFills;
    const connectors = yield* Connectors;

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
      /** The engine session the call came from. */
      readonly sessionId: SessionId;
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
      request_browser_help: handler(tools.request_browser_help.input, (input, call) =>
        admit({ tool: "request_browser_help", input, ...call }),
      ),
      message_bot: handler(tools.message_bot.input, (input, call) =>
        admit({ tool: "message_bot", input, ...call }),
      ),
      set_routine: handler(tools.set_routine.input, (input, call) =>
        admit({ tool: "set_routine", input, ...call }),
      ),
      set_operator_name: handler(tools.set_operator_name.input, (input, call) =>
        admit({ tool: "set_operator_name", input, ...call }),
      ),
      request_credential: handler(tools.request_credential.input, (input, call) =>
        admit({ tool: "request_credential", input, ...call }),
      ),
      list_credentials: handler(tools.list_credentials.input, (_input, { caller }) =>
        logins.list(caller.botId).pipe(Effect.map(listAnswer)),
      ),
      fill_credential: handler(tools.fill_credential.input, (input, call) =>
        logins
          .fillLogin({
            requestId: call.requestId,
            caller: call.caller,
            engineSessionId: call.sessionId,
            credential: input.credential,
            field: input.field,
            submit: input.submit ?? false,
            arguments: call.arguments,
          })
          .pipe(
            Effect.map(fillAnswer),
            Effect.catchTags({
              TurnEnded: (error) => new Refused({ reason: error.message }),
              TurnToolRefused: (error) => new Refused({ reason: error.message }),
              Conflict: (error) => new Refused({ reason: error.message }),
            }),
          ),
      ),
      suggest_connector: handler(tools.suggest_connector.input, (input, call) =>
        admit({ tool: "suggest_connector", input, ...call }),
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
      start_room: handler(tools.start_room.input, (input, call) =>
        admit({ tool: "start_room", input, ...call }),
      ),
      // A turn tool of its own: the bot is saved with the call's pin on its
      // turn, which only this service's `Bots` can do.
      create_bot: handler(tools.create_bot.input, (input, call) =>
        Effect.gen(function* () {
          yield* requirePrimary(call.caller);
          return yield* turnTools
            .createBot({
              requestId: call.requestId,
              caller: call.caller,
              arguments: call.arguments,
              create: (madeBy) =>
                bots.create({ commandId: commandIdOf(call.requestId), draft: input, madeBy }).pipe(
                  Effect.map((bot) => bot.id),
                  Effect.catchTags({
                    NotFound: (error) => new TurnToolRefused({ reason: error.message }),
                    Invalid: (error) => new TurnToolRefused({ reason: error.message }),
                    Conflict: (error) => new TurnToolRefused({ reason: error.message }),
                  }),
                ),
            })
            .pipe(
              Effect.catchTags({
                TurnEnded: (error) => new Refused({ reason: error.message }),
                TurnToolRefused: (error) => new Refused({ reason: error.message }),
                Conflict: (error) => new Refused({ reason: error.message }),
              }),
            );
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

    /**
     * A connector tool's call. Its arguments are checked before anything is
     * claimed, and the call is claimed for its turn before it is made, so it
     * is made once and only for a running turn; `Connectors` decides whether
     * the bot is offered the tool. Interrupting the call (the bridge's
     * harness gave up on it) abandons it at the connector.
     */
    const connectorCall = Effect.fn("BotTools.connectorCall")(function* (tool: string, call: Call) {
      const input = call.arguments;
      if (!isJsonObject(input)) {
        return yield* new Refused({ reason: "The arguments must be an object." });
      }
      const tooLarge = inputCapRefusal(input);
      if (tooLarge !== undefined) return yield* new Refused({ reason: tooLarge });
      yield* turnTools
        .claimConnectorCall({
          tool,
          requestId: call.requestId,
          caller: call.caller,
          arguments: input,
        })
        .pipe(
          Effect.catchTags({
            TurnEnded: (error) => new Refused({ reason: error.message }),
            CallCutOff: (error) => new Refused({ reason: error.message }),
          }),
        );
      return yield* connectors
        .call({ botId: call.caller.botId, name: tool, arguments: input })
        .pipe(Effect.catchTag("ToolNotOffered", (error) => new Refused({ reason: error.message })));
    });

    const answer = (
      tool: string,
      call: Call,
    ): Effect.Effect<ToolCallResponse, Refused | TurnToolRetry> => {
      if (isToolName(tool)) {
        return handlers[tool](call).pipe(Effect.map((value) => ({ _tag: "result", value })));
      }
      if (isConnectorTool(tool)) {
        return connectorCall(tool, call).pipe(
          Effect.map(({ text, isError }) => ({ _tag: "text", text, isError })),
        );
      }
      return Effect.fail(new Refused({ reason: `There is no tool named ${tool}.` }));
    };

    const call = Effect.fn("BotTools.call")(function* (request: ToolCallRequest) {
      const caller = yield* sessions.ofEngineSession(request.sessionId);
      if (Option.isNone(caller)) {
        return { _tag: "refused", message: "This is not a J3 Bots session." } as const;
      }
      return yield* answer(request.tool, {
        requestId: request.requestId,
        caller: caller.value,
        sessionId: request.sessionId,
        arguments: request.arguments,
      }).pipe(
        Effect.catchTag("Refused", (refused) =>
          Effect.succeed<ToolCallResponse>({ _tag: "refused", message: refused.reason }),
        ),
      );
    });

    return BotTools.of({ call });
  }),
);
