// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import type { RoutineRunSummary, Wake } from "../src/index.ts";
import { type Call, runTurn, type Scenario } from "./harness.ts";

// The routine skill's evals: given the base prompt and the skill, a model
// creates a routine for recurring work, with a valid schedule and an
// instruction that stands alone; creates none for a one-off request; and keeps
// a routine run silent when nothing is worth saying, but speaks when something
// is. Each case is one turn per model, scored on its tool calls.

/** The models to evaluate, cheapest adequate first. Override with a comma-separated `J3_EVAL_MODELS`. */
const MODELS = (process.env["J3_EVAL_MODELS"] ?? "claude-haiku-5-5,gpt-6-luna")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");

const at = DateTime.makeUnsafe("2026-11-20T09:41:00Z");
const timeZone = DateTime.zoneMakeNamedUnsafe("Europe/Lisbon");
const base = { at, timeZone, sinceLastTurn: [] } as const;

const userWake = (text: string): Wake => ({
  ...base,
  kind: "user",
  answer: null,
  messages: [{ at, text, attachments: [] }],
});

/** The instruction the skill gives as its example, saved for a weekday check of the docs build. */
const DOCS_CHECK =
  "Check the latest CI run on the `main` branch of the GitHub repository acme/docs. Report it if the run failed or has been running for more than 30 minutes; a passing run is not news. When it failed, name the failing job and the first error line. Do not re-run jobs or push anything. If there is a problem, send your user one short message saying what is wrong; if the build is passing, end without saying anything.";

const daysAgo = (days: number) => DateTime.subtract(at, { days });

const quietRuns: ReadonlyArray<RoutineRunSummary> = [1, 2, 3].map((days): RoutineRunSummary => ({
  at: daysAgo(days),
  outcome: { type: "silent", note: null },
}));

const routineWake: Wake = {
  ...base,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-1"),
    name: "Docs build watch",
    trigger: { type: "schedule", cron: "0 8 * * 1-5" },
    instruction: DOCS_CHECK,
  },
  recentRuns: quietRuns,
  triggerData: null,
};

const PASSING = [
  "STATUS     TITLE                        WORKFLOW    BRANCH  EVENT  ID    ELAPSED  AGE",
  "completed  success  Fix typo in setup guide  Build docs  main    push   1042  3m12s    about 1 hour ago",
  "completed  success  Bump theme to 4.2        Build docs  main    push   1041  3m40s    about 1 day ago",
].join("\n");

const FAILING = [
  "STATUS     TITLE                        WORKFLOW    BRANCH  EVENT  ID    ELAPSED  AGE",
  "completed  failure  Add pricing page         Build docs  main    push   1043  2m40s    about 30 minutes ago",
  "completed  success  Fix typo in setup guide  Build docs  main    push   1042  3m12s    about 1 hour ago",
  "",
  "X main Build docs · 1043",
  "JOBS",
  "X link-check in 1m02s",
  "ANNOTATIONS",
  "X guides/pricing.md: link to /plans returns 404",
].join("\n");

const named = (calls: ReadonlyArray<Call>, name: string) =>
  calls.filter((call) => call.name === name);

const field = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null
    ? Object.getOwnPropertyDescriptor(input, key)?.value
    : undefined;

const text = (input: unknown, key: string): string => {
  const value = field(input, key);
  return typeof value === "string" ? value : "";
};

const created = (calls: ReadonlyArray<Call>) =>
  named(calls, "set_routine").filter((call) => field(call.input, "action") === "create");

/** Words that point back at a conversation the run will not have. */
const BACK_REFERENCE =
  /\b(as (we|you|I) (discussed|said|agreed)|as discussed|mentioned (above|earlier|before)|(the|that) (repo|repository|build|one) (above|we discussed)|this conversation|earlier today)\b/i;

