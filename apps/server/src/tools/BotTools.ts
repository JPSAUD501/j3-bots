// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  CommandId,
  type FillOutcome,
  MAX_THEME_BACKGROUND_SIZE,
  Profile,
  type Room,
  RoomId,
  Routine,
  type Secret,
  type SavedTheme,
  secretReference,
  type ThemeDefinition,
} from "@j3-bots/contracts";
import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES } from "@j3-bots/design-tokens";
import type { SessionId } from "@j3-bots/engine-t3";
import {
  APP_SHOWN_LINE,
  DECODE_OPTIONS,
  FILL_NOTES,
  inputCapRefusal,
  isConnectorTool,
  THEME_GUIDE,
  THEME_NOTES,
  type ToolInput,
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
import { ConnectorApps } from "../connectors/ConnectorApps.ts";
import {
  type ConnectorCallHooks,
  Connectors,
  type ToolCallAnswer,
  type ToolNotOffered,
} from "../connectors/Connectors.ts";
import { ConnectorInputs } from "../connectors/ConnectorInputs.ts";
import { type CallPlace, ConnectorSteps } from "../turns/ConnectorSteps.ts";
import { Memory } from "../memory/Memory.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Routines } from "../routines/Routines.ts";
import { CredentialFills } from "../secrets/Fill.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { imageTypeOf } from "../attachments/WorkImages.ts";
import { type WorkspaceRead, workspaceReader } from "../attachments/workspaceFile.ts";
import {
  type BackgroundChange,
  MAX_SAVED_THEMES,
  Themes,
  type ThemeRefused,
} from "../themes/Themes.ts";
import { isAnimated } from "../themes/stillImage.ts";
import { type Caller, Management, type ManagementRefused } from "./Management.ts";
import type { ToolCallRequest, ToolCallResponse } from "./protocol.ts";
import {
  RoomReadResult,
  type TurnToolCall,
  TurnToolRefused,
  type TurnToolRetry,
  TurnTools,
} from "./TurnTools.ts";

/** What a handler answers: a value the bridge encodes, or text already framed for the bot. */
type Answered = Extract<ToolCallResponse, { readonly _tag: "result" | "text" }>;

const decodeRoomRead = Schema.decodeUnknownEffect(RoomReadResult);

/** Why a call did nothing, in words the bot reads. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

const encodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.encodeEffect(Schema.toCodecJson(schema));

const isJsonObject = Schema.is(Schema.JsonObject);

/** A fill's outcome as the bot reads it: a status and fixed words, never a value. */
const fillAnswer = (outcome: FillOutcome): Schema.Json =>
  outcome._tag === "filled"
    ? {
        status: "filled",
        submitted: outcome.submitted,
        note: FILL_NOTES[outcome.submitted ? "submitted" : "filled"],
      }
    : { status: "refused", reason: outcome.reason, note: FILL_NOTES[outcome.reason] };

/** The secrets a bot may use as it reads them: references and kinds, never a value. */
const listAnswer = (secrets: ReadonlyArray<Secret>): Schema.Json => ({
  status: "listed",
  secrets: secrets.map((secret) =>
    secret.kind._tag === "login"
      ? {
          reference: secretReference(secret.name),
          kind: "login",
          origins: [...secret.kind.origins],
        }
      : { reference: secretReference(secret.name), kind: "value" },
  ),
  note: FILL_NOTES.listed,
});

/** A theme's definition as `theme_read` gives it: the shape `theme_save` takes. */
const definitionAnswer = (definition: ThemeDefinition): { readonly [key: string]: Schema.Json } => {
  const { name, description, canvas, accent, colors, variants, css } = definition;
  return {
    name,
    ...(description === undefined ? {} : { description }),
    canvas,
    accent,
    ...(colors === undefined ? {} : { colors }),
    ...(variants === undefined
      ? {}
      : {
          variants: {
            ...(variants.light === undefined ? {} : { light: variants.light }),
            ...(variants.dark === undefined ? {} : { dark: variants.dark }),
          },
        }),
    ...(css === undefined ? {} : { css }),
  };
};

/** A theme's definition from `theme_save`'s arguments. */
const definitionOf = (input: ToolInput<"theme_save">): ThemeDefinition => {
  const { name, description, canvas, accent, colors, variants, css } = input;
  return {
    name,
    ...(description === undefined ? {} : { description }),
    canvas,
    accent,
    ...(colors === undefined ? {} : { colors }),
    ...(variants === undefined ? {} : { variants }),
    ...(css === undefined ? {} : { css }),
  };
};

/** Why a background image a bot named cannot be a theme's, in the words `THEME_NOTES.background` takes. */
const BACKGROUND_PROBLEMS: Readonly<Record<Exclude<WorkspaceRead["_tag"], "read">, string>> = {
  missing: "is not in your workspace at that path.",
  outside: "leads out of your workspace: name a file inside it.",
  "not-a-file": "is not a file.",
  "too-large": `is larger than ${MAX_THEME_BACKGROUND_SIZE / (1024 * 1024)} MB: make it smaller first.`,
  unreadable: "could not be read.",
};

const refusedTheme = (id: string, refused: ThemeRefused): string => {
  switch (refused.reason) {
    case "definition":
      return THEME_NOTES.refused(refused.detail);
    case "operator-made":
      return THEME_NOTES.operatorMade(id);
    case "not-yours":
      return THEME_NOTES.notYours(id);
    case "limit":
      return THEME_NOTES.limit(MAX_SAVED_THEMES);
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
    const secrets = yield* Secrets;
    const connectors = yield* Connectors;
    const management = yield* Management;
    const apps = yield* ConnectorApps;
    const inputs = yield* ConnectorInputs;
    const steps = yield* ConnectorSteps;
    const themes = yield* Themes;
    const readWorkspaceFile = yield* workspaceReader;

    /** What a bot's read of a connector reaches: the operator, when the connector's server asks for something. */
    const askFor = (botId: BotId): Pick<ConnectorCallHooks, "ask"> => ({
      ask: (connector, request) => inputs.ask({ botId, connector, request }),
    });

    /**
     * What a bot's call to a connector reaches while it runs: its step, which
     * names the connector and shows how far it got, and the operator, in the
     * bot's conversation, when the connector's server asks for something.
     */
    const hooksFor = (botId: BotId, place: CallPlace): ConnectorCallHooks => ({
      started: ({ connector, ui }) => steps.started(place, { connectorId: connector.id, ui }),
      progress: ({ message, fraction }) =>
        steps.progress(
          place,
          message ?? (fraction === null ? "" : `${Math.round(fraction * 100)}%`),
        ),
      ...askFor(botId),
    });

    const asText = ({ text, isError }: ToolCallAnswer): Answered => ({
      _tag: "text",
      text,
      isError,
    });

    /** A listing's scope as the bot gave it: one connector or every one, and its search. */
    const scopeOf = (input: { readonly connector?: string; readonly search?: string }) => ({
      ...(input.connector === undefined ? {} : { slug: input.connector }),
      ...(input.search === undefined ? {} : { search: input.search }),
    });

    const refuseUnknownConnector = <A, R>(effect: Effect.Effect<A, ToolNotOffered, R>) =>
      Effect.catchTag(
        effect,
        "ToolNotOffered",
        () =>
          new Refused({
            reason:
              "You can use no connector by that name. Name it as its tools' names start, or leave it out to list every connector you can use.",
          }),
      );

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

    /** The image a bot named for its theme's background, read from its workspace and typed by its bytes. */
    const backgroundOf = Effect.fn("BotTools.backgroundOf")(function* (
      root: Option.Option<string>,
      given: string,
    ) {
      if (Option.isNone(root)) {
        return yield* new Refused({ reason: THEME_NOTES.background(BACKGROUND_PROBLEMS.missing) });
      }
      const read = yield* readWorkspaceFile(root.value, given, MAX_THEME_BACKGROUND_SIZE);
      if (read._tag !== "read") {
        return yield* new Refused({
          reason: THEME_NOTES.background(BACKGROUND_PROBLEMS[read._tag]),
        });
      }
      const mediaType = imageTypeOf(read.bytes);
      if (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/webp") {
        return yield* new Refused({
          reason: THEME_NOTES.background("is not a JPEG, PNG or WebP image."),
        });
      }
      if (isAnimated(read.bytes, mediaType)) {
        return yield* new Refused({
          reason: THEME_NOTES.background("is animated, and a theme's background stays still."),
        });
      }
      return { _tag: "set", image: { bytes: read.bytes, mediaType } } satisfies BackgroundChange;
    });

    interface Call {
      readonly requestId: string;
      readonly caller: BotSession;
      /** The engine session the call came from. */
      readonly sessionId: SessionId;
      readonly arguments: Schema.Json;
    }

    /** A handler that decodes its arguments with the tool's schema, then runs. */
    const framedHandler =
      <S extends Schema.Decoder<unknown>, E, R>(
        schema: S,
        run: (input: S["Type"], call: Call) => Effect.Effect<Answered, E, R>,
      ) =>
      (call: Call) =>
        Schema.decodeEffect(schema)(call.arguments, DECODE_OPTIONS).pipe(
          Effect.mapError((error) => new Refused({ reason: error.message })),
          Effect.flatMap((input) => run(input, call)),
        );

    /** A handler whose answer is a value, which the bridge encodes for the bot. */
    const handler = <S extends Schema.Decoder<unknown>, E, R>(
      schema: S,
      run: (input: S["Type"], call: Call) => Effect.Effect<Schema.Json, E, R>,
    ) =>
      framedHandler(schema, (input, call) =>
        Effect.map(run(input, call), (value): Answered => ({ _tag: "result", value })),
      );

    /**
     * Claims a `j3` call for its turn before it acts, so it acts once and
     * only for a running turn: a connector's, or one that changes MCP
     * servers or skills, which the harness ran only once its permission mode
     * let it (decision 0049).
     */
    const claim = (tool: string, call: Call) =>
      turnTools
        .claimConnectorCall({
          tool,
          requestId: call.requestId,
          caller: call.caller,
          arguments: call.arguments,
        })
        .pipe(
          Effect.catchTags({
            TurnEnded: (error) => new Refused({ reason: error.message }),
            CallCutOff: (error) => new Refused({ reason: error.message }),
          }),
        );

    const callerOf = (call: Call): Caller => ({
      botId: call.caller.botId,
      requestId: call.requestId,
    });

    /** A management tool's answer, its refusal in the bot's words. */
    const managed = (effect: Effect.Effect<Schema.Json, ManagementRefused>) =>
      Effect.mapError(effect, (refused) => new Refused({ reason: refused.reason }));

    /** A management tool that changes something: claimed for its turn, then run. */
    const changing = (
      tool: ToolName,
      call: Call,
      run: Effect.Effect<Schema.Json, ManagementRefused>,
    ) => Effect.andThen(claim(tool, call), managed(run));

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
      readonly [N in ToolName]: (call: Call) => Effect.Effect<Answered, Refused | TurnToolRetry>;
    } = {
      say: handler(tools.say.input, (input, call) => admit({ tool: "say", input, ...call })),
      ask: handler(tools.ask.input, (input, call) => admit({ tool: "ask", input, ...call })),
      react: handler(tools.react.input, (input, call) => admit({ tool: "react", input, ...call })),
      request_browser_help: handler(tools.request_browser_help.input, (input, call) =>
        admit({ tool: "request_browser_help", input, ...call }),
      ),
      message_bot: handler(tools.message_bot.input, (input, call) =>
        admit({ tool: "message_bot", input, ...call }),
      ),
      set_routine: handler(tools.set_routine.input, (input, call) =>
        admit({ tool: "set_routine", input, ...call }),
      ),
      finish_step: handler(tools.finish_step.input, (input, call) =>
        admit({ tool: "finish_step", input, ...call }),
      ),
      set_operator_name: handler(tools.set_operator_name.input, (input, call) =>
        admit({ tool: "set_operator_name", input, ...call }),
      ),
      ask_for_secret: handler(tools.ask_for_secret.input, (input, call) =>
        admit({ tool: "ask_for_secret", input, ...call }),
      ),
      list_secrets: handler(tools.list_secrets.input, (_input, { caller }) =>
        secrets.usableBy(caller.botId).pipe(
          Effect.map(listAnswer),
          Effect.catchTag("Conflict", () =>
            Effect.succeed<Schema.Json>({
              status: "unavailable",
              note: FILL_NOTES["secrets-unavailable"],
            }),
          ),
        ),
      ),
      fill_credential: handler(tools.fill_credential.input, (input, call) =>
        logins
          .fillLogin({
            requestId: call.requestId,
            caller: call.caller,
            engineSessionId: call.sessionId,
            secret: input.secret,
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
      list_connector_resources: framedHandler(
        tools.list_connector_resources.input,
        (input, { caller }) =>
          connectors
            .resources({ botId: caller.botId, ...scopeOf(input) })
            .pipe(Effect.map(asText), refuseUnknownConnector),
      ),
      read_connector_resource: framedHandler(
        tools.read_connector_resource.input,
        (input, { caller }) =>
          connectors
            .readResource({
              botId: caller.botId,
              slug: input.connector,
              uri: input.uri,
              hooks: askFor(caller.botId),
            })
            .pipe(Effect.map(asText), refuseUnknownConnector),
      ),
      list_connector_events: framedHandler(tools.list_connector_events.input, (input, { caller }) =>
        connectors
          .events({ botId: caller.botId, ...scopeOf(input) })
          .pipe(Effect.map(asText), refuseUnknownConnector),
      ),
      list_connector_prompts: framedHandler(
        tools.list_connector_prompts.input,
        (input, { caller }) =>
          connectors
            .prompts({ botId: caller.botId, ...scopeOf(input) })
            .pipe(Effect.map(asText), refuseUnknownConnector),
      ),
      get_connector_prompt: framedHandler(tools.get_connector_prompt.input, (input, { caller }) =>
        connectors
          .getPrompt({
            botId: caller.botId,
            slug: input.connector,
            name: input.name,
            arguments: input.arguments ?? {},
            hooks: askFor(caller.botId),
          })
          .pipe(Effect.map(asText), refuseUnknownConnector),
      ),
      list_connector_skills: framedHandler(tools.list_connector_skills.input, (input, { caller }) =>
        connectors
          .skills({ botId: caller.botId, ...scopeOf(input) })
          .pipe(Effect.map(asText), refuseUnknownConnector),
      ),
      // Loading a skill asks first, as the bot's permission mode says: what
      // it says becomes the bot's instructions for the task (decision 0089).
      use_connector_skill: framedHandler(tools.use_connector_skill.input, (input, call) =>
        Effect.flatMap(claim("use_connector_skill", call), (place) =>
          connectors
            .loadSkill({
              botId: call.caller.botId,
              slug: input.connector,
              skill: input.skill,
              started: (connector) => steps.started(place, { connectorId: connector.id, ui: null }),
            })
            .pipe(Effect.map(asText), refuseUnknownConnector),
        ),
      ),
      read_connector_skill_file: framedHandler(
        tools.read_connector_skill_file.input,
        (input, { caller }) =>
          connectors
            .readSkillFile({
              botId: caller.botId,
              slug: input.connector,
              skill: input.skill,
              path: input.path,
            })
            .pipe(Effect.map(asText), refuseUnknownConnector),
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
          const all = yield* store.list;
          const teammates = all
            .filter(({ bot }) => bot.id !== caller.botId)
            .map(({ bot }) => ({
              id: bot.id,
              name: bot.profile.name,
              title: bot.profile.title,
              job: bot.profile.job,
              listed: !bot.hidden,
            }));
          const listed = (room: Room) => ({
            id: room.id,
            name: room.name,
            members: [...room.members],
            archived: room.status === "archived",
            listed: !room.hidden,
            // A room of bots only, which the operator reads and never writes in.
            withUser: room.botsOnly !== true,
          });
          const primary = all.some(({ bot }) => bot.id === caller.botId && bot.primary);
          // The primary bot may show or hide any room, so it is told of those
          // it is not in too: their names and members, never what they say.
          const everyRoom = primary ? yield* rooms.list : yield* rooms.ofBot(caller.botId);
          const isMember = (room: Room) => room.members.includes(caller.botId);
          const others = everyRoom.filter((room) => !isMember(room)).map(listed);
          return {
            teammates,
            rooms: everyRoom.filter(isMember).map(listed),
            ...(primary ? { otherRooms: others } : {}),
          } satisfies Schema.Json;
        }),
      ),
      start_room: handler(tools.start_room.input, (input, call) =>
        admit({ tool: "start_room", input, ...call }),
      ),
      // The read is framed as envelopes frame room entries: the bot gets its text.
      read_room: framedHandler(tools.read_room.input, (input, call) =>
        admit({ tool: "read_room", input, ...call }).pipe(
          Effect.flatMap((value) => decodeRoomRead(value).pipe(Effect.orDie)),
          Effect.map(({ text }): Answered => ({ _tag: "text", text, isError: false })),
        ),
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
                bots
                  .create({
                    commandId: commandIdOf(call.requestId),
                    draft: {
                      name: input.name,
                      title: input.title,
                      ...(input.job === undefined ? {} : { job: input.job }),
                      hidden: !input.listed,
                    },
                    madeBy,
                  })
                  .pipe(
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
      search_mcp_servers: handler(tools.search_mcp_servers.input, (input, call) =>
        managed(management.searchServers(callerOf(call), input)),
      ),
      list_mcp_servers: handler(tools.list_mcp_servers.input, (_input, call) =>
        managed(management.listServers(callerOf(call))),
      ),
      // A server that needs the operator's yes asks it on a card, which wakes
      // the bot for the audience of the turn that asked.
      add_mcp_server: handler(tools.add_mcp_server.input, (input, call) =>
        Effect.flatMap(claim("add_mcp_server", call), (place) =>
          managed(
            management.addServer(
              {
                ...callerOf(call),
                turn: {
                  sessionId: place.sessionId,
                  botId: call.caller.botId,
                  turnId: place.turnId,
                  audience: place.audience,
                },
              },
              input,
            ),
          ),
        ),
      ),
      update_mcp_server: handler(tools.update_mcp_server.input, (input, call) =>
        changing("update_mcp_server", call, management.updateServer(callerOf(call), input)),
      ),
      remove_mcp_server: handler(tools.remove_mcp_server.input, (input, call) =>
        changing("remove_mcp_server", call, management.removeServer(callerOf(call), input)),
      ),
      set_mcp_server_bots: handler(tools.set_mcp_server_bots.input, (input, call) =>
        changing("set_mcp_server_bots", call, management.setServerBots(callerOf(call), input)),
      ),
      list_skills: handler(tools.list_skills.input, (_input, call) =>
        managed(management.listSkills(callerOf(call))),
      ),
      save_skill: handler(tools.save_skill.input, (input, call) =>
        changing("save_skill", call, management.saveSkill(callerOf(call), input)),
      ),
      install_skill: handler(tools.install_skill.input, (input, call) =>
        changing("install_skill", call, management.installSkill(callerOf(call), input)),
      ),
      remove_skill: handler(tools.remove_skill.input, (input, call) =>
        changing("remove_skill", call, management.removeSkill(callerOf(call), input)),
      ),
      theme_read: handler(tools.theme_read.input, (input, { caller }) =>
        Effect.gen(function* () {
          const library = yield* themes.library;
          const maker = (theme: SavedTheme) =>
            theme.madeBy._tag === "operator"
              ? "your user"
              : theme.madeBy.botId === caller.botId
                ? "you"
                : "another bot";
          const builtIn = BUILT_IN_THEME_IDS.find((id) => id === input.theme);
          const asked =
            input.theme === undefined
              ? undefined
              : builtIn !== undefined
                ? { id: builtIn, ...definitionAnswer(BUILT_IN_THEMES[builtIn]) }
                : yield* themes.find(input.theme).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () =>
                          new Refused({
                            reason: `There is no theme ${input.theme}. Call \`theme_read\` without \`theme\` to list them.`,
                          }),
                        onSome: (theme) =>
                          Effect.succeed({
                            id: theme.id,
                            ...definitionAnswer(theme.definition),
                            hasBackground: theme.background !== null,
                          }),
                      }),
                    ),
                  );
          return {
            guide: THEME_GUIDE,
            builtIn: BUILT_IN_THEME_IDS.map((id) => ({
              id,
              name: BUILT_IN_THEMES[id].name,
              description: BUILT_IN_THEMES[id].description ?? "",
            })),
            saved: library.themes.map((theme) => ({
              id: theme.id,
              name: theme.definition.name,
              madeBy: maker(theme),
              hasBackground: theme.background !== null,
            })),
            defaultTheme: library.defaultTheme,
            ...(asked === undefined ? {} : { theme: asked }),
          } satisfies Schema.Json;
        }),
      ),
      theme_save: handler(tools.theme_save.input, (input, call) =>
        Effect.gen(function* () {
          const self = yield* store.find(call.caller.botId);
          if (Option.isNone(self)) return yield* new Refused({ reason: "You are not a bot here." });
          const background: BackgroundChange =
            input.background === undefined
              ? { _tag: "keep" }
              : input.background === null
                ? { _tag: "remove" }
                : yield* backgroundOf(self.value.workspaceRoot, input.background);
          const saved = yield* themes
            .saveFromBot({
              commandId: commandIdOf(call.requestId),
              botId: call.caller.botId,
              primary: self.value.bot.primary,
              themeId: input.id,
              definition: definitionOf(input),
              background,
            })
            .pipe(
              Effect.catchTags({
                ThemeRefused: (refused) => new Refused({ reason: refusedTheme(input.id, refused) }),
                Conflict: (error) => new Refused({ reason: error.message }),
              }),
            );
          return {
            status: "saved",
            id: saved.theme.id,
            adjustments: saved.adjustments.map((a) => ({ ...a })),
            note: THEME_NOTES.saved,
          } satisfies Schema.Json;
        }),
      ),
      // A bot or a room, by its id: bots are looked up first, as ids of both
      // kinds are never the same (`Ids`). Both store one receipt
      // (`visibilityCommand`), so a retry finds its result either way. The
      // server keeps the operator's word for it, hidden; the bot reads listed.
      set_listed: handler(tools.set_listed.input, (input, call) =>
        Effect.gen(function* () {
          const commandId = commandIdOf(call.requestId);
          const botId = BotId.make(input.id);
          const hidden = !input.listed;
          if (Option.isSome(yield* store.find(botId))) {
            const shown = yield* bots
              .showOrHide({ commandId, caller: call.caller.botId, botId, hidden })
              .pipe(refuseFailure);
            return { id: shown.id, listed: !shown.hidden } satisfies Schema.Json;
          }
          const shown = yield* rooms
            .showOrHide({
              commandId,
              caller: call.caller.botId,
              roomId: RoomId.make(input.id),
              hidden,
            })
            .pipe(
              Effect.catchTag(
                "NotFound",
                () =>
                  new Refused({
                    reason: `Nothing changed: no bot or room has the id ${input.id}. \`list_teammates\` shows them now.`,
                  }),
              ),
              refuseFailure,
            );
          return { id: shown.id, listed: !shown.hidden } satisfies Schema.Json;
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
      const place = yield* claim(tool, call);
      const answer = yield* connectors
        .call({
          botId: call.caller.botId,
          name: tool,
          arguments: input,
          hooks: hooksFor(call.caller.botId, place),
        })
        .pipe(Effect.catchTag("ToolNotOffered", (error) => new Refused({ reason: error.message })));
      if (Option.isNone(answer.app)) return answer;
      const shown = yield* apps.record({
        place,
        botId: call.caller.botId,
        input,
        app: answer.app.value,
      });
      // The bot reads that its user sees the app, only once it is shown.
      return shown ? { ...answer, text: `${answer.text}\n${APP_SHOWN_LINE}` } : answer;
    });

    const answer = (
      tool: string,
      call: Call,
    ): Effect.Effect<ToolCallResponse, Refused | TurnToolRetry> => {
      if (isToolName(tool)) return handlers[tool](call);
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
