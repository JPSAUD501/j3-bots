// SPDX-License-Identifier: AGPL-3.0-or-later
import { Avatar, Profile, RoutineInstruction } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The `j3` MCP tools a bot acts through. A tool's description is prompt text:
 * it is where the model learns what the tool is for, when to call it and what
 * comes back. See `docs/prompts/architecture.md#tools`.
 *
 * Each input schema is what the server's bridge decodes a call's arguments
 * with, using {@link DECODE_OPTIONS}. {@link toolList} is the same set in the
 * shape MCP's `tools/list` returns.
 */

/** Unknown arguments are refused rather than ignored, matching `additionalProperties: false`. */
export const DECODE_OPTIONS = { onExcessProperty: "error" } as const;

/**
 * The most a call's arguments may weigh, as UTF-8 JSON. The engine replaces a
 * tool input over 16,384 bytes with a one-line summary before any client sees
 * it (**Read** at `db51b67`, `WireProjection.ts`, `summarizeDynamicValue`),
 * and the server could then no longer match the call to the engine's record of
 * it. The margin covers the engine encoding the input differently.
 */
export const MAX_TOOL_INPUT_BYTES = 12_288;

/** The most a bot's message may hold, so a call fits {@link MAX_TOOL_INPUT_BYTES}. */
const MAX_SPOKEN_TEXT = 4_000;

const inputBytes = (input: unknown): number =>
  new TextEncoder().encode(JSON.stringify(input)).length;

/** Refuses a call too large for the engine to record, telling the bot how to fit it. */
const withinInputCap = Schema.makeFilter((input: object) => {
  const bytes = inputBytes(input);
  return bytes <= MAX_TOOL_INPUT_BYTES
    ? true
    : `The arguments are ${bytes} bytes; a call carries at most ${MAX_TOOL_INPUT_BYTES}. Split a long message into several calls, put long content in a file and attach it, or shorten the field.`;
});

/** A tool's arguments: the named fields, within {@link MAX_TOOL_INPUT_BYTES}. */
const toolInput = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).check(withinInputCap);

/**
 * What a bot reads when the server refuses a call it could not match to a
 * running turn of the bot's session. A subagent's call is one: the engine
 * records it on the subagent's own thread, never in the bot's turn.
 */
export const NO_TURN_REFUSAL =
  "This call belongs to no running turn of yours: your turn has ended, or you are a subagent or delegated worker. Nothing was sent. A subagent or delegated worker reports in its final reply instead.";

/** For the three tools a delegated worker can see but must not use. */
const BOT_ONLY =
  "Only the bot itself calls this. A subagent or delegated worker does not: it reports in its final reply.";

const text = (min: number, max: number) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

/** An id as `list_teammates` or `list_routines` returns it. */
const Id = text(1, 128);

const NoInput = Schema.Record(Schema.String, Schema.Never);

const MemoryScope = Schema.Literals(["bot", "shared"]);

const SayInput = toolInput({
  text: described(
    text(1, MAX_SPOKEN_TEXT),
    `The message, written for your user to read. At most ${MAX_SPOKEN_TEXT} characters: send a longer result in parts, or as a file.`,
  ),
  attachments: Schema.optionalKey(
    described(
      Schema.Array(text(1, 1_024)).check(Schema.isMaxLength(10)),
      "Files to attach: paths in your workspace, usually under files/.",
    ),
  ),
  to: Schema.optionalKey(
    described(
      Schema.Literal("dm"),
      "Only during a room turn: send privately to your user instead of to the room.",
    ),
  ),
  done: Schema.optionalKey(
    described(
      Schema.Boolean,
      "True when this message delivers the result. It closes the delivery; end your turn once it returns.",
    ),
  ),
});

const AskOption = Schema.Struct({
  label: described(text(1, 200), "What the button says."),
  value: Schema.optionalKey(
    described(text(1, 200), "Returned with the answer instead of the label, if given."),
  ),
  description: Schema.optionalKey(
    described(text(1, 1_000), "One line under the label, when the label needs it."),
  ),
  style: Schema.optionalKey(
    described(
      Schema.Literals(["recommended", "destructive"]),
      "Mark the option you recommend, or one that deletes or cannot be undone.",
    ),
  ),
});

const AskInput = toolInput({
  prompt: described(text(1, 2_000), "The question, in one or two sentences."),
  options: described(
    Schema.Array(AskOption).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    "One to six real choices.",
  ),
  allow_custom: Schema.optionalKey(
    described(Schema.Boolean, "Also accept a typed answer. Defaults to false."),
  ),
  multi_select: Schema.optionalKey(
    described(Schema.Boolean, "Allow more than one option. Defaults to false."),
  ),
});

const MessageBotInput = toolInput({
  to: described(Id, "The teammate's bot id, or the id of a room you are in."),
  text: described(
    text(1, MAX_SPOKEN_TEXT),
    `The actionable point, in at most ${MAX_SPOKEN_TEXT} characters.`,
  ),
  urgent: described(
    Schema.Boolean,
    "True when they must act now or someone is waiting. Otherwise it waits for their next turn.",
  ),
});

