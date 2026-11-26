// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type RoomId, Routine, RoutineId, RoutineRunId } from "@j3-bots/contracts";
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
  BROWSER_HELP_REQUESTED,
  DECODE_OPTIONS,
  renderRoomMovedOn,
  renderRoomRead,
  renderSystemFile,
  renderWake,
  type RoomReadEntry,
  type RoutineWake,
  sharedSkills,
  type ToolInput,
  toolList,
  tools,
  type Wake,
} from "../src/index.ts";
import { type BrowserSetup, browserTools, FixtureBrowser } from "./browser.ts";
import { McpServers, connectorAnswer, type ConnectorStage, connectorTools } from "./connectors.ts";
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
 * `request_secret`, which the engine offers every bot ({@link SECRET_TOOL});
 * and, for a bot that has it, the engine's browser (`browser.ts`). A scenario
 * may also give the bot connectors (`connectors.ts`), whose tools it then
 * gets beside its own, and whose rules its instructions then hold.
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

/** The operator, as their bot's instructions name them. */
export interface Operator {
  readonly name: string;
  /** An IANA time zone. */
  readonly timeZone: string;
  /** What all their bots have learned about them. */
  readonly shared: string;
}

/** Rui, as most scenarios have him. */
const RUI: Operator = {
  name: "Rui",
  timeZone: "Europe/Lisbon",
  shared: "- Rui reads messages on his phone; keep them short.",
};

/**
 * The scenario's fictional operator and bot. An operator who has not said
 * what to call them has no shared facts either: nobody has got to know them
 * yet.
 */
const bot = (model: string, scenario: Scenario): BotInstructionsInput => {
  const setup = scenario.bot ?? JUNIPER;
  const operator = scenario.operator ?? RUI;
  const unnamed = scenario.unnamed === true;
  return {
    operator: { name: unnamed ? null : operator.name, timeZone: operator.timeZone },
    profile: {
      name: "Juniper",
      title: setup.title,
      job: setup.job,
      primary: scenario.primary === true,
    },
    runtime: { model, harness: model.startsWith("gpt") ? "Codex" : "Claude Code" },
    browser: scenario.browser !== undefined,
    pinned: { shared: unnamed ? "" : operator.shared, bot: setup.pinned },
    connectors: (scenario.connectors ?? NO_CONNECTORS).connected.length > 0,
  };
};

/** Whether a turn has the shipped skills as already read. */
export type Skills = "with the skill" | "without the skill";

const systemPrompt = (model: string, skills: Skills, scenario: Scenario): string =>
  [
    renderSystemFile(bot(model, scenario)),
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
 * The `j3` tools, with the connector tools the scenario gives, a
 * `run_command` that names what the workspace has, the engine's own tools
 * when the scenario gives its instance, and its browser when the scenario
 * gives one.
 */
const functionTools = (
  commands: ReadonlyArray<string>,
  shell: string,
  engine: EngineInstance | undefined,
  browser: boolean,
  connectors: ConnectorStage,
): ReadonlyArray<FunctionTool> => [
  ...toolList.map((tool): FunctionTool => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  })),
  ...connectorTools(connectors),
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
interface EarlierCall {
  readonly name: string;
  readonly input: Schema.Json;
  readonly output: string;
}

/** An earlier turn of the session: the wake that opened it and the calls the bot made, in order. */
export interface EarlierTurn {
  readonly wake: Wake;
  readonly calls: ReadonlyArray<EarlierCall>;
}

/** A teammate as `list_teammates` lists it. */
interface Teammate {
  readonly id: BotId;
  readonly name: string;
  readonly title: string;
  readonly job: string;
}

