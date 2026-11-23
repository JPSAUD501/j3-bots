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
import { type BrowserSetup, browserTools, FixtureBrowser } from "./browser.ts";
import type { FixtureEvent, ProgramEvent } from "./fixtures.ts";
import { complete, type FunctionTool, type Message } from "./model.ts";
import { localInstant, nextScheduled, plannedRun, type Trigger } from "./schedule.ts";
import type { Workspace } from "./shell.ts";

/**
 * One bot turn against a real model, with the bot's tools answered by stubs.
 *
 * The model gets what a bot's session gives it: the rendered base prompt,
 * profile and pinned memory, one wake envelope, and the `j3` tools as MCP
 * lists them. Three things stand in for the harness: the shipped skills, given
 * as already read when a run includes them (the harness's own listing and
 * reading of them is not what is measured); `run_command`, a stand-in shell
 * whose workspace and programs the scenario fixes (`shell.ts`, `fixtures.ts`);
 * and `request_secret`, which the engine offers every bot ({@link SECRET_TOOL}).
 *
 * Every case runs with the skills and without them. Nothing links them into a
 * harness yet, and a session that never reads one still has to behave, so a
 * case that fails only without them shows a rule missing from the base prompt,
 * the tool descriptions or the envelope.
 */

/** What a scenario changes in the fictional bot: its title and job, and its own pinned memory. */
export interface BotSetup {
  readonly title: string;
  readonly job: string;
  readonly pinned: string;
}

/** Juniper, who looks after the docs, as most scenarios have it. */
const JUNIPER: BotSetup = {
  title: "Docs",
  job: "Look after the Acme documentation site and its GitHub repository, acme/docs: watch its builds and pull requests, and tell Rui what needs his attention.",
  pinned: "",
};

/** Rui, as most scenarios have him, or an operator who has not said what to call them. */
const operatorOf = (unnamed: boolean) =>
  unnamed
    ? { name: null, shared: "" }
    : { name: "Rui", shared: "- Rui reads messages on his phone; keep them short." };

/**
 * A fictional operator and bot. An operator who has not said what to call
 * them has no shared facts either: nobody has got to know them yet.
 */
const bot = (model: string, setup: BotSetup, unnamed: boolean): BotInstructionsInput => {
  const operator = operatorOf(unnamed);
  return {
    operator: { name: operator.name, timeZone: "Europe/Lisbon" },
    profile: { name: "Juniper", title: setup.title, job: setup.job, primary: false },
    runtime: { model, harness: model.startsWith("gpt") ? "Codex" : "Claude Code" },
    pinned: { shared: operator.shared, bot: setup.pinned },
  };
};

/** Whether a turn has the shipped skills as already read. */
export type Skills = "with the skill" | "without the skill";

const systemPrompt = (model: string, skills: Skills, setup: BotSetup, unnamed: boolean): string =>
  [
    renderSystemFile(bot(model, setup, unnamed)),
    ...(skills === "with the skill" ? sharedSkills : []).map(
      (skill) => `# You read the skill skills/${skill.name}/SKILL.md\n\n${skill.text}`,
    ),
  ].join("\n\n---\n\n");

const HOST_TOOL = "run_command";

/**
 * The engine's tool for a secret, as far as these scenarios need it. At the
 * engine's pinned commit (Read, T3 Code 59651c1,
 * `apps/server/src/mcp/OrchestratorMcpService.ts`, `request_secret`), a
 * `value` the user pasted is saved to a file only its owner can read, and the
 * result names that file; a `value` with `delivery: "secretRef"` is refused.
 * Without one, the user gets a card, and `delivery: "file"` returns a file
 * holding what they typed. `label` and `reason` must not be blank
 * (`packages/contracts/src/orchestratorMcp.ts`). The stand-in saves the file under
 * {@link SECRET_FOLDER} and answers a card with the scenario's
 * `secretAnswer`, or as a card left unanswered when it has none; with
 * `pastedSecretFails`, saving a pasted `value` fails. The
 * description is this repository's own wording, not the engine's.
 */
const SECRET_TOOL = "request_secret";

/** Where the stand-in `request_secret` keeps the secrets it saves. */
export const SECRET_FOLDER = "/run/secrets";

const NonEmpty = Schema.String.check(
  Schema.makeFilter((text: string) => text.trim().length > 0, { expected: "a non-empty string" }),
);

