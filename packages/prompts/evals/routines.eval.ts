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
// when a reminder is due, and when it could not do the work, unless a recent
// run already said what blocks it. Each case is one turn per model, scored on
// its tool calls.

/** The models to evaluate, cheapest adequate first. Override with a comma-separated `J3_EVAL_MODELS`. */
const MODELS = Effect.runSync(
  Config.String("J3_EVAL_MODELS").pipe(Config.withDefault("claude-haiku-5-5,gpt-6-luna")),
)
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");

const timeZone = DateTime.zoneMakeNamedUnsafe("Europe/Lisbon");

/**
 * Today at `hour:minute` in the operator's zone. The fixtures take their date
 * from the real current date, as the server takes a wake's time from its
 * clock, so no date in a wake disagrees with one the model was given
 * elsewhere and invites a correction.
 */
const todayAt = (hour: number, minute: number): DateTime.Utc =>
  DateTime.toUtc(
    DateTime.setParts(DateTime.makeZonedUnsafe(DateTime.nowUnsafe(), { timeZone }), {
      hour,
      minute,
      second: 0,
      millisecond: 0,
    }),
  );

/** When the operator writes. */
const at = todayAt(9, 41);
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

/** When a routine run starts: the time its daily schedule names. */
const runAt = todayAt(8, 7);

const daysAgo = (days: number) => DateTime.subtract(runAt, { days });

const quietRuns: ReadonlyArray<RoutineRunSummary> = [1, 2, 3].map((days): RoutineRunSummary => ({
  at: daysAgo(days),
  outcome: { type: "silent", note: null },
}));

const routineWake: Wake = {
  ...base,
  at: runAt,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-1"),
    name: "Docs build watch",
    // Daily, so the run is due whatever weekday the evals run on.
    trigger: { type: "schedule", cron: "7 8 * * *" },
    instruction: DOCS_CHECK,
  },
  recentRuns: quietRuns,
  triggerData: null,
};

/** The same watch, the day after a run told your user its GitHub sign-in had expired. */
const blockerReportedWake: Wake = {
  ...routineWake,
  recentRuns: [
    {
      at: daysAgo(1),
      outcome: {
        type: "delivered",
        text: "I couldn't check the docs build: GitHub sign-in expired (HTTP 401).",
      },
    },
    ...quietRuns.slice(1),
  ],
};

/** A date as the operator reads it, such as "Friday, 20 November 2026", or a part of it. */
const local = (when: DateTime.Utc, parts: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: DateTime.zoneToString(timeZone), ...parts }).format(
    DateTime.toDateUtc(when),
  );

