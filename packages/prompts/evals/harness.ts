// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, Routine, RoutineId, RoutineRunId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  type BotInstructionsInput,
  DECODE_OPTIONS,
  renderSystemFile,
  renderWake,
  type RoutineWake,
  sharedSkills,
  type ToolInput,
  toolList,
  tools,
  type Wake,
} from "../src/index.ts";
import type { FixtureEvent, GhEvent } from "./fixtures.ts";
import { complete, type FunctionTool, type Message } from "./model.ts";
import { localInstant, nextScheduled, plannedRun, type Trigger } from "./schedule.ts";
import type { Workspace } from "./shell.ts";

/**
 * One bot turn against a real model, with the bot's tools answered by stubs.
 *
 * The model gets what a bot's session gives it: the rendered base prompt,
 * profile and pinned memory, one wake envelope, and the `j3` tools as MCP
 * lists them. Two things stand in for the harness: the shipped skills, given
 * as already read when a run includes them (the harness's own listing and
 * reading of them is not what is measured), and `run_command`, a stand-in
 * shell whose workspace and programs the scenario fixes (`shell.ts`,
 * `fixtures.ts`).
 *
 * Every case runs with the skills and without them. Nothing links them into a
 * harness yet, and a session that never reads one still has to behave, so a
 * case that fails only without them shows a rule missing from the base prompt,
 * the tool descriptions or the envelope.
 */

/** A fictional operator and bot. */
const bot = (model: string): BotInstructionsInput => ({
  operator: { name: "Rui", timeZone: "Europe/Lisbon" },
  profile: {
    name: "Juniper",
    title: "Docs",
    job: "Look after the Acme documentation site and its GitHub repository, acme/docs: watch its builds and pull requests, and tell Rui what needs his attention.",
    primary: false,
  },
  runtime: { model, harness: model.startsWith("gpt") ? "Codex" : "Claude Code" },
  pinned: { shared: "- Rui reads messages on his phone; keep them short.", bot: "" },
});

/** Whether a turn has the shipped skills as already read. */
export type Skills = "with the skill" | "without the skill";

const systemPrompt = (model: string, skills: Skills): string =>
  [
    renderSystemFile(bot(model)),
    ...(skills === "with the skill" ? sharedSkills : []).map(
      (skill) => `# You read the skill skills/${skill.name}/SKILL.md\n\n${skill.text}`,
    ),
  ].join("\n\n---\n\n");

const HOST_TOOL = "run_command";

