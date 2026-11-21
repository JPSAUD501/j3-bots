// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  type BotInstructionsInput,
  DECODE_OPTIONS,
  renderSystemFile,
  renderWake,
  sharedSkills,
  type ToolInput,
  toolList,
  tools,
  type Wake,
} from "../src/index.ts";
import { complete, type FunctionTool, type Message } from "./model.ts";

/**
 * One bot turn against a real model, with the bot's tools answered by stubs.
 *
 * The model gets what a bot's session gives it: the rendered base prompt,
 * profile and pinned memory, one wake envelope, and the `j3` tools as MCP
 * lists them. Two things stand in for the harness: the shipped skills, given
 * as already read (the harness's own listing and reading of them is not what
 * is measured), and `run_command`, a shell whose answers the scenario fixes.
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

const systemPrompt = (model: string): string =>
  [
    renderSystemFile(bot(model)),
    ...sharedSkills.map(
      (skill) => `# You read the skill skills/${skill.name}/SKILL.md\n\n${skill.text}`,
    ),
  ].join("\n\n---\n\n");

const HOST_TOOL = "run_command";

const functionTools: ReadonlyArray<FunctionTool> = [
  ...toolList.map((tool): FunctionTool => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  })),
  {
    type: "function",
    function: {
      name: HOST_TOOL,
      description:
        "Run a shell command in your workspace and return its output. The GitHub CLI, gh, is signed in.",
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
}

/** Reply text the model wrote beside or instead of its calls. It reaches nobody. */
interface ReplyText {
  readonly step: number;
  readonly text: string;
}

/** One turn: the tools the model called, in order, and the reply text it wrote. */
export interface Turn {
  readonly calls: ReadonlyArray<Call>;
  readonly text: ReadonlyArray<ReplyText>;
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
      line: `${call.name} ${JSON.stringify(call.input)}`,
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
  /** What `run_command` prints for a command. */
  readonly shell: (command: string) => string;
}

/** Model calls in one turn at most; a turn that needs more is a failure in itself. */
const MAX_STEPS = 12;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeSetRoutine = Schema.decodeUnknownOption(tools.set_routine.input, DECODE_OPTIONS);
const decodeAsk = Schema.decodeUnknownOption(tools.ask.input, DECODE_OPTIONS);
const decodeShellInput = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }));

/** The command of a `run_command` call; `undefined` for any other call. */
export const commandOf = (call: Call): string | undefined => {
  if (call.name !== HOST_TOOL) return undefined;
  const input = decodeShellInput(call.input);
  return input._tag === "Some" ? input.value.command : undefined;
};

const json = (value: unknown): string => JSON.stringify(value);

/** What the server would answer, as far as these scenarios need. */
const answer = (scenario: Scenario, call: Call): string => {
  switch (call.name) {
    case "say":
      return json({ status: "recorded" });
    case "ask":
      return json({ asked: true });
    case "list_routines":
      return json({ routines: [] });
    case "set_routine":
      return call.routine === undefined
        ? json({ error: "The call was refused as invalid." })
        : json({ routine: { ...call.routine, id: "routine-1", enabled: true } });
    case "recall":
      return json({ facts: [] });
    case "remember":
    case "forget":
      return json({ recorded: true });
    case "list_teammates":
      return json({ bots: [], rooms: [] });
    case HOST_TOOL: {
      const command = commandOf(call);
      return command === undefined
        ? json({ error: "`command` must be a string." })
        : scenario.shell(command);
    }
    default:
      return json({ error: `${call.name} is not available here.` });
  }
};

const toCall = (step: number, name: string, input: unknown): Call => {
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
  function* (model: string, scenario: Scenario) {
    const envelope = yield* renderWake(scenario.wake);
    const messages: Array<Message> = [
      { role: "system", content: systemPrompt(model) },
      { role: "user", content: envelope },
    ];
    const calls: Array<Call> = [];
    const text: Array<ReplyText> = [];
    const turn: Turn = { calls, text };
    for (let step = 1; step <= MAX_STEPS; step++) {
      const reply = yield* complete(model, messages, functionTools);
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
        const call = toCall(
          step,
          toolCall.function.name,
          parsed._tag === "Some" ? parsed.value : toolCall.function.arguments,
        );
        calls.push(call);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: answer(scenario, call) });
      }
      // An `ask` the server would accept ends the turn.
      if (calls.some((call) => call.name === "ask" && decodeAsk(call.input)._tag === "Some"))
        return turn;
    }
    return yield* unfinished(`it used all ${MAX_STEPS} steps`, turn);
  },
  Effect.provide(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
);