const RememberInput = toolInput({
  fact: described(text(1, 1_000), "One self-contained sentence."),
  tier: Schema.optionalKey(
    described(Schema.Literals(["pinned", "log"]), "Defaults to log.").annotate({
      default: "log",
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed("log" as const))),
  scope: Schema.optionalKey(
    described(MemoryScope, "Defaults to bot.").annotate({ default: "bot" }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed("bot" as const))),
});

const ForgetInput = toolInput({
  fact: described(text(1, 1_000), "The fact exactly as it was recorded."),
  scope: Schema.optionalKey(
    described(MemoryScope, "Defaults to bot.").annotate({ default: "bot" }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed("bot" as const))),
});

const RecallInput = toolInput({
  query: described(text(1, 500), "Words or a question to search for."),
  scope: Schema.optionalKey(
    described(MemoryScope, "Search only your own memory or only the shared facts."),
  ),
  limit: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
      "Most results to return. Defaults to 10.",
    ).annotate({ default: 10 }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(10))),
});

/** Five fields separated by spaces. The server checks the fields themselves. */
const Cron = text(9, 200).check(Schema.isPattern(/^\S+(?:\s+\S+){4}$/));

/** A local time without a zone, or a time with an offset. */
const LocalTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/),
);

const RoutineAction = Schema.Literals(["create", "update", "pause", "resume", "delete"]);

const SetRoutineFields = toolInput({
  action: RoutineAction,
  id: Schema.optionalKey(described(Id, "The routine's id. Required except for create.")),
  name: Schema.optionalKey(described(text(1, 200), "A short name your user will recognize.")),
  instruction: Schema.optionalKey(
    described(RoutineInstruction, "The complete brief a run starts from."),
  ),
  schedule: Schema.optionalKey(
    described(Cron, "Five-field cron, in your user's time zone: 3 8 * * 1-5."),
  ),
  at: Schema.optionalKey(
    described(LocalTime, "One run at this local time in your user's zone: 2026-11-21T09:00."),
  ),
  webhook: Schema.optionalKey(
    described(Schema.Literal(true), "Run whenever the routine's address receives a request."),
  ),
});

type SetRoutineFields = typeof SetRoutineFields.Type;

const triggerCount = (input: SetRoutineFields): number =>
  [input.schedule, input.at, input.webhook].filter((trigger) => trigger !== undefined).length;

/** The combinations a flat MCP schema cannot express, checked on decode. */
const routineCallProblem = (input: SetRoutineFields): string | undefined => {
  if (triggerCount(input) > 1) return "Give at most one of schedule, at and webhook";
  if (input.action === "create") {
    if (input.id !== undefined) return "create takes no id";
    if (input.name === undefined || input.instruction === undefined) {
      return "create needs a name and an instruction";
    }
    if (triggerCount(input) === 0) return "create needs one of schedule, at and webhook";
    return undefined;
  }
  if (input.id === undefined) return `${input.action} needs the routine's id`;
  const changes = [input.name, input.instruction].filter((field) => field !== undefined).length;
  if (input.action === "update") {
    return changes + triggerCount(input) === 0
      ? "update needs a name, an instruction or a trigger to change"
      : undefined;
  }
  if (changes > 0 || triggerCount(input) > 0) return `${input.action} takes only an id`;
  return undefined;
};

const SetRoutineInput = SetRoutineFields.check(
  Schema.makeFilter((input) => routineCallProblem(input) ?? true),
);

const CreateBotInput = toolInput({
  name: Profile.fields.name,
  title: Schema.optionalKey(described(Profile.fields.title, "A short role, such as Research.")),
  job: Schema.optionalKey(
    described(Profile.fields.job, "What the bot is for and where its limits are."),
  ),
});

const UpdateBotInput = toolInput({
  id: described(Id, "The teammate's bot id."),
  name: Schema.optionalKey(Profile.fields.name),
  title: Schema.optionalKey(Profile.fields.title),
  job: Schema.optionalKey(Profile.fields.job),
});

const UpdateProfileInput = toolInput({
  name: Schema.optionalKey(Profile.fields.name),
  title: Schema.optionalKey(Profile.fields.title),
  avatar: Schema.optionalKey(
    described(Avatar, "The shape and color your user chose, by the names they gave."),
  ),
});

/** One `j3` tool: its name, its description as prompt text, and the schema its arguments decode with. */
export interface ToolDefinition<S extends Schema.Top = Schema.Top> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
}

const define = <S extends Schema.Top>(
  name: string,
  description: ReadonlyArray<string>,
  input: S,
): ToolDefinition<S> => ({ name, description: description.join(" "), input });