/** The arguments the engine accepts, as far as these scenarios use them. */
const decodeSecretInput = Schema.decodeUnknownOption(
  Schema.Struct({
    label: NonEmpty,
    reason: NonEmpty,
    value: Schema.optionalKey(
      Schema.String.check(
        Schema.makeFilter((text: string) => text.length > 0, { expected: "a non-empty string" }),
      ),
    ),
    delivery: Schema.optionalKey(Schema.Literals(["secretRef", "file"])),
  }),
);

/**
 * The engine instance J3 Bots runs for its bots, as its own MCP tools show it
 * to a bot, for a scenario about what those tools reach. The engine offers a
 * bot tools under the `t3-code` server name, which Claude Code lists as
 * `mcp__t3-code__<tool>` (Read in this repository,
 * `packages/engine-t3/src/t3/toolNames.ts`). The stand-in offers three read
 * tools and answers them from {@link EngineInstance}, in the fields T3 Code's
 * own answer with (Verified on `4941`, `docs/research/t3-code.md`): the
 * environment's `label` is the name of the machine the engine runs on, and the
 * projects and threads are the instance's own. That the pinned engine offers a
 * bot the same tools is Assumed. The descriptions are this repository's own
 * wording.
 */
export interface EngineInstance {
  /** The name the instance answers with: the machine it runs on. */
  readonly machine: string;
  readonly projects: ReadonlyArray<{ readonly title: string; readonly workspaceRoot: string }>;
  readonly threads: ReadonlyArray<{ readonly title: string; readonly project: string }>;
}

const ENGINE_TOOLS = {
  environment: "mcp__t3-code__t3_environment_read",
  projects: "mcp__t3-code__t3_project_list",
  threads: "mcp__t3-code__t3_thread_list",
} as const;

const NO_ARGUMENTS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** The stand-in engine tools, in this repository's own wording. */
const engineTools: ReadonlyArray<FunctionTool> = [
  {
    type: "function",
    function: {
      name: ENGINE_TOOLS.environment,
      description: "Which T3 Code server these tools reach: its environment id and its label.",
      parameters: NO_ARGUMENTS,
    },
  },
  {
    type: "function",
    function: {
      name: ENGINE_TOOLS.projects,
      description: "The projects this T3 Code server holds.",
      parameters: NO_ARGUMENTS,
    },
  },
  {
    type: "function",
    function: {
      name: ENGINE_TOOLS.threads,
      description: "The threads this T3 Code server holds, newest first.",
      parameters: NO_ARGUMENTS,
    },
  },
];

/** A stand-in project's id, from its title. */
const projectId = (title: string): string => `project-${title.toLowerCase()}`;

/** What the stand-in engine tool `name` answers, or `undefined` when `name` is not one. */
const engineAnswer = (engine: EngineInstance, name: string): Schema.Json | undefined => {
  switch (name) {
    case ENGINE_TOOLS.environment:
      return {
        environmentId: "env-local",
        label: engine.machine,
        platform: { os: "linux", arch: "x64" },
      };
    case ENGINE_TOOLS.projects:
      return {
        projects: engine.projects.map((project) => ({
          id: projectId(project.title),
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        })),
      };
    case ENGINE_TOOLS.threads:
      return {
        threads: engine.threads.map((thread, index) => ({
          threadId: `thread-${index + 1}`,
          projectId: projectId(thread.project),
          title: thread.title,
          status: "idle",
        })),
      };
    default:
      return undefined;
  }
};

/** What `run_command` says about the programs signed in, unless a scenario says otherwise. */
const GH_SIGNED_IN = "The GitHub CLI, gh, is signed in.";

/**
 * The `j3` tools, a `run_command` that names what the workspace has, and the
 * engine's own tools when the scenario gives its instance.
 */