/** A room the bot is a member of, as `list_teammates` lists it. */
interface TeamRoom {
  readonly id: RoomId;
  readonly name: string;
  readonly members: ReadonlyArray<BotId>;
  /** What the room holds that the bot has seen, oldest first; none by default. */
  readonly seen?: ReadonlyArray<RoomReadEntry>;
  /**
   * What others wrote in the room after that, which the bot has not seen,
   * oldest first; none by default. A post to the room is refused with them
   * until the turn has been shown them.
   */
  readonly unseen?: ReadonlyArray<RoomReadEntry>;
}

/** The bot's teammates and the rooms it is in. */
export interface Team {
  readonly teammates: ReadonlyArray<Teammate>;
  readonly rooms: ReadonlyArray<TeamRoom>;
}

const NO_TEAM: Team = { teammates: [], rooms: [] };

export interface Scenario {
  readonly wake: Wake;
  /** A fresh workspace for each turn, so what one turn writes another never reads. */
  readonly workspace: () => Workspace<ProgramEvent>;
  /** Earlier turns of the same session, oldest first. None by default. */
  readonly history?: ReadonlyArray<EarlierTurn>;
  /** The bot, when it is not Juniper as most scenarios have it. */
  readonly bot?: BotSetup;
  /** Whether the bot is its operator's primary bot, which `create_bot` is for; not by default. */
  readonly primary?: boolean;
  /** The operator, when not Rui; the wake's time zone should be theirs. */
  readonly operator?: Operator;
  /**
   * The operator has not said what to call them: their bots call them "your
   * user".
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
   * The bot's browser, which its instructions then mention, and the saved
   * logins it may fill (`browser.ts`); none offers no browser tool, and
   * `list_secrets` and `fill_credential` are then not available.
   */
  readonly browser?: BrowserSetup;
  /** The operator's connectors; none by default. */
  readonly connectors?: ConnectorStage;
  /**
   * The bot's teammates and rooms, which `list_teammates` lists and
   * `message_bot` reaches; none by default.
   */
  readonly team?: Team;
}

const NO_CONNECTORS: ConnectorStage = { connected: [] };

/** Model calls in one turn at most; a turn that needs more is a failure in itself. */
const MAX_STEPS = 12;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeSetRoutine = Schema.decodeUnknownOption(tools.set_routine.input, DECODE_OPTIONS);
const decodeAsk = Schema.decodeUnknownOption(tools.ask.input, DECODE_OPTIONS);
const decodeBrowserHelp = Schema.decodeUnknownOption(
  tools.request_browser_help.input,
  DECODE_OPTIONS,
);
const decodeOperatorName = Schema.decodeUnknownOption(
  tools.set_operator_name.input,
  DECODE_OPTIONS,
);
const decodeCreateBot = Schema.decodeUnknownOption(tools.create_bot.input, DECODE_OPTIONS);
const decodeShellInput = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }));
const decodeMessageBot = Schema.decodeUnknownOption(tools.message_bot.input, DECODE_OPTIONS);
const decodeReadRoom = Schema.decodeUnknownOption(tools.read_room.input, DECODE_OPTIONS);

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

/**
 * What the server answers a `message_bot` (`Speech.ts`), for a scenario's
 * team: a room post lands at once, unless it is urgent or mentions the bot
 * itself or a non-member; a teammate's message waits for their next turn
 * unless it is urgent; and any other id is refused.
 */
type TeamAnswer =
  | { readonly status: "posted" | "sent" | "held"; readonly note: string }
  | { readonly error: string };