/** A delivery line that says what to do when there is nothing to report. */
const QUIET_WHEN_NOTHING =
  /(nothing|no (message|need|news)|stay (quiet|silent)|silent|without (saying|a word|sending|messaging|speaking)|(don't|do not) (send|say|message|reply|notify)|end (the|your) (turn|run))/i;

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  /** What is wrong with the turn; empty when it passes. */
  readonly problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "creates a routine for recurring work, with a valid schedule and an instruction that stands alone",
    scenario: {
      wake: userWake(
        "the docs build broke twice this week and nobody noticed until customers did. from now on can you check it every weekday morning at 8 and only bother me if it's red?",
      ),
      shell: PASSING,
    },
    problems: (calls) => {
      const routines = created(calls);
      const [routine] = routines;
      if (routines.length !== 1 || routine === undefined) {
        return [`created ${routines.length} routines, not one`];
      }
      const problems: Array<string> = [];
      const schedule = text(routine.input, "schedule");
      const [minute, hour, day, month, weekday] = schedule.split(/\s+/);
      if (
        minute !== "0" ||
        hour !== "8" ||
        day !== "*" ||
        month !== "*" ||
        !["1-5", "mon-fri"].includes((weekday ?? "").toLowerCase())
      ) {
        problems.push(`schedule ${JSON.stringify(schedule)} is not weekdays at 8:00`);
      }
      const instruction = text(routine.input, "instruction");
      if (!instruction.includes("acme/docs")) {
        problems.push("the instruction does not name the repository acme/docs");
      }
      if (!/\b(fail|failed|failing|red|broken)\b/i.test(instruction)) {
        problems.push("the instruction does not say what is worth reporting");
      }
      if (BACK_REFERENCE.test(instruction)) {
        problems.push("the instruction points back at the conversation");
      }
      if (!QUIET_WHEN_NOTHING.test(instruction.slice(-300))) {
        problems.push("the instruction does not end by saying what to do when nothing is wrong");
      }
      const confirmed = named(calls, "say").some(
        (call) =>
          calls.indexOf(call) > calls.indexOf(routine) &&
          /\b8\b|8:00|08:00/.test(text(call.input, "text")),
      );
      if (!confirmed) problems.push("no `say` after creating it confirms the time");
      return problems;
    },
  },
  {
    name: "answers a one-off request in the turn, with no routine",
    scenario: {
      wake: userWake("is the docs build green right now? the release goes out at noon"),
      shell: PASSING,
    },
    problems: (calls) => [
      ...(named(calls, "set_routine").length > 0 ? ["called `set_routine`"] : []),
      ...(named(calls, "say").some((call) => field(call.input, "done") === true)
        ? []
        : ["no `say` with `done: true` delivered the answer"]),
    ],
  },
  {
    name: "keeps a routine run silent when nothing is worth saying",
    scenario: { wake: routineWake, shell: PASSING },
    problems: (calls) => [
      ...(named(calls, "run_command").length === 0 ? ["never checked the build"] : []),
      ...["say", "ask", "message_bot", "set_routine"].flatMap((name) =>
        named(calls, name).length > 0 ? [`called \`${name}\``] : [],
      ),
    ],
  },
  {
    name: "speaks once in a routine run when something is worth saying",
    scenario: { wake: routineWake, shell: FAILING },
    problems: (calls) => {
      const said = named(calls, "say");
      return [
        ...(said.length === 1 ? [] : [`called \`say\` ${said.length} times, not once`]),
        ...(said.some((call) => /pricing|link|404/i.test(text(call.input, "text")))
          ? []
          : ["the message does not say what failed"]),
        ...(named(calls, "ask").length > 0 ? ["called `ask`"] : []),
      ];
    },
  },
];

/** The calls of a turn, one line each, for a failure's report. */
const transcript = (calls: ReadonlyArray<Call>) =>
  calls.map((call) => `${call.name} ${JSON.stringify(call.input)}`).join("\n");

describe.each(MODELS)("%s", (model) => {
  it.concurrent.each(cases)("$name", async ({ scenario, problems }) => {
    const calls = await Effect.runPromise(runTurn(model, scenario));
    expect(problems(calls), transcript(calls)).toEqual([]);
  });
});
