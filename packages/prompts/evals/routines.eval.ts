// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId } from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, type RoutineRunSummary, tools, type Wake } from "../src/index.ts";
import { type Call, runTurn, type Scenario, transcript } from "./harness.ts";

// The routine skill's evals: given the base prompt and the skill, a model
// creates a routine for recurring work, with a valid schedule and an
// instruction that stands alone; creates none for a one-off request; and keeps
// a routine run silent when nothing is worth saying, but speaks when something
// is. Each case is one turn per model, scored on its tool calls.

/** The models to evaluate, cheapest adequate first. Override with a comma-separated `J3_EVAL_MODELS`. */
const MODELS = Effect.runSync(
  Config.String("J3_EVAL_MODELS").pipe(Config.withDefault("claude-haiku-5-5,gpt-6-luna")),
)
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

const decodeSay = Schema.decodeUnknownOption(tools.say.input, DECODE_OPTIONS);

/** The `say` calls the server would accept, decoded, in order. */
const says = (calls: ReadonlyArray<Call>) =>
  named(calls, "say").flatMap((call) => {
    const decoded = decodeSay(call.input);
    return decoded._tag === "Some" ? [{ call, say: decoded.value }] : [];
  });

/** The routines the turn created and the stub accepted, as the server would save them. */
const created = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call) =>
    call.routine !== undefined && call.routine.action === "create"
      ? [{ call, routine: call.routine }]
      : [],
  );

/** Words that point back at a conversation the run will not have. */
const BACK_REFERENCE =
  /\b(as (we|you|I) (discussed|said|agreed)|as discussed|mentioned (above|earlier|before)|(the|that) (repo|repository|build|one) (above|we discussed)|this conversation|earlier today)\b/i;

/**
 * Wording that tells a run to end without speaking: "end silently", "finish
 * the run quietly", "end without a message", "stay silent", "say nothing",
 * "do not send anything".
 */
const SILENCE =
  /\b((end|finish|stop)s?( \w+){0,3} (silently|quietly|without)|(stay|remain|keep)s? (quiet|silent)|(say|send|report)s? nothing|(don['’]t|do not|never) (send|say|message|tell|notify|reply|report|speak|call))\b/i;

/** A clause about the case with nothing wrong: the build passed or nothing changed. */
const NOTHING_WRONG =
  /\b(otherwise|passing|passes|succeed(s|ed)?|(has|did) not fail(ed)?|not (failing|broken|red)|nothing (is )?(new|wrong))\b/i;

/** A clause that delivers something to the user. */
const SENDS = /\b(send|tell|message|notify)/i;

/** Problems with how an instruction's last lines handle the case with nothing to report. */
const quietDeliveryProblems = (instruction: string): ReadonlyArray<string> => {
  const tail = instruction.slice(-300);
  const problems: Array<string> = [];
  if (!SILENCE.test(tail)) {
    problems.push("the instruction does not end by saying to stay silent when nothing is wrong");
  }
  const speaksAnyway = tail
    .split(/[.;]/)
    .some((clause) => NOTHING_WRONG.test(clause) && SENDS.test(clause) && !SILENCE.test(clause));
  if (speaksAnyway) problems.push("the instruction sends a message when the build is passing");
  return problems;
};

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
      const [first] = routines;
      if (routines.length !== 1 || first === undefined) {
        return [`${routines.length} accepted \`set_routine\` creates, not one`];
      }
      const { call, routine } = first;
      const problems: Array<string> = [];
      const schedule = routine.schedule ?? "";
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
      const instruction = routine.instruction ?? "";
      if (!instruction.includes("acme/docs")) {
        problems.push("the instruction does not name the repository acme/docs");
      }
      if (!/\b(fail|failed|failing|red|broken)\b/i.test(instruction)) {
        problems.push("the instruction does not say what is worth reporting");
      }
      if (BACK_REFERENCE.test(instruction)) {
        problems.push("the instruction points back at the conversation");
      }
      problems.push(...quietDeliveryProblems(instruction));
      // The turn ends on a `say` with `done: true`, after the routine was saved, confirming what was saved.
      const last = calls.at(-1);
      const closing = says(calls).find((said) => said.call === last);
      if (closing === undefined || calls.indexOf(closing.call) < calls.indexOf(call)) {
        problems.push("the turn does not end with a `say` after the routine was saved");
      } else {
        if (closing.say.done !== true)
          problems.push("the closing `say` does not carry `done: true`");
        if (!/\b0?8(:00)?\b(?!:)/.test(closing.say.text)) {
          problems.push("the closing `say` does not confirm 8:00");
        }
        if (!/weekday|monday|mon-fri|work ?day/i.test(closing.say.text)) {
          problems.push("the closing `say` does not confirm the weekdays");
        }
      }
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
      ...(says(calls).some(({ say }) => say.done === true)
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
        ...(says(calls).some(({ say }) => /pricing|link|404/i.test(say.text))
          ? []
          : ["the message does not say what failed"]),
        ...(named(calls, "ask").length > 0 ? ["called `ask`"] : []),
      ];
    },
  },
];

describe.each(MODELS)("%s", (model) => {
  it.concurrent.each(cases)("$name", async ({ scenario, problems }) => {
    const calls = await Effect.runPromise(runTurn(model, scenario));
    expect(problems(calls), transcript(calls)).toEqual([]);
  });
});