const teamAnswer = (team: Team, input: unknown): TeamAnswer => {
  const decoded = decodeMessageBot(input);
  if (decoded._tag === "None") return { error: "The call was refused as invalid." };
  const message = decoded.value;
  const room = team.rooms.find((one) => one.id === message.to);
  if (room !== undefined) {
    if (message.urgent === true) {
      return {
        error:
          "Nothing was sent: `urgent` goes with a message to a teammate. In a room, the members you `mention` are woken.",
      };
    }
    for (const id of message.mention ?? []) {
      if (id === BOT_ID) {
        return {
          error:
            "Nothing was sent: that id in `mention` is your own. Mention only the members who must act next.",
        };
      }
      if (!room.members.some((member) => member === id)) {
        return {
          error: `Nothing was sent: ${id} is not a member of this room. The room's members and their ids are in the wake; mention only them.`,
        };
      }
    }
    return {
      status: "posted",
      note: "It is in the room, and every member reads it in their next turn.",
    };
  }
  if (team.teammates.some((one) => one.id === message.to)) {
    return message.urgent === true
      ? { status: "sent", note: "It wakes them now." }
      : { status: "held", note: "They read it at the start of their next turn." };
  }
  return {
    error: `No teammate has the id ${message.to}; they may have been deleted. Nothing was sent. \`list_teammates\` shows your teammates now.`,
  };
};

type Request = Pick<Call, "step" | "name" | "input" | "routine">;

type Answer = Pick<Call, "output" | "events" | "refused">;

/** Text as a room search compares it (`roomReads.ts`): case and accents set aside. */
const folded = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The name a search finds a message by: its author's, but for the bot's own. */
const authorName = (entry: RoomReadEntry): string => {
  switch (entry.author.type) {
    case "user":
      return entry.author.name ?? "";
    case "you":
      return "";
    case "teammate":
      return entry.author.teammate.name;
  }
};

/**
 * What the server answers `message_bot` and `read_room` (`Speech.ts`,
 * `roomReads.ts`) for a scenario's team, over one turn of a main session. A
 * post to a room holding messages the turn has not been shown is refused
 * with them, and goes out once shown; a read shows the room's newest
 * messages, or those a search finds, and counts as seen when, without a
 * search, it showed every message the bot had not seen.
 * The fixtures are short, so a read is never cut to fit.
 */
class TeamRooms {
  readonly #team: Team;
  readonly #wake: Wake;
  readonly #shown = new Set<RoomId>();

  constructor(team: Team, wake: Wake) {
    this.#team = team;
    this.#wake = wake;
  }

  /** The answer to a call of `message_bot` or `read_room`; `undefined` for any other tool. */
  answer(request: Request): Effect.Effect<Answer | undefined, never, SecureRandom.SecureRandom> {
    switch (request.name) {
      case "message_bot":
        return this.#post(request.input);
      case "read_room":
        return this.#read(request.input);
      default:
        return Effect.undefined;
    }
  }

  #post(input: unknown): Effect.Effect<Answer, never, SecureRandom.SecureRandom> {
    const posted = teamAnswer(this.#team, input);
    const room = this.#roomOf(decodeMessageBot(input));
    const unseen = room === undefined || this.#shown.has(room.id) ? [] : (room.unseen ?? []);
    const latest = unseen.at(-1);
    if (room === undefined || latest === undefined || !("status" in posted)) {
      // Refused before the check, or nothing to show: as the server answers.
      return Effect.succeed({ output: json(posted), events: [] });
    }
    this.#shown.add(room.id);
    return renderRoomMovedOn({
      at: this.#wake.at,
      timeZone: this.#wake.timeZone,
      room: { id: room.id, name: room.name },
      entries: [...unseen.slice(0, -1), latest],
      omitted: 0,
    }).pipe(Effect.map((reason) => ({ output: json({ error: reason }), events: [] })));
  }