/** The `j3` tools, and a `run_command` that names what the workspace has. */
const functionTools = (commands: ReadonlyArray<string>): ReadonlyArray<FunctionTool> => [
  ...toolList.map((tool): FunctionTool => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  })),
  {
    type: "function",
    function: {
      name: HOST_TOOL,
      description: `Run a shell command in your workspace and return its output. The GitHub CLI, gh, is signed in. The workspace has only these commands: ${commands.join(", ")}.`,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

/** A tool the model called, with its arguments as it sent them. */
export interface Call {
  /** The model message it came in, counted from 1: calls with the same step were sent together. */
  readonly step: number;
  readonly name: string;
  readonly input: unknown;
  /** For a `set_routine` call the schema accepted, its arguments as decoded: what the server would save. */
  readonly routine?: ToolInput<"set_routine">;
  /** What the call answered. */
  readonly output: string;
  /** For a `set_routine` call, true when the server would have refused it. */
  readonly refused?: boolean;
  /** For a `run_command` call, what the command did in the workspace; empty for any other call. */
  readonly events: ReadonlyArray<FixtureEvent>;
}

/** Reply text the model wrote beside or instead of its calls. It reaches nobody. */
interface ReplyText {
  readonly step: number;
  readonly text: string;
}

/** One turn: the tools the model called, in order, the reply text it wrote, and its workspace as the turn left it. */
export interface Turn {
  readonly calls: ReadonlyArray<Call>;
  readonly text: ReadonlyArray<ReplyText>;
  readonly workspace: Workspace<GhEvent>;
}

/**
 * A turn as one line per call or reply text, each with its step, for a
 * failure's report: it tells a call repeated in one message from one sent
 * again after the first returned, and shows what a turn that ended without
 * `say` wrote instead.
 */
export const transcript = ({ calls, text }: Turn): string =>
  [
    ...text.map((reply) => ({
      step: reply.step,
      line: `(reply text) ${JSON.stringify(reply.text)}`,
    })),
    ...calls.map((call) => ({
      step: call.step,
      line: `${call.name} ${JSON.stringify(call.input)} → ${JSON.stringify(call.output.length > 300 ? `${call.output.slice(0, 300)}…` : call.output)}`,
    })),
  ]
    // A stable sort: within a message, its text comes before its calls, as the model wrote them.
    .toSorted((a, b) => a.step - b.step)
    .map(({ step, line }) => `#${step} ${line}`)
    .join("\n");

/** A turn that did not end on its own: the model was cut off, or ran out of steps. */
class TurnUnfinished extends Schema.TaggedError<TurnUnfinished>()("TurnUnfinished", {
  message: Schema.String,
}) {}

const unfinished = (reason: string, turn: Turn) =>
  new TurnUnfinished({ message: `The turn did not finish: ${reason}.\n${transcript(turn)}` });

export interface Scenario {
  readonly wake: Wake;
  /** A fresh workspace for each turn, so what one turn writes another never reads. */
  readonly workspace: () => Workspace<GhEvent>;
}

/** Model calls in one turn at most; a turn that needs more is a failure in itself. */
const MAX_STEPS = 12;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeSetRoutine = Schema.decodeUnknownOption(tools.set_routine.input, DECODE_OPTIONS);
const decodeAsk = Schema.decodeUnknownOption(tools.ask.input, DECODE_OPTIONS);
const decodeShellInput = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }));

const json = (value: unknown): string => JSON.stringify(value);

/** A `set_routine` call's trigger, with its times read in `zone`, or `nonexistent` for an `at` that names no time. */
const triggerOf = (
  routine: ToolInput<"set_routine">,
  zone: DateTime.TimeZone.Named,
): Trigger | "nonexistent" | undefined => {
  if (routine.webhook === true) return { _tag: "webhook" };
  if (routine.schedule !== undefined) return { _tag: "schedule", cron: routine.schedule, zone };
  if (routine.at === undefined) return undefined;
  return Option.match(localInstant(routine.at, zone), {
    onNone: () => "nonexistent" as const,
    onSome: (at): Trigger => ({ _tag: "once", at }),
  });
};

/** The id the `set_routine` stub gives a routine it creates. */
export const CREATED_ROUTINE_ID = "routine-1";

/** The fictional bot, and the run in progress, as the server's records name them. */
const BOT_ID = Schema.decodeSync(BotId)("bot-juniper");
const RUN_ID = Schema.decodeSync(RoutineRunId)("run-current");

const encodeRoutine = Schema.encodeSync(Schema.toCodecJson(Routine));

/** A trigger as the server saves it. */
const savedTrigger = (trigger: Trigger): Routine["trigger"] =>
  trigger._tag === "schedule"
    ? { _tag: "schedule", cron: trigger.cron, timeZone: DateTime.zoneToString(trigger.zone) }
    : trigger;

/**
 * The routine that is running, as the server records it during its run: a
 * one-time routine was paused when its run started, any other is enabled.
 */
const runningRoutine = (wake: RoutineWake): Routine => {
  const { routine } = wake;
  const trigger: Trigger =
    routine.trigger.type === "schedule"
      ? { _tag: "schedule", cron: routine.trigger.cron, zone: wake.timeZone }
      : routine.trigger.type === "once"
        ? { _tag: "once", at: wake.at }
        : { _tag: "webhook" };
  return {
    id: routine.id,
    botId: BOT_ID,
    name: routine.name,
    instruction: routine.instruction,
    trigger: savedTrigger(trigger),
    enabled: trigger._tag !== "once",
    // A webhook routine's address is left out: no case runs one.
    webhookUrl: null,
    nextRunAt:
      trigger._tag === "schedule"
        ? Option.getOrNull(nextScheduled(trigger.cron, trigger.zone, wake.at))
        : null,
    lastRun: {
      id: RUN_ID,
      startedAt: wake.at,
      finishedAt: null,
      status: "running",
      attempts: 1,
      delivered: [],
      note: null,
    },
    runCount: wake.recentRuns.length + 1,
  };
};