const functionTools = (
  commands: ReadonlyArray<string>,
  shell: string,
  engine: EngineInstance | undefined,
  browser: boolean,
): ReadonlyArray<FunctionTool> => [
  ...toolList.map((tool): FunctionTool => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  })),
  {
    type: "function",
    function: {
      name: SECRET_TOOL,
      description:
        'Get one secret, such as a token or password, without it entering the conversation. With `label` and `reason` alone, your user sees a card to type it into, and the result is a one-use reference for this host\'s own tools; with `delivery: "file"`, it is a private file for a command to read. If your user already pasted the secret here, pass it as `value`: it is saved to a private file, and the result names the file.',
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          reason: { type: "string" },
          value: { type: "string" },
          delivery: { type: "string", enum: ["secretRef", "file"] },
        },
        required: ["label", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: HOST_TOOL,
      description: `Run a shell command in your workspace and return its output. ${shell} The workspace has only these commands: ${commands.join(", ")}.`,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  ...(engine === undefined ? [] : engineTools),
  ...(browser ? browserTools : []),
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

/**
 * One turn: the tools the model called, in order, the reply text it wrote,
 * and its workspace and routines as the turn left them.
 */
export interface Turn {
  readonly calls: ReadonlyArray<Call>;
  readonly text: ReadonlyArray<ReplyText>;
  readonly workspace: Workspace<ProgramEvent>;
  readonly routines: HeldRoutines;
  /** The browser as the turn left it, with every fill and typing, when the scenario gave one. */
  readonly browser: FixtureBrowser | undefined;
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

/** A call the bot made in an earlier turn, with what it answered. */
export interface EarlierCall {
  readonly name: string;
  readonly input: Schema.Json;
  readonly output: string;
}

/** An earlier turn of the session: the wake that opened it and the calls the bot made, in order. */
export interface EarlierTurn {
  readonly wake: Wake;
  readonly calls: ReadonlyArray<EarlierCall>;
}

export interface Scenario {
  readonly wake: Wake;
  /** A fresh workspace for each turn, so what one turn writes another never reads. */
  readonly workspace: () => Workspace<ProgramEvent>;
  /** Earlier turns of the same session, oldest first. None by default. */
  readonly history?: ReadonlyArray<EarlierTurn>;
  /** The bot, when it is not Juniper as most scenarios have it. */
  readonly bot?: BotSetup;
  /**
   * The operator has not said what to call them: their bots call them "your
   * user". Rui otherwise.
   */
  readonly unnamed?: boolean;
  /** What `run_command` says about the programs signed in, when not only `gh`. */
  readonly shell?: string;
  /** What the user types into a `request_secret` card; none leaves the card unanswered. */
  readonly secretAnswer?: string;
  /**
   * When set, saving a pasted `value` fails, as a full disk or a locked
   * folder would make it, so only a card can carry the secret. How the engine
   * words such a failure is Assumed; the stand-in returns an error.
   */
  readonly pastedSecretFails?: boolean;
  /** The engine instance whose own tools the bot gets; none offers them. */
  readonly engine?: EngineInstance;
  /**
   * The bot's browser and the saved logins it may fill (`browser.ts`); none
   * offers no browser tool, and `list_credentials` and `fill_credential` are
   * then not available.
   */
  readonly browser?: BrowserSetup;
}

/** Model calls in one turn at most; a turn that needs more is a failure in itself. */
const MAX_STEPS = 12;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeSetRoutine = Schema.decodeUnknownOption(tools.set_routine.input, DECODE_OPTIONS);
const decodeAsk = Schema.decodeUnknownOption(tools.ask.input, DECODE_OPTIONS);
const decodeOperatorName = Schema.decodeUnknownOption(
  tools.set_operator_name.input,
  DECODE_OPTIONS,
);
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

/** The fictional bot, and the run in progress, as the server's records name them. */
const BOT_ID = Schema.decodeSync(BotId)("bot-juniper");
const RUN_ID = Schema.decodeSync(RoutineRunId)("run-current");

const encodeRoutine = Schema.encodeSync(Schema.toCodecJson(Routine));

/** A trigger as the server saves it. */
const savedTrigger = (trigger: Trigger): Routine["trigger"] =>
  trigger._tag === "schedule"
    ? { _tag: "schedule", cron: trigger.cron, timeZone: DateTime.zoneToString(trigger.zone) }
    : trigger;

/** Whether two triggers are the same, as the server compares a trigger an update sends with the saved one. */
const sameTrigger = (a: Trigger, b: Trigger): boolean => {
  switch (a._tag) {
    case "schedule":
      return (
        b._tag === "schedule" &&
        a.cron === b.cron &&
        DateTime.zoneToString(a.zone) === DateTime.zoneToString(b.zone)
      );
    case "once":
      return b._tag === "once" && DateTime.Equivalence(a.at, b.at);
    case "webhook":
      return b._tag === "webhook";
  }
};

/** A routine as the server holds it, with its trigger's times as the stub checks them. */
interface Held {
  readonly routine: Routine;
  readonly trigger: Trigger;
}

/**
 * The routine that is running, as the server records it during its run: a
 * one-time routine was paused when its run started, any other is enabled.
 */
const runningRoutine = (wake: RoutineWake): Held => {
  const { routine } = wake;
  const trigger: Trigger =
    routine.trigger.type === "schedule"
      ? { _tag: "schedule", cron: routine.trigger.cron, zone: wake.timeZone }
      : routine.trigger.type === "once"
        ? { _tag: "once", at: wake.at }
        : { _tag: "webhook" };
  return {
    trigger,
    routine: {
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
    },
  };
};

/** What the `set_routine` stub answered, and whether the server would have refused the call. */
interface Saved {
  readonly output: string;
  readonly refused: boolean;
}

const refusal = (error: string): Saved => ({ output: json({ error }), refused: true });

/** Why the server refuses a trigger it checked: the one the call gives, or else the routine's saved one. */
const triggerRefusal = (trigger: Trigger, given: boolean): Saved => {
  if (trigger._tag === "schedule") {
    return refusal(
      given
        ? `The schedule "${trigger.cron}" cannot be used: it needs five cron fields that name a date that exists, and at most one run every five minutes.`
        : `This routine's schedule "${trigger.cron}" cannot run any more. Give it a new one with update.`,
    );
  }
  return refusal(
    given
      ? "That time has already passed. Give a time ahead."
      : "This routine's one-time run has passed. Give it a new time, schedule or webhook with update; that starts it again.",
  );
};

/**
 * The routines the server holds during one turn, and the `set_routine` and
 * `list_routines` stubs that answer from them. A conversation starts with
 * none, and a routine run with the routine that is running, as the server
 * records it then.
 *
 * `set_routine` follows the server (`apps/server/src/turns/routineTool.ts`,
 * `Routines.update`): during a run only a `pause` of that run's routine is
 * taken. Otherwise a trigger is checked by the server's rules (`schedule.ts`),
 * a `create` gets an id of its own and the first run the server plans, and
 * an `update`, `pause`, `resume` or `delete` of an id it does not hold is
 * refused; of one it holds, it changes that routine as the server would, its
 * next run included. Each answers with the routine as saved, so what
 * `list_routines` shows, and what a case replays, is the routine as it stands
 * after every call the turn made.
 */
export class HeldRoutines {
  readonly #wake: Wake;
  readonly #held: Array<Held>;
  #created = 0;

  constructor(wake: Wake) {
    this.#wake = wake;
    this.#held = wake.kind === "routine" ? [runningRoutine(wake)] : [];
  }

  /** The routines as they stand now. */
  get current(): ReadonlyArray<Routine> {
    return this.#held.map(({ routine }) => routine);
  }

  /** What `list_routines` answers. */
  list(): Schema.Json {
    return { routines: this.#held.map(({ routine }) => encodeRoutine(routine)) };
  }

  /** What `set_routine` answers, keeping what it saved. */
  set(input: ToolInput<"set_routine">): Saved {
    const wake = this.#wake;
    if (wake.kind === "routine" && !(input.action === "pause" && input.id === wake.routine.id)) {
      return refusal(
        `A routine run can only pause its own routine: set_routine with action pause and id ${wake.routine.id}. Put any other change in your say message, for your user to ask for.`,
      );
    }
    const trigger = triggerOf(input, wake.timeZone);
    if (trigger === "nonexistent")
      return refusal(`${input.at} is not a date and time that exists.`);
    if (input.action === "create") return this.#create(input, trigger);
    const index = this.#held.findIndex(({ routine }) => routine.id === input.id);
    const current = this.#held[index];
    if (current === undefined) {
      return refusal(`You have no routine ${input.id}. list_routines shows your routines' ids.`);
    }
    if (input.action === "delete") {
      this.#held.splice(index, 1);
      return { output: json({ status: "deleted", id: current.routine.id }), refused: false };
    }
    const changed = this.#changed(current, input, trigger);
    if ("refused" in changed) return changed;
    this.#held[index] = changed;
    return { output: json(encodeRoutine(changed.routine)), refused: false };
  }

  #create(input: ToolInput<"set_routine">, trigger: Trigger | undefined): Saved {
    const { name, instruction } = input;
    if (name === undefined || instruction === undefined || trigger === undefined) {
      return refusal("A create needs a name, an instruction and a trigger.");
    }
    const planned = plannedRun(trigger, this.#wake.at);
    if (Result.isFailure(planned)) return triggerRefusal(trigger, true);
    this.#created++;
    const id = Schema.decodeSync(RoutineId)(`routine-${this.#created}`);
    const routine: Routine = {
      id,
      botId: BOT_ID,
      name,
      instruction,
      trigger: savedTrigger(trigger),
      enabled: true,
      webhookUrl:
        trigger._tag === "webhook"
          ? `https://bots.example.com/hooks/${id}?key=fictional-key`
          : null,
      nextRunAt: Option.getOrNull(planned.success),
      lastRun: null,
      runCount: 0,
    };
    this.#held.push({ routine, trigger });
    return { output: json(encodeRoutine(routine)), refused: false };
  }

  /**
   * A held routine after an `update`, `pause` or `resume`, as `Routines.update`
   * leaves it: a new trigger is checked even on a paused routine and moves the
   * next run; a one-time routine whose time has passed starts again with a new
   * trigger; a resume plans the saved trigger again; an edit of the name or
   * the instruction leaves the next run where it was.
   */
  #changed(
    current: Held,
    input: ToolInput<"set_routine">,
    given: Trigger | undefined,
  ): Held | Saved {
    const now = this.#wake.at;
    const before = current.routine;
    const retriggered = given !== undefined && !sameTrigger(given, current.trigger);
    const trigger = given ?? current.trigger;
    const passed =
      current.trigger._tag === "once" && !DateTime.isGreaterThan(current.trigger.at, now);
    const enabled =
      input.action === "update"
        ? before.enabled || (passed && retriggered)
        : input.action === "resume";
    let planned = Option.none<DateTime.Utc>();
    if (retriggered) {
      const checked = plannedRun(trigger, now);
      if (Result.isFailure(checked)) return triggerRefusal(trigger, true);
      planned = checked.success;
    }
    let next: DateTime.Utc | null;
    if (!enabled) next = null;
    else if (retriggered) next = Option.getOrNull(planned);
    else if (enabled !== before.enabled) {
      // A resume plans the saved trigger again.
      const checked = plannedRun(trigger, now);
      if (Result.isFailure(checked)) return triggerRefusal(trigger, given !== undefined);
      next = Option.getOrNull(checked.success);
    } else next = before.nextRunAt;
    return {
      trigger,
      routine: {
        ...before,
        name: (input.action === "update" ? input.name : undefined) ?? before.name,
        instruction:
          (input.action === "update" ? input.instruction : undefined) ?? before.instruction,
        trigger: savedTrigger(trigger),
        enabled,
        webhookUrl:
          trigger._tag === "webhook"
            ? (before.webhookUrl ?? `https://bots.example.com/hooks/${before.id}?key=fictional-key`)
            : null,
        nextRunAt: next,
      },
    };
  }
}

type Request = Pick<Call, "step" | "name" | "input" | "routine">;

type Answer = Pick<Call, "output" | "events" | "refused">;

/** What the server would answer, as far as these scenarios need, and what a command did. */
const answer = (
  routines: HeldRoutines,
  workspace: Workspace<ProgramEvent>,
  browser: FixtureBrowser | undefined,
  scenario: Scenario,
  request: Request,
): Answer => {
  const reply = (output: string): Answer => ({ output, events: [] });
  const browsed = browser?.answer(request.step, request.name, request.input);
  if (browsed !== undefined) return reply(browsed);
  switch (request.name) {
    case "say":
      return reply(json({ status: "recorded" }));
    case "ask":
      return reply(json({ asked: true }));
    case "list_routines":
      return reply(json(routines.list()));
    case "set_routine": {
      if (request.routine === undefined) {
        return { ...reply(json({ error: "The call was refused as invalid." })), refused: true };
      }
      const saved = routines.set(request.routine);
      return { ...reply(saved.output), refused: saved.refused };
    }
    case "set_operator_name": {
      // The server takes it only in a turn the operator spoke in (`Speech.ts`).
      const spoke =
        scenario.wake.kind === "user" ||
        (scenario.wake.kind === "room" &&
          scenario.wake.entries.some((entry) => entry.author === "user"));
      if (!spoke) {
        return reply(
          json({
            error:
              "Nothing was saved: only your user can say what they want to be called, in a message of theirs that this turn answers.",
          }),
        );
      }
      const named = decodeOperatorName(request.input);
      return named._tag === "Some"
        ? reply(json({ name: named.value.name }))
        : reply(json({ error: "`name` must be 1 to 200 characters once trimmed." }));
    }
    case "recall":
      return reply(json({ facts: [] }));
    case "remember":
    case "forget":
      return reply(json({ recorded: true }));
    case "list_teammates":
      return reply(json({ bots: [], rooms: [] }));
    case SECRET_TOOL: {
      const input = decodeSecretInput(request.input);
      if (input._tag === "None")
        return reply(
          json({ error: "`label` and `reason` must be non-empty, and so must `value` if given." }),
        );
      const saved = (secret: string) => {
        const file = `${SECRET_FOLDER}/secret-${request.step}`;
        workspace.store(file, secret);
        return file;
      };
      const { value, delivery } = input.value;
      if (value !== undefined) {
        // The engine refuses a pasted `value` with `delivery: "secretRef"`.
        return delivery === "secretRef"
          ? reply(
              json({
                error: 'A pasted `value` is saved as a file. Leave out `delivery: "secretRef"`.',
              }),
            )
          : scenario.pastedSecretFails === true
            ? reply(json({ error: "The pasted value could not be saved." }))
            : reply(json({ status: "saved", file: saved(value) }));
      }
      if (scenario.secretAnswer === undefined) {
        return reply(json({ status: "timed_out", note: "Your user did not answer the card." }));
      }
      return reply(
        json(
          delivery === "file"
            ? { status: "saved", file: saved(scenario.secretAnswer) }
            : { status: "saved", secretRef: `secret-ref-${request.step}` },
        ),
      );
    }
    case HOST_TOOL: {
      const input = decodeShellInput(request.input);
      return input._tag === "Some"
        ? workspace.run(input.value.command)
        : reply(json({ error: "`command` must be a string." }));
    }
    default: {
      const engine =
        scenario.engine === undefined ? undefined : engineAnswer(scenario.engine, request.name);
      return reply(json(engine ?? { error: `${request.name} is not available here.` }));
    }
  }
};

/**
 * Earlier turns as the session holds them: each wake's envelope, then each
 * call in a message of its own with what it answered.
 */
const earlierMessages = (
  history: ReadonlyArray<{ readonly envelope: string; readonly calls: ReadonlyArray<EarlierCall> }>,
): ReadonlyArray<Message> =>
  history.flatMap(({ envelope, calls }, turn): ReadonlyArray<Message> => [
    { role: "user", content: envelope },
    ...calls.flatMap((call, index): ReadonlyArray<Message> => {
      const id = `earlier-${turn + 1}-${index + 1}`;
      return [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name: call.name, arguments: json(call.input) } },
          ],
        },
        { role: "tool", tool_call_id: id, content: call.output },
      ];
    }),
  ]);

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
    const routines = new HeldRoutines(scenario.wake);
    const tools = functionTools(
      workspace.commands,
      scenario.shell ?? GH_SIGNED_IN,
      scenario.engine,
      scenario.browser !== undefined,
    );
    const browser =
      scenario.browser === undefined ? undefined : new FixtureBrowser(scenario.browser);
    const messages: Array<Message> = [
      {
        role: "system",
        content: systemPrompt(model, skills, scenario.bot ?? JUNIPER, scenario.unnamed === true),
      },
      ...earlierMessages(
        yield* Effect.forEach(scenario.history ?? [], ({ wake, calls }) =>
          Effect.map(renderWake(wake), (envelope) => ({ envelope, calls })),
        ),
      ),
      { role: "user", content: envelope },
    ];
    const calls: Array<Call> = [];
    const text: Array<ReplyText> = [];
    const turn: Turn = { calls, text, workspace, routines, browser };
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
        const call: Call = {
          ...request,
          ...answer(routines, workspace, browser, scenario, request),
        };
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