  #read(input: unknown): Effect.Effect<Answer, never, SecureRandom.SecureRandom> {
    const decoded = decodeReadRoom(input);
    if (decoded._tag === "None") {
      return Effect.succeed({
        output: json({ error: "The call was refused as invalid." }),
        events: [],
      });
    }
    const { room: id, search, count } = decoded.value;
    const room = this.#team.rooms.find((one) => one.id === id);
    if (room === undefined) {
      return Effect.succeed({
        output: json({
          error: `You are not a member of a room with the id ${id}. \`list_teammates\` shows the rooms you are in.`,
        }),
        events: [],
      });
    }
    const all = [...(room.seen ?? []), ...(room.unseen ?? [])];
    const wanted = search === undefined ? undefined : folded(search);
    const found =
      wanted === undefined
        ? all
        : all.filter(
            (entry) =>
              folded(entry.text).includes(wanted) || folded(authorName(entry)).includes(wanted),
          );
    const entries = found.slice(-(count ?? found.length));
    // Unseen messages come last, so a read of the newest shows them all when it shows as many.
    if (search === undefined && entries.length >= (room.unseen ?? []).length) {
      this.#shown.add(room.id);
    }
    return renderRoomRead({
      at: this.#wake.at,
      timeZone: this.#wake.timeZone,
      room: { id: room.id, name: room.name, archived: false },
      search: search ?? null,
      entries,
      earlier: found.length - entries.length,
      cut: false,
    }).pipe(Effect.map((text) => ({ output: text, events: [] })));
  }

  #roomOf(decoded: ReturnType<typeof decodeMessageBot>): TeamRoom | undefined {
    return decoded._tag === "None"
      ? undefined
      : this.#team.rooms.find((one) => one.id === decoded.value.to);
  }
}

/** Whether the operator wrote in the turn `wake` opens, as the server requires for some tools. */
const operatorSpoke = (wake: Wake): boolean =>
  wake.kind === "user" ||
  (wake.kind === "room" && wake.entries.some((entry) => entry.author === "user"));

/** What the server would answer, as far as these scenarios need, and what a command did. */
const answer = (
  routines: HeldRoutines,
  servers: McpServers,
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
    case "request_browser_help":
      // As `Speech.ts` answers a request the server took.
      return decodeBrowserHelp(request.input)._tag === "Some"
        ? reply(
            json({
              status: "requested",
              note: BROWSER_HELP_REQUESTED,
            }),
          )
        : reply(json({ error: "The call was refused as invalid." }));
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
      if (!operatorSpoke(scenario.wake)) {
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
    case "create_bot": {
      // As `Speech.ts` takes it: from the primary bot only, in a turn the operator spoke in.
      if (scenario.primary !== true || !operatorSpoke(scenario.wake)) {
        return reply(json({ error: "The call was refused: no bot was created." }));
      }
      const made = decodeCreateBot(request.input);
      return made._tag === "Some"
        ? reply(json({ id: `bot-${request.step}-${encodeURIComponent(made.value.name)}` }))
        : reply(json({ error: "The call was refused as invalid." }));
    }
    case "search_mcp_servers":
      return reply(servers.search(request.input));
    case "list_mcp_servers":
      return reply(servers.list());
    case "add_mcp_server":
      return reply(servers.add(request.input));
    case "recall":
      return reply(json({ facts: [] }));
    case "remember":
    case "forget":
      return reply(json({ recorded: true }));
    case "list_teammates": {
      const team = scenario.team ?? NO_TEAM;
      return reply(
        json({
          teammates: team.teammates,
          rooms: team.rooms.map((room) => ({ ...room, archived: false })),
        }),
      );
    }
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
      const connector = connectorAnswer(
        scenario.connectors ?? NO_CONNECTORS,
        request.name,
        request.input,
      );
      if (connector !== undefined) return reply(connector);
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
    const connectors = scenario.connectors ?? NO_CONNECTORS;
    const servers = new McpServers(connectors);
    const rooms = new TeamRooms(scenario.team ?? NO_TEAM, scenario.wake);
    const tools = functionTools(
      workspace.commands,
      scenario.shell ?? GH_SIGNED_IN,
      scenario.engine,
      scenario.browser !== undefined,
      connectors,
    );
    const browser =
      scenario.browser === undefined ? undefined : new FixtureBrowser(scenario.browser);
    const messages: Array<Message> = [
      {
        role: "system",
        content: systemPrompt(model, skills, scenario),
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
          ...((yield* rooms.answer(request)) ??
            answer(routines, servers, workspace, browser, scenario, request)),
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