/** What the `set_routine` stub answered, and whether the server would have refused the call. */
interface Saved {
  readonly output: string;
  readonly refused: boolean;
}

const refusal = (error: string): Saved => ({ output: json({ error }), refused: true });

const accepted = (routine: Routine): Saved => ({
  output: json(encodeRoutine(routine)),
  refused: false,
});

/**
 * What `set_routine` answers to a call its schema accepted. Like the server,
 * it answers with the routine as saved, and applies the server's rules for a
 * trigger (`schedule.ts`): a schedule or a time the server would refuse is
 * refused, and a routine created is given the first run the server would
 * plan. During a routine run only a `pause` of that routine is taken, and it
 * answers with that routine, paused. Outside a run, a call other than `create`
 * concerns a routine no case defines, so it answers with what the call set.
 */
export const setRoutineStub = (routine: ToolInput<"set_routine">, wake: Wake): Saved => {
  if (wake.kind === "routine") {
    return routine.action === "pause" && routine.id === wake.routine.id
      ? accepted({ ...runningRoutine(wake), enabled: false, nextRunAt: null })
      : refusal(
          `A routine run can only pause its own routine: set_routine with action pause and id ${wake.routine.id}. Put any other change in your say message, for your user to ask for.`,
        );
  }
  const trigger = triggerOf(routine, wake.timeZone);
  if (trigger === "nonexistent") {
    return refusal(`${routine.at} is not a date and time that exists.`);
  }
  const planned = trigger === undefined ? undefined : plannedRun(trigger, wake.at);
  if (planned !== undefined && Result.isFailure(planned)) {
    return refusal(
      planned.failure === "schedule"
        ? `The schedule "${routine.schedule}" cannot be used: it needs five cron fields that name a date that exists, and at most one run every five minutes.`
        : "That time has already passed. Give a time ahead.",
    );
  }
  if (
    routine.action !== "create" ||
    trigger === undefined ||
    routine.name === undefined ||
    routine.instruction === undefined
  ) {
    return {
      output: json({ ...routine, enabled: routine.action !== "pause" }),
      refused: false,
    };
  }
  return accepted({
    id: Schema.decodeSync(RoutineId)(CREATED_ROUTINE_ID),
    botId: BOT_ID,
    name: routine.name,
    instruction: routine.instruction,
    trigger: savedTrigger(trigger),
    enabled: true,
    webhookUrl:
      trigger._tag === "webhook"
        ? `https://bots.example.com/hooks/${CREATED_ROUTINE_ID}?key=fictional-key`
        : null,
    nextRunAt: planned === undefined ? null : Option.getOrNull(planned.success),
    lastRun: null,
    runCount: 0,
  });
};

/**
 * When a routine the server would save now first runs: the time it plans,
 * or `undefined` when it would refuse the routine or the trigger names no time.
 */
export const firstRun = (
  routine: ToolInput<"set_routine">,
  wake: Wake,
): DateTime.Utc | undefined => {
  const trigger = triggerOf(routine, wake.timeZone);
  if (trigger === undefined || trigger === "nonexistent") return undefined;
  return Result.match(plannedRun(trigger, wake.at), {
    onFailure: () => undefined,
    onSuccess: Option.getOrUndefined,
  });
};

/**
 * What `list_routines` answers: none in a conversation, and in a routine run
 * the routine that is running, as the server lists it then.
 */
const listedRoutines = (wake: Wake): Schema.Json => ({
  routines: wake.kind === "routine" ? [encodeRoutine(runningRoutine(wake))] : [],
});

