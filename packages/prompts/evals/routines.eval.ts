// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId } from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, type RoutineRunSummary, tools, type Wake } from "../src/index.ts";
import { type Call, commandOf, runTurn, type Scenario, transcript } from "./harness.ts";

// The routine skill's evals: given the base prompt and the skill, a model
// creates a routine for recurring work, with a valid schedule and an
// instruction that stands alone; creates none for a one-off request; and in a
// routine run stays silent when a condition is not met, but speaks when it is,
// when a reminder is due, and when it could not do the work. Each case is one
// turn per model, scored on its tool calls.

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

/** A one-time reminder, as the skill would save "remind me at 9 to submit my expenses". */
const reminderWake: Wake = {
  ...base,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-2"),
    name: "Expense report reminder",
    trigger: { type: "once" },
    instruction:
      "Remind your user to submit their November expense report in the Acme expenses portal; it is due on Friday 20 November 2026 at 18:00. Send them one short message saying so.",
  },
  recentRuns: [],
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

/** A read-only look at the build: `gh run list`, `gh run view`, or a `gh api` read. */
const READS_BUILD = /\bgh\s+(run\s+(list|view)|api)\b/;
const WRITES = /\b(rerun|cancel|delete)\b|(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i;
const checksBuild = (command: string): boolean =>
  READS_BUILD.test(command) && !WRITES.test(command);

const UNAVAILABLE = "sh: this command is not available in this workspace";

/** A shell that answers `output` to a read-only look at the build, and nothing else. */
const buildShell =
  (output: string) =>
  (command: string): string =>
    checksBuild(command) ? output : UNAVAILABLE;

/** A shell whose GitHub sign-in has expired. */
const signedOutShell = (command: string): string =>
  /\bgh\b/.test(command)
    ? [
        "HTTP 401: Bad credentials (https://api.github.com/repos/acme/docs/actions/runs)",
        "Try authenticating with:  gh auth login",
      ].join("\n")
    : UNAVAILABLE;

const named = (calls: ReadonlyArray<Call>, name: string) =>
  calls.filter((call) => call.name === name);

const decodeSay = Schema.decodeUnknownOption(tools.say.input, DECODE_OPTIONS);

/** The `say` calls the server would accept, decoded, in order. */
const says = (calls: ReadonlyArray<Call>) =>
  named(calls, "say").flatMap((call) => {
    const decoded = decodeSay(call.input);
    return decoded._tag === "Some" ? [{ call, say: decoded.value }] : [];
  });

/** The index of the first call that looked at the build read-only, or -1. */
const firstBuildCheck = (calls: ReadonlyArray<Call>): number =>
  calls.findIndex((call) => {
    const command = commandOf(call);
    return command !== undefined && checksBuild(command);
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

/** Words that mark a clause about the healthy case: the build passed, nothing changed, an all-clear. */
const HEALTHY =
  /\b(passing|passes|passed|green|succeed(s|ed)?|success(ful)?|((has|did|is) )?not (fail(ed|ing)?|broken|red)|nothing (is )?(new|wrong)|all[- ]clear|all (is )?(well|good|fine))\b/i;
const OTHERWISE = /\botherwise\b/i;
const FAILURE = /\b(fail\w*|broken|red|problem|error|wrong)\b/i;

/** "Otherwise" is the healthy case only when the clause does not name a failure. */
const isHealthy = (clause: string): boolean =>
  HEALTHY.test(clause) || (OTHERWISE.test(clause) && !FAILURE.test(clause));

/** A verb or noun that delivers something to the user. */
const SEND =
  /\b(send|sends|sending|tell|tells|message|messages|messaging|notify|notifies|report|reports|say|says|saying|reply|replies|ping|let \w+ know)\b/gi;
const NEGATION = /\b(don['’]t|do not|never|no|not|nothing|without)\b/i;

/**
 * Whether a clause delivers something that no negation in its own phrase
 * cancels: "send an all-clear" does, "do not send an all-clear" and "say
 * nothing" do not, and in "don't send an alert, but send an all-clear" the
 * second send does.
 */
const sendsAnyway = (clause: string): boolean =>
  Array.from(clause.matchAll(SEND)).some((match) => {
    const phrase =
      clause
        .slice(0, match.index)
        .split(/[,:]|\b(?:but|then|and|instead)\b/i)
        .at(-1) ?? "";
    const after = clause.slice(match.index + match[0].length);
    return !NEGATION.test(phrase) && !/^\s+(nothing|no)\b/i.test(after);
  });

/** Problems with how an instruction's last lines handle the healthy case. */
const quietDeliveryProblems = (instruction: string): ReadonlyArray<string> => {
  const healthy = instruction.slice(-300).split(/[.;]/).filter(isHealthy);
  const problems: Array<string> = [];
  if (!healthy.some((clause) => SILENCE.test(clause))) {
    problems.push("the instruction does not say to stay silent when nothing is wrong");
  }
  if (healthy.some(sendsAnyway)) {
    problems.push("the instruction sends a message when nothing is wrong");
  }
  return problems;
};

/** 8 in the morning: "8:00", "08:00", "8am", "8 a.m.", or a bare 8 beside "morning"; never 8 p.m. */
const confirmsMorningEight = (text: string): boolean =>
  !/\b0?8(:00)?\s*p\.?m\b|\b20:00\b/i.test(text) &&
  (/\b0?8:00\b/.test(text) ||
    /\b0?8\s*a\.?m\b/i.test(text) ||
    (/\b0?8\b(?!:\d)/.test(text) && /\bmorning/i.test(text)));

/** Every weekday, Monday to Friday, not a single day. */
const confirmsWeekdays = (text: string): boolean =>
  /\b(weekdays?|work ?days?|mon(day)?s?\s*(-|–|—|to|through|thru)\s*fri(day)?s?)\b/i.test(text);

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  /** What is wrong with the turn; empty when it passes. */
  readonly problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>;
}

/** Problems with a routine run that must speak exactly once, about what `mentions` matches. */
const speaksOnce = (calls: ReadonlyArray<Call>, mentions: RegExp, what: string) => {
  const said = named(calls, "say");
  return [
    ...(said.length === 1 ? [] : [`called \`say\` ${said.length} times, not once`]),
    ...(says(calls).some(({ say }) => mentions.test(say.text))
      ? []
      : [`the message does not ${what}`]),
    ...["ask", "message_bot", "set_routine"].flatMap((name) =>
      named(calls, name).length > 0 ? [`called \`${name}\``] : [],
    ),
  ];
};

const cases: ReadonlyArray<Case> = [
  {
    name: "creates a routine for recurring work, with a valid schedule and an instruction that stands alone",
    scenario: {
      wake: userWake(
        "the docs build broke twice this week and nobody noticed until customers did. from now on can you check it every weekday morning at 8 and only bother me if it's red?",
      ),
      shell: buildShell(PASSING),
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
        if (!confirmsMorningEight(closing.say.text)) {
          problems.push("the closing `say` does not confirm 8:00 in the morning");
        }
        if (!confirmsWeekdays(closing.say.text)) {
          problems.push("the closing `say` does not confirm Monday to Friday");
        }
      }
      return problems;
    },
  },
  {
    name: "answers a one-off request in the turn from a check of the build, with no routine",
    scenario: {
      wake: userWake("is the docs build green right now? the release goes out at noon"),
      shell: buildShell(PASSING),
    },
    problems: (calls) => {
      const checked = firstBuildCheck(calls);
      const answer = says(calls).find(
        ({ call, say }) => say.done === true && calls.indexOf(call) > checked,
      );
      return [
        ...(named(calls, "set_routine").length > 0 ? ["called `set_routine`"] : []),
        ...(checked === -1 ? ["never checked the build"] : []),
        ...(answer === undefined
          ? ["no `say` with `done: true` after the check delivered the answer"]
          : /\b(green|pass(es|ed|ing)?|success(ful|fully)?|succeeded)\b/i.test(answer.say.text)
            ? []
            : ["the answer does not say the build is passing"]),
      ];
    },
  },
  {
    name: "keeps a routine run silent when nothing is worth saying",
    scenario: { wake: routineWake, shell: buildShell(PASSING) },
    problems: (calls) => [
      ...(firstBuildCheck(calls) === -1 ? ["never checked the build"] : []),
      ...["say", "ask", "message_bot", "set_routine"].flatMap((name) =>
        named(calls, name).length > 0 ? [`called \`${name}\``] : [],
      ),
    ],
  },
  {
    name: "speaks once in a routine run when something is worth saying",
    scenario: { wake: routineWake, shell: buildShell(FAILING) },
    problems: (calls) => [
      ...(firstBuildCheck(calls) === -1 ? ["never checked the build"] : []),
      ...speaksOnce(calls, /pricing|link|404/i, "say what failed"),
    ],
  },
  {
    name: "sends a due reminder exactly once",
    scenario: { wake: reminderWake, shell: () => UNAVAILABLE },
    problems: (calls) => speaksOnce(calls, /expense/i, "remind about the expense report"),
  },
  {
    name: "says once what blocked a routine run that lost its access",
    scenario: { wake: routineWake, shell: signedOutShell },
    problems: (calls) =>
      speaksOnce(
        calls,
        /\b(auth\w*|credentials?|token|sign(ed)?[- ]?(in|out)|log(ged)?[- ]?(in|out)|access|401|permission)\b/i,
        "name the access problem",
      ),
  },
];

describe("the quiet-delivery check", () => {
  it.each([
    DOCS_CHECK,
    "If the latest run on main failed, message your user with the job name. Otherwise end silently.",
    "If the build is red, tell your user what broke; if it is green, do not send an all-clear.",
    "If the latest run failed, send Rui one short message naming it. If it is not failed, end silently without messaging.",
  ])("accepts %j", (instruction) => {
    expect(quietDeliveryProblems(instruction)).toEqual([]);
  });

  it.each([
    "If the build fails, tell your user. If it passes, don't send a failure alert, but send an all-clear.",
    "If it fails, message your user. Do not message anyone else.",
    "If the build is passing, tell your user it is green.",
  ])("rejects %j", (instruction) => {
    expect(quietDeliveryProblems(instruction)).not.toEqual([]);
  });
});

describe.each(MODELS)("%s", (model) => {
  it.concurrent.each(cases)("$name", async ({ scenario, problems }) => {
    const calls = await Effect.runPromise(runTurn(model, scenario));
    expect(problems(calls), transcript(calls)).toEqual([]);
  });
});