/** The `j3` tools, keyed by name. */
export const tools = {
  say: define(
    "say",
    [
      "Send a message to your user. This is the only way they hear you: reply text outside this tool reaches nobody.",
      'During a room turn it goes to the room; `to: "dm"` sends it to your user privately instead.',
      "Attach files you produced, rather than linking workspace paths they cannot open.",
      "Set `done: true` on the message that delivers the result, after every other call has returned, then end your turn.",
      "Returns once the message is recorded.",
      BOT_ONLY,
    ],
    SayInput,
  ),
  ask: define(
    "ask",
    [
      "Put one question to your user as a card with options to tap.",
      "Use it when a wrong guess would cost something real or only they know the answer; otherwise decide, and say what you assumed.",
      "Calling it ends your turn: their answer arrives as your next turn, and a dismissed card means no. Do not ask the same thing again.",
      "Not in a routine run: put the question in a `say` there.",
      BOT_ONLY,
    ],
    AskInput,
  ),
  message_bot: define(
    "message_bot",
    [
      "Send a message to a teammate, or to a room you are in, by an id from `list_teammates`.",
      "It is also how you answer a teammate: in a `bot` turn, `say` reaches your user, not the sender.",
      "Returns an acknowledgement only. A reply, if any, arrives later as its own turn.",
      "Every message wakes another bot and spends your user's allowance: send it only when it serves what your user wants, and never to answer a thanks or an FYI.",
      BOT_ONLY,
    ],
    MessageBotInput,
  ),
  remember: define(
    "remember",
    [
      "Record one fact in memory, as a sentence that will make sense on its own later: names and dates, not 'he' or 'yesterday'.",
      "`pinned` is for standing rules and preferences that shape every answer; it is loaded with your instructions from your next session on and paid for on every turn, so keep it small.",
      "`log` is for decisions, outcomes and one-off facts, found later with `recall`.",
      "`shared` scope is for facts about your user that their other bots need.",
      "A duplicate is ignored. Text that looks like a password, key or card number is refused; credentials go through `request_secret`.",
      "Returns whether the fact was recorded.",
    ],
    RememberInput,
  ),
  forget: define(
    "forget",
    [
      "Remove one fact from memory. Give it exactly as recorded (`recall` shows it) and in the scope it was recorded in.",
      "To correct a fact, forget the old version and remember the new one.",
      "Returns whether a fact was removed.",
    ],
    ForgetInput,
  ),
  recall: define(
    "recall",
    [
      "Search your memory log and the shared facts about your user.",
      "Use it before asking your user to repeat something, and when a task touches earlier decisions.",
      "Returns matching facts with their dates, most relevant first.",
      "Memory goes stale: check anything that changes, such as a price or a status, at its source again.",
    ],
    RecallInput,
  ),
  set_routine: define(
    "set_routine",
    [
      "Create, change, pause, resume or delete one of your routines: a saved instruction that runs on a schedule, once at a set time, or when a webhook is called.",
      "Check `list_routines` first and change an existing routine rather than adding a second.",
      "`create` takes a name, an instruction and exactly one of `schedule`, `at` or `webhook`; the other actions take the routine's id, and `update` also takes the fields that change.",
      "Times are in your user's zone, and a schedule runs at most every five minutes.",
      "During a routine run the only call allowed is `pause` of that routine, so it can stop itself once its job is done.",
      "Each run starts in a fresh session without this conversation, so the instruction must stand alone: what to look at, what counts as worth reporting, the names, places and thresholds involved, and a last line saying what to send your user and what to do when there is nothing new.",
      "Returns the routine as saved, with its id and next run; tell your user the exact schedule.",
    ],
    SetRoutineInput,
  ),
  list_routines: define(
    "list_routines",
    [
      "List your routines with their ids, instructions, triggers, whether each is paused, and their last runs.",
      "Check it before creating a routine, so you change one instead of duplicating it.",
    ],
    NoInput,
  ),
  list_teammates: define(
    "list_teammates",
    [
      "List your user's other bots, with id, name, title and job, and the rooms you are in, with id, name and members.",
      "Use the ids with `message_bot`.",
    ],
    NoInput,
  ),
  create_bot: define(
    "create_bot",
    [
      "Create a new teammate for your user. Only the primary bot can, and only when your user asked for one or agreed to it.",
      "The job says what the bot is for and where its limits end, in a few sentences; how every bot behaves comes from J3 Bots, not the job.",
      "Returns the new bot's id.",
    ],
    CreateBotInput,
  ),
  update_bot: define(
    "update_bot",
    [
      "Change a teammate's name, title or job, by its id. Only the primary bot can, and only when your user asked for the change.",
      "Returns the teammate's profile as saved.",
    ],
    UpdateBotInput,
  ),
  update_profile: define(
    "update_profile",
    [
      "Change your own name, title or avatar, only when your user asks you to.",
      "Your user sees the change at once; your instructions show it from your next session on.",
      "Returns your profile as saved.",
    ],
    UpdateProfileInput,
  ),
} as const;

export type ToolName = keyof typeof tools;

/** The decoded arguments of each tool, as the server receives them. */
export type ToolInput<N extends ToolName> = (typeof tools)[N]["input"]["Type"];

/** A tool as MCP's `tools/list` describes it. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly [key: string]: unknown };
}

const toMcpTool = (tool: ToolDefinition): McpTool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: Schema.toJsonSchemaDocument(tool.input, DECODE_OPTIONS).schema,
});

/** Every `j3` tool in the shape MCP's `tools/list` returns, in table order. */
export const toolList: ReadonlyArray<McpTool> = Object.values(tools).map(toMcpTool);