/** A one-time reminder, as the skill would save "remind me at 9 to submit my expenses". */
const reminderAt = todayAt(9, 0);
const reminderWake: Wake = {
  ...base,
  at: reminderAt,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-2"),
    name: "Expense report reminder",
    trigger: { type: "once" },
    instruction: `Remind your user to submit their ${local(reminderAt, { month: "long" })} expense report in the Acme expenses portal; it is due on ${local(reminderAt, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} at 18:00. Send them one short message saying so.`,
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

/** `gh run list` or `gh run view`. */
const READS_RUNS = /\bgh\s+run\s+(list|view)\b/;
/** A `gh api` call on acme/docs's workflow runs or jobs. */
const READS_RUNS_API = /\bgh\s+api\b.*\brepos\/acme\/docs\/actions\/(runs|jobs)\b/;
const WRITES = /\b(rerun|cancel|delete)\b|(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i;
/** Fields make `gh api` send a POST, unless the method is given as GET. */
const API_FIELDS = /\s(-f|-F|--field|--raw-field|--input)\b/;
const API_GET = /(-X|--method)\s*GET\b/i;

/** A read-only look at the build. */
const checksBuild = (command: string): boolean =>
  !WRITES.test(command) &&
  (READS_RUNS.test(command) ||
    (READS_RUNS_API.test(command) && (!API_FIELDS.test(command) || API_GET.test(command))));

const UNAVAILABLE = "sh: this command is not available in this workspace";
const GH_NOT_FOUND = "gh: Not Found (HTTP 404)";

/** A shell that answers `output` to a read-only look at the build, and an error to anything else. */
const buildShell =
  (output: string) =>
  (command: string): string =>
    checksBuild(command) ? output : /\bgh\b/.test(command) ? GH_NOT_FOUND : UNAVAILABLE;

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
  /\b((end|finish|stop)s?( \w+){0,3} (silently|quietly|without|with no)|(stay|remain|keep)s? (quiet|silent)|(say|send|report)s? nothing|(don['’]t|do not|never) (send|say|message|tell|notify|reply|report|speak|call))\b/i;

/** Words that mark a clause about the healthy case: the build passed, nothing changed, an all-clear. */
const HEALTHY =
  /\b(passing|passes|passed|green|succeed(s|ed)?|success(ful)?|((has|did|is) )?not (fail(ed|ing)?|broken|red)|nothing (is )?(new|wrong)|all[- ]clear|all (is )?(well|good|fine))\b/i;
const OTHERWISE = /\botherwise\b/i;
const FAILURE = /\b(fail\w*|broken|red|problem|error|wrong)\b/i;
/** Words that make a clause conditional. */
const CONDITIONAL = /\b(if|when|whenever|only|unless)\b/i;
/** Words that make a clause hold on every run. */
const EVERY_RUN = /\b(every|each|always|regardless|anyway)\b/i;

/**
 * The condition a clause opens with: what follows "if" or "when", up to a
 * colon or a comma that does not go on with "or" or "and".
 */
const CONDITION = /\b(?:if|when|whenever)\b((?:[^,:]|,\s*(?:or|and)\b)*)/i;
const HEALTHY_ALL = new RegExp(HEALTHY.source, "gi");

/**
 * Whether a clause is about the healthy case. A clause with a condition is
 * judged by that condition alone: it names the healthy case and no failure
 * beside it, so "if it is not failed" is healthy and "if it failed, or is
 * anything other than a success" is not. One without is judged whole, and
 * "otherwise" counts only when the clause does not name a failure.
 */
const isHealthy = (clause: string): boolean => {
  const condition = CONDITION.exec(clause)?.[1];
  if (condition !== undefined) {
    return HEALTHY.test(condition) && !FAILURE.test(condition.replace(HEALTHY_ALL, ""));
  }
  return HEALTHY.test(clause) || (OTHERWISE.test(clause) && !FAILURE.test(clause));
};

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

/**
 * Problems with how an instruction handles the healthy case: it must say to
 * stay silent then, send nothing in a clause about it, and send nothing in a
 * clause that holds on every run with no condition ("on every check send an
 * update").
 */
const quietDeliveryProblems = (instruction: string): ReadonlyArray<string> => {
  const clauses = instruction.split(/[.;]/);
  const healthy = clauses.filter(isHealthy);
  const problems: Array<string> = [];
  if (!healthy.some((clause) => SILENCE.test(clause))) {
    problems.push("the instruction does not say to stay silent when nothing is wrong");
  }
  if (healthy.some(sendsAnyway)) {
    problems.push("the instruction sends a message when nothing is wrong");
  }
  const unconditional = clauses.filter(
    (clause) => EVERY_RUN.test(clause) && !CONDITIONAL.test(clause) && sendsAnyway(clause),
  );
  if (unconditional.length > 0) {
    problems.push(
      `the instruction sends a message on every run: ${JSON.stringify(unconditional[0]?.trim())}`,
    );
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

/** Problems with a routine run that must look at the build before it speaks. */
const speaksAfterCheck = (calls: ReadonlyArray<Call>): ReadonlyArray<string> => {
  const checked = firstBuildCheck(calls);
  if (checked === -1) return ["never looked at the build"];
  const first = named(calls, "say")[0];
  return first !== undefined && calls.indexOf(first) < checked
    ? ["spoke before looking at the build"]
    : [];
};

/** Problems with a routine run that must stay silent. */
const silentRun = (calls: ReadonlyArray<Call>): ReadonlyArray<string> => [
  ...(firstBuildCheck(calls) === -1 ? ["never looked at the build"] : []),
  ...["say", "ask", "message_bot", "set_routine"].flatMap((name) =>
    named(calls, name).length > 0 ? [`called \`${name}\``] : [],
  ),
];

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
      // The turn opens with a `say`, then looks for an existing routine before it creates one.
      if (says(calls)[0]?.call !== calls[0]) problems.push("the first call is not a `say`");
      const listed = calls.findIndex((candidate) => candidate.name === "list_routines");
      if (listed === -1 || listed > calls.indexOf(call)) {
        problems.push("`list_routines` was not called before the routine was created");
      }
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
    problems: silentRun,
  },
  {
    name: "speaks once in a routine run when something is worth saying",
    scenario: { wake: routineWake, shell: buildShell(FAILING) },
    problems: (calls) => [
      ...speaksAfterCheck(calls),
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
    problems: (calls) => [
      ...speaksAfterCheck(calls),
      ...speaksOnce(
        calls,
        /\b(auth\w*|credentials?|token|sign(ed)?[- ]?(in|out)|log(ged)?[- ]?(in|out)|access|401|permission)\b/i,
        "name the access problem",
      ),
    ],
  },
  {
    name: "stays silent when a recent run already said what blocks it",
    scenario: { wake: blockerReportedWake, shell: signedOutShell },
    problems: silentRun,
  },
];

describe("the quiet-delivery check", () => {
  it.each([
    DOCS_CHECK,
    "If the latest run on main failed, message your user with the job name. Otherwise end silently.",
    "If the build is red, tell your user what broke; if it is green, do not send an all-clear.",
    "If the latest run failed, send Rui one short message naming it. If it is not failed, end silently without messaging.",
    "If the latest run has been going for more than 30 minutes, message your user. If it passed, say nothing. Keep the message to two short sentences.",
    "Report only if the latest run concluded with failure, or if its conclusion is anything other than success. If the build is green, end without sending anything at all.",
    'If its status is "in_progress" or "queued", or its conclusion is "success", it is not red: end the run without sending anything. If red, send Rui one short message. Otherwise end the run with no message at all.',
  ])("accepts %j", (instruction) => {
    expect(quietDeliveryProblems(instruction)).toEqual([]);
  });

  it.each([
    "If the build fails, tell your user. If it passes, don't send a failure alert, but send an all-clear.",
    "If it fails, message your user. Do not message anyone else.",
    "If the build is passing, tell your user it is green.",
    "If it passes, say nothing. On every check send an update.",
    "Send your user the build status every morning. If it passed, end silently.",
  ])("rejects %j", (instruction) => {
    expect(quietDeliveryProblems(instruction)).not.toEqual([]);
  });
});

describe.each(MODELS)("%s", (model) => {
  it.concurrent.each(cases)("$name", async ({ scenario, problems }) => {
    const turn = await Effect.runPromise(runTurn(model, scenario));
    expect(problems(turn.calls), transcript(turn)).toEqual([]);
  });
});