type Request = Pick<Call, "step" | "name" | "input" | "routine">;

type Answer = Pick<Call, "output" | "events" | "refused">;

/** What the server would answer, as far as these scenarios need, and what a command did. */
const answer = (scenario: Scenario, workspace: Workspace<GhEvent>, request: Request): Answer => {
  const reply = (output: string): Answer => ({ output, events: [] });
  switch (request.name) {
    case "say":
      return reply(json({ status: "recorded" }));
    case "ask":
      return reply(json({ asked: true }));
    case "list_routines":
      return reply(json(listedRoutines(scenario.wake)));
    case "set_routine": {
      if (request.routine === undefined) {
        return { ...reply(json({ error: "The call was refused as invalid." })), refused: true };
      }
      const saved = setRoutineStub(request.routine, scenario.wake);
      return { ...reply(saved.output), refused: saved.refused };
    }
    case "recall":
      return reply(json({ facts: [] }));
    case "remember":
    case "forget":
      return reply(json({ recorded: true }));
    case "list_teammates":
      return reply(json({ bots: [], rooms: [] }));
    case HOST_TOOL: {
      const input = decodeShellInput(request.input);
      return input._tag === "Some"
        ? workspace.run(input.value.command)
        : reply(json({ error: "`command` must be a string." }));
    }
    default:
      return reply(json({ error: `${request.name} is not available here.` }));
  }
};

const toRequest = (step: number, name: string, input: unknown): Request => {
  if (name !== "set_routine") return { step, name, input };
  const decoded = decodeSetRoutine(input);
  return decoded._tag === "Some"
    ? { step, name, input, routine: decoded.value }
    : { step, name, input };
};

/**
 * Runs one turn of `model` on `scenario` and returns every tool call it made,
 * in order, with the reply text it wrote. Fails with {@link TurnUnfinished}
 * when the turn did not end on its own, so a cut-off turn never passes for one
 * that chose to say nothing.
 */
export const runTurn = Effect.fn("evals.runTurn")(
  function* (model: string, skills: Skills, scenario: Scenario) {
    const envelope = yield* renderWake(scenario.wake);
    const workspace = scenario.workspace();
    const tools = functionTools(workspace.commands);
    const messages: Array<Message> = [
      { role: "system", content: systemPrompt(model, skills) },
      { role: "user", content: envelope },
    ];
    const calls: Array<Call> = [];
    const text: Array<ReplyText> = [];
    const turn: Turn = { calls, text, workspace };
    for (let step = 1; step <= MAX_STEPS; step++) {
      const reply = yield* complete(model, messages, tools);
      if (reply.content !== null && reply.content.trim() !== "") {
        text.push({ step, text: reply.content });
      }
      const hasCalls = reply.toolCalls.length > 0;
      // Only a message the model ended itself counts: `stop` with no calls ends
      // the turn, `tool_calls` with calls goes on. Anything else was cut off or
      // malformed, and its calls are not run.
      if (reply.finishReason === "stop" && !hasCalls) return turn;
      if (reply.finishReason !== "tool_calls" || !hasCalls) {
        return yield* unfinished(
          `the model's message ended with finish_reason ${reply.finishReason ?? "(none)"} and ${reply.toolCalls.length} tool calls`,
          turn,
        );
      }
      messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls });
      for (const toolCall of reply.toolCalls) {
        const parsed = decodeJson(toolCall.function.arguments);
        const request = toRequest(
          step,
          toolCall.function.name,
          parsed._tag === "Some" ? parsed.value : toolCall.function.arguments,
        );
        const call: Call = { ...request, ...answer(scenario, workspace, request) };
        calls.push(call);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: call.output });
      }
      // An `ask` the server would accept ends the turn.
      if (calls.some((call) => call.name === "ask" && decodeAsk(call.input)._tag === "Some"))
        return turn;
    }
    return yield* unfinished(`it used all ${MAX_STEPS} steps`, turn);
  },
  Effect.provide(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
);
