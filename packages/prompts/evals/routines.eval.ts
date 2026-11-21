// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId } from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  DECODE_OPTIONS,
  type RoutineRunSummary,
  type RoutineWake,
  type ToolInput,
  tools,
  type Wake,
} from "../src/index.ts";
import {
  type FixtureEvent,
  type GitHub,
  githubWorkspace,
  type PullRequest,
  type Run,
} from "./fixtures.ts";
import {
  type Call,
  CREATED_ROUTINE_ID,
  nextRunAt,
  runTurn,
  type Scenario,
  type Skills,
  transcript,
  type Turn,
} from "./harness.ts";
import { judge } from "./judge.ts";
import { HOME } from "./shell.ts";

// The routine skill's evals: given the base prompt, with the skill and without
// it, a model creates a routine for recurring work whose saved instruction,
// replayed as a run, stays silent on a passing build and reports a failing
// one; creates none for a one-off request; and in a routine run stays silent
// when a condition is not met, but speaks when it is, when a reminder is due,
// and when it could not do the work, unless a recent run already said what
// blocks it; a watch for an event reports it and then pauses itself; a run
// that keeps a state file writes it only after its message is recorded. Each
// case is one turn per model and skill column, scored on what its tool calls
// did.

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

// acme/docs, as the stand-in `gh` serves it.

const PASSING_RUNS: ReadonlyArray<Run> = [
  {
    id: 1042,
    title: "Fix typo in setup guide",
    conclusion: "success",
    elapsed: "3m12s",
    minutesAgo: 62,
    jobs: [
      { id: 5420, name: "build", conclusion: "success", duration: "2m05s" },
      { id: 5421, name: "link-check", conclusion: "success", duration: "58s" },
    ],
  },
  {
    id: 1041,
    title: "Bump theme to 4.2",
    conclusion: "success",
    elapsed: "3m40s",
    minutesAgo: 1_510,
    jobs: [
      { id: 5410, name: "build", conclusion: "success", duration: "2m21s" },
      { id: 5411, name: "link-check", conclusion: "success", duration: "1m04s" },
    ],
  },
];

const FAILING_RUNS: ReadonlyArray<Run> = [
  {
    id: 1043,
    title: "Add pricing page",
    conclusion: "failure",
    elapsed: "2m40s",
    minutesAgo: 31,
    jobs: [
      { id: 5430, name: "build", conclusion: "success", duration: "1m31s" },
      {
        id: 5431,
        name: "link-check",
        conclusion: "failure",
        duration: "1m02s",
        failure: {
          step: "Check links",
          path: "guides/pricing.md",
          error: "link to /plans returns 404",
        },
      },
    ],
  },
  ...PASSING_RUNS,
];

/** What a report of the failing build names: the failing job or its error. */
const FAILURE_NAMED = /pricing|link|404/i;
/** A message that says the build failed, in any words, as a saved instruction may ask for no more. */
const FAILURE_SAID = /\b(fail\w*|red|broken|pricing|link-check|404)\b/i;

const PULL_REQUESTS: ReadonlyArray<PullRequest> = [
  {
    number: 125,
    title: "Fix broken anchors in FAQ",
    author: "lena",
    branch: "faq-anchors",
    state: "open",
    minutesAgo: 20,
  },
  {
    number: 124,
    title: "Document the new search API",
    author: "omar",
    branch: "search-api",
    state: "open",
    minutesAgo: 40,
  },
  {
    number: 121,
    title: "Add French translation of quickstart",
    author: "claire",
    branch: "quickstart-fr",
    state: "open",
    minutesAgo: 75,
  },
  {
    number: 118,
    title: "Update install guide for Node 22",
    author: "dana",
    branch: "node-22",
    state: "open",
    minutesAgo: 1_500,
  },
  {
    number: 12,
    title: "Move the API reference to the new layout",
    author: "mira",
    branch: "api-layout",
    state: "merged",
    minutesAgo: 9_000,
    mergedMinutesAgo: 25,
  },
];

const github = (now: DateTime.Utc, runs: ReadonlyArray<Run>, signedIn = true): GitHub => ({
  now,
  runs,
  pullRequests: PULL_REQUESTS,
  signedIn,
});

const buildWorkspace = (wake: Wake, runs: ReadonlyArray<Run>) => () =>
  githubWorkspace(github(wake.at, runs));

/** A workspace whose GitHub sign-in has expired. */
const signedOutWorkspace = (wake: Wake) => () =>
  githubWorkspace(github(wake.at, PASSING_RUNS, false));

// Routine wakes.

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

const routineWake: RoutineWake = {
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
const blockerReportedWake: RoutineWake = {
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
const reminderWake: RoutineWake = {
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

/** The state file a pull-request watch keeps, and what it holds before this run. */
const STATE_FILE = "files/docs-prs.json";
const STATE_PATH = `${HOME}/${STATE_FILE}`;
const STATE = JSON.stringify({ reported: [118, 121] });
/** What it must hold after the run: every open pull request. */
const REPORTED_AFTER = [118, 121, 124, 125];

/** An hourly watch for new pull requests that keeps what it reported in a state file, as the skill teaches. */
const pullRequestWake: RoutineWake = {
  ...base,
  at: todayAt(10, 17),
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-3"),
    name: "New docs pull requests",
    trigger: { type: "schedule", cron: "17 8-18 * * *" },
    instruction: `Tell your user about pull requests on the GitHub repository acme/docs that they have not heard about yet. The file ${STATE_FILE} lists, under "reported", the numbers of the open pull requests already reported; read it first. If an open pull request is not in that list, send your user one short message naming each new one by number and title; if there is none, end without saying anything. Do not comment on, review or merge anything. As your last step, once your message is recorded, write the numbers of all open pull requests to "reported" in ${STATE_FILE}; if the message could not be sent, leave the file as it is.`,
  },
  recentRuns: [
    {
      at: todayAt(9, 17),
      outcome: {
        type: "delivered",
        text: "New on acme/docs: #121 Add French translation of quickstart.",
      },
    },
    { at: todayAt(8, 17), outcome: { type: "silent", note: null } },
  ],
  triggerData: null,
};

const pullRequestWorkspace = () =>
  githubWorkspace(github(pullRequestWake.at, PASSING_RUNS), new Map([[STATE_FILE, STATE]]));

/** "Let me know when PR #12 merges", saved as the skill teaches; #12 merged 25 minutes ago. */
const mergeWatchWake: RoutineWake = {
  ...base,
  at: todayAt(10, 34),
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-4"),
    name: "PR #12 merge watch",
    trigger: { type: "schedule", cron: "4,34 8-19 * * *" },
    instruction:
      "Check whether pull request #12 on the GitHub repository acme/docs has been merged. Do not comment on, review or merge anything. If it has merged, send your user one short message saying so, then pause this routine. If it is still open, end without saying anything.",
  },
  recentRuns: [
    { at: todayAt(10, 4), outcome: { type: "silent", note: null } },
    { at: todayAt(9, 34), outcome: { type: "silent", note: null } },
  ],
  triggerData: null,
};

// What a turn did.

const named = (calls: ReadonlyArray<Call>, name: string) =>
  calls.filter((call) => call.name === name);

const did = (call: Call, test: (event: FixtureEvent) => boolean): boolean => call.events.some(test);

/** A `run_command` that showed acme/docs's CI runs, jobs or logs. */
const looksAtBuild = (call: Call) => did(call, (event) => event.type === "build-read");
/** A `run_command` that ran `gh` at all: with an expired sign-in, each one meets the 401. */
const triesGh = (call: Call) => did(call, (event) => event.type === "gh");

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

/** A `pause` of the routine that is running: the one `set_routine` a run may make. */
const pausesItself = (call: Call, wake: RoutineWake): boolean =>
  call.routine?.action === "pause" && call.routine.id === wake.routine.id;

/**
 * Problems with a call that depends on what `source` returned: it must exist,
 * and come in a later model message, since calls sent together are written
 * before any of them returns.
 */
const after = (
  source: Call | undefined,
  dependent: Call | undefined,
  what: { readonly source: string; readonly dependent: string },
): ReadonlyArray<string> =>
  source === undefined
    ? [`never ${what.source}`]
    : dependent !== undefined && dependent.step <= source.step
      ? [`${what.dependent} in the same message as it ${what.source}, or before`]
      : [];

/**
 * What no routine run may do: `ask`, `message_bot`, change anything on
 * GitHub, or call `set_routine` other than to pause its own routine.
 */
const runRules = (calls: ReadonlyArray<Call>, wake: RoutineWake): ReadonlyArray<string> => [
  ...["ask", "message_bot"].flatMap((name) =>
    named(calls, name).length > 0 ? [`called \`${name}\``] : [],
  ),
  ...(named(calls, "set_routine").some((call) => !pausesItself(call, wake))
    ? ["called `set_routine` other than to pause its own routine"]
    : []),
  ...calls.flatMap((call) =>
    call.events.flatMap((event) =>
      event.type === "gh-change" ? [`tried to change GitHub: ${event.command}`] : [],
    ),
  ),
];

/** Problems with a routine run that must look, with a call `looks` accepts, and stay silent. */
const silentRun =
  (wake: RoutineWake, looks: (call: Call) => boolean, what: string) =>
  (calls: ReadonlyArray<Call>): ReadonlyArray<string> => [
    ...(calls.some(looks) ? [] : [`never ${what}`]),
    ...(named(calls, "say").length > 0 ? ["called `say`"] : []),
    ...runRules(calls, wake),
  ];

/**
 * Problems with a routine run that must speak exactly once, about what
 * `mentions` matches, and, when `looks` is given, only in a later message
 * than a call it accepts.
 */
const speaksOnce =
  (
    wake: RoutineWake,
    mentions: RegExp,
    what: string,
    looks?: { readonly test: (call: Call) => boolean; readonly what: string },
  ) =>
  (calls: ReadonlyArray<Call>): ReadonlyArray<string> => {
    const said = named(calls, "say");
    return [
      ...(looks === undefined
        ? []
        : after(calls.find(looks.test), said[0], { source: looks.what, dependent: "spoke" })),
      ...(said.length === 1 ? [] : [`called \`say\` ${said.length} times, not once`]),
      ...(says(calls).some(({ say }) => mentions.test(say.text))
        ? []
        : [`the message does not ${what}`]),
      ...runRules(calls, wake),
    ];
  };

/** A turn's problems under a heading, with its transcript, as one line of a case's report. */
const reported = (heading: string, turn: Turn, problems: ReadonlyArray<string>) =>
  problems.length === 0 ? [] : [`${heading}: ${problems.join("; ")}\n${transcript(turn)}`];

/** The id the server gives the routine the setup turn creates. */
const CREATED_ID = Schema.decodeSync(RoutineId)(CREATED_ROUTINE_ID);

const BUILD_LOOK = { test: looksAtBuild, what: "looked at the build" } as const;

/**
 * Runs a routine the setup turn saved as the server would: at its next run,
 * with its own id and instruction and no earlier runs, once on a passing
 * build, where it must end with no `say`, and once on a failing one, where it
 * must report the failure in one `say` after looking. This is what shows the
 * instruction stands alone and handles the healthy case, whatever its words.
 */
const replay = Effect.fn("evals.replay")(function* (
  model: string,
  skills: Skills,
  setup: Wake,
  routine: ToolInput<"set_routine">,
) {
  const next = nextRunAt(routine, setup);
  if (next === null || next === undefined || routine.instruction === undefined) {
    return ["the saved routine has no next run or no instruction to replay"];
  }
  const wake: RoutineWake = {
    at: next,
    timeZone,
    sinceLastTurn: [],
    kind: "routine",
    routine: {
      id: CREATED_ID,
      name: routine.name ?? "",
      trigger:
        routine.schedule === undefined
          ? { type: "once" }
          : { type: "schedule", cron: routine.schedule },
      instruction: routine.instruction,
    },
    recentRuns: [],
    triggerData: null,
  };
  const run = (
    heading: string,
    runs: ReadonlyArray<Run>,
    problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>,
  ) =>
    runTurn(model, skills, { wake, workspace: buildWorkspace(wake, runs) }).pipe(
      Effect.map((turn) => reported(heading, turn, problems(turn.calls))),
      Effect.catchTag("TurnUnfinished", (error) =>
        Effect.succeed([`${heading}: ${error.message}`]),
      ),
    );
  const results = yield* Effect.all(
    [
      run(
        "the saved instruction, run on a passing build",
        PASSING_RUNS,
        silentRun(wake, looksAtBuild, "looked at the build"),
      ),
      run(
        "the saved instruction, run on a failing build",
        FAILING_RUNS,
        speaksOnce(wake, FAILURE_SAID, "say the build failed", BUILD_LOOK),
      ),
    ],
    { concurrency: 2 },
  );
  return results.flat();
});

/** 8 in the morning: "8:00", "08:00", "8am", "8 a.m.", or a bare 8 beside "morning"; never 8 p.m. */
const confirmsMorningEight = (text: string): boolean =>
  !/\b0?8(:00)?\s*p\.?m\b|\b20:00\b/i.test(text) &&
  (/\b0?8:00\b/.test(text) ||
    /\b0?8\s*a\.?m\b/i.test(text) ||
    (/\b0?8\b(?!:\d)/.test(text) && /\bmorning/i.test(text)));

/** Every weekday, Monday to Friday, not a single day. */
const confirmsWeekdays = (text: string): boolean =>
  /\b(weekdays?|work ?days?|mon(day)?s?\s*(-|–|—|to|through|thru)\s*fri(day)?s?)\b/i.test(text);

/** Problems with the setup turn's own calls: their order, the schedule, and the confirmation. */
const setupProblems = (
  calls: ReadonlyArray<Call>,
  { call, routine }: { readonly call: Call; readonly routine: ToolInput<"set_routine"> },
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  // The turn opens with a `say`, then looks for an existing routine before it creates one.
  if (says(calls)[0]?.call !== calls[0]) problems.push("the first call is not a `say`");
  problems.push(
    ...after(named(calls, "list_routines")[0], call, {
      source: "called `list_routines`",
      dependent: "created the routine",
    }),
  );
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
  // The turn ends on a `say` with `done: true`, sent once the routine was saved, confirming it.
  const last = calls.at(-1);
  const closing = says(calls).find((said) => said.call === last);
  if (closing === undefined) {
    problems.push("the turn does not end with a `say`");
    return problems;
  }
  problems.push(
    ...after(call, closing.call, {
      source: "saved the routine",
      dependent: "confirmed it",
    }),
  );
  if (closing.say.done !== true) problems.push("the closing `say` does not carry `done: true`");
  if (!confirmsMorningEight(closing.say.text)) {
    problems.push("the closing `say` does not confirm 8:00 in the morning");
  }
  if (!confirmsWeekdays(closing.say.text)) {
    problems.push("the closing `say` does not confirm Monday to Friday");
  }
  return problems;
};

/** The one-off question, and the question the judge answers about the bot's answer to it. */
const ONE_OFF = "is the docs build green right now? the release goes out at noon";
const PASSING_QUESTION =
  "Does this message tell its reader that the docs build is green, that is, that its latest run passed?";

/** The open pull requests the state file does not list yet, as a message would name them. */
const NEW_PULL_REQUESTS = [/#?\b124\b|search API/i, /#?\b125\b|anchors/i];

const decodeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reported: Schema.Array(Schema.Number) })),
);

/**
 * Problems with the pull-request watch's run: it reads the state file and the
 * open pull requests, then, in a later message, reports the two new ones in
 * exactly one `say`; once that `say` is recorded, in a later message, it
 * writes the state file, which ends listing every open pull request.
 */
const stateRunProblems = (calls: ReadonlyArray<Call>): ReadonlyArray<string> => {
  const said = named(calls, "say");
  const [message] = said;
  const writes = calls.flatMap((call) =>
    call.events.flatMap((event) =>
      event.type === "file-write" && event.path === STATE_PATH
        ? [{ call, content: event.content }]
        : [],
    ),
  );
  const problems: Array<string> = [
    ...after(
      calls.find((call) =>
        did(call, (event) => event.type === "file-read" && event.path === STATE_PATH),
      ),
      message,
      { source: "read the state file", dependent: "spoke" },
    ),
    ...after(
      calls.find((call) => did(call, (event) => event.type === "pull-requests-read")),
      message,
      { source: "listed the open pull requests", dependent: "spoke" },
    ),
    ...runRules(calls, pullRequestWake),
  ];
  if (said.length !== 1 || message === undefined) {
    return [...problems, `called \`say\` ${said.length} times, not once`];
  }
  const text = says(calls).find(({ call }) => call === message)?.say.text ?? "";
  if (!NEW_PULL_REQUESTS.every((pull) => pull.test(text))) {
    problems.push("the message does not name both new pull requests, #124 and #125");
  }
  const last = writes.at(-1);
  if (last === undefined) return [...problems, "never wrote the state file"];
  if (writes.some(({ call }) => call.step <= message.step)) {
    problems.push("wrote the state file before its message was recorded");
  }
  const state = decodeState(last.content);
  const reportedNumbers =
    state._tag === "Some" ? state.value.reported.toSorted((a, b) => a - b) : undefined;
  if (JSON.stringify(reportedNumbers) !== JSON.stringify(REPORTED_AFTER)) {
    problems.push(
      `the state file ends as ${JSON.stringify(last.content)}, not listing ${REPORTED_AFTER.join(", ")} under "reported"`,
    );
  }
  return problems;
};

/**
 * Problems with the merge watch's run: it looks at #12, then, in a later
 * message, says once that it merged, and, once that `say` is recorded, in a
 * later message, pauses its own routine.
 */
const mergeRunProblems = (calls: ReadonlyArray<Call>): ReadonlyArray<string> => {
  const [message] = named(calls, "say");
  const pauses = named(calls, "set_routine").filter((call) => pausesItself(call, mergeWatchWake));
  const [pause] = pauses;
  return [
    ...speaksOnce(mergeWatchWake, /\bmerged?\b/i, "say that #12 merged", {
      test: (call) =>
        did(
          call,
          (event) =>
            (event.type === "pull-request-read" && event.number === 12) ||
            event.type === "pull-requests-read",
        ),
      what: "looked at #12",
    })(calls),
    ...(pauses.length === 1 ? [] : [`paused its routine ${pauses.length} times, not once`]),
    ...(message === undefined || pause === undefined
      ? []
      : after(message, pause, { source: "spoke", dependent: "paused its routine" })),
  ];
};

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  /** What is wrong with the turn; empty when it passes. */
  readonly problems: (
    turn: Turn,
    run: { readonly model: string; readonly skills: Skills },
  ) => Effect.Effect<
    ReadonlyArray<string>,
    Effect.Error<ReturnType<typeof runTurn | typeof judge>>
  >;
}

/** A case whose problems the turn's own calls show. */
const fromCalls =
  (problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>): Case["problems"] =>
  (turn) =>
    Effect.succeed(problems(turn.calls));

const setupWake = userWake(
  "the docs build broke twice this week and nobody noticed until customers did. from now on can you check it every weekday morning at 8 and only bother me if it's red?",
);

const cases: ReadonlyArray<Case> = [
  {
    name: "creates a routine for recurring work, whose saved instruction runs silent on a passing build and reports a failing one",
    scenario: { wake: setupWake, workspace: buildWorkspace(setupWake, PASSING_RUNS) },
    problems: Effect.fn("evals.setupCase")(function* ({ calls }, { model, skills }) {
      const routines = created(calls);
      const [first] = routines;
      if (routines.length !== 1 || first === undefined) {
        return [`${routines.length} accepted \`set_routine\` creates, not one`];
      }
      return [
        ...setupProblems(calls, first),
        ...(yield* replay(model, skills, setupWake, first.routine)),
      ];
    }),
  },
  {
    name: "answers a one-off request in the turn from a check of the build, with no routine",
    scenario: (() => {
      const wake = userWake(ONE_OFF);
      return { wake, workspace: buildWorkspace(wake, PASSING_RUNS) };
    })(),
    problems: Effect.fn("evals.oneOffCase")(function* ({ calls }) {
      const checked = calls.find(looksAtBuild);
      const answer = says(calls).find(
        ({ call, say }) => say.done === true && checked !== undefined && call.step > checked.step,
      );
      const problems = [
        ...(named(calls, "set_routine").length > 0 ? ["called `set_routine`"] : []),
        ...(checked === undefined ? ["never checked the build"] : []),
      ];
      if (answer === undefined) {
        return [
          ...problems,
          "no `say` with `done: true` in a message after the check delivered the answer",
        ];
      }
      return (yield* judge(ONE_OFF, answer.say.text, PASSING_QUESTION))
        ? problems
        : [...problems, `the judge did not read the answer as passing: "${answer.say.text}"`];
    }),
  },
  {
    name: "keeps a routine run silent when nothing is worth saying",
    scenario: { wake: routineWake, workspace: buildWorkspace(routineWake, PASSING_RUNS) },
    problems: fromCalls(silentRun(routineWake, looksAtBuild, "looked at the build")),
  },
  {
    name: "speaks once in a routine run when something is worth saying",
    scenario: { wake: routineWake, workspace: buildWorkspace(routineWake, FAILING_RUNS) },
    problems: fromCalls(speaksOnce(routineWake, FAILURE_NAMED, "say what failed", BUILD_LOOK)),
  },
  {
    name: "sends a due reminder exactly once",
    scenario: { wake: reminderWake, workspace: buildWorkspace(reminderWake, PASSING_RUNS) },
    problems: fromCalls(speaksOnce(reminderWake, /expense/i, "remind about the expense report")),
  },
  {
    name: "says once what blocked a routine run that lost its access",
    scenario: { wake: routineWake, workspace: signedOutWorkspace(routineWake) },
    problems: fromCalls(
      speaksOnce(
        routineWake,
        /\b(auth\w*|credentials?|token|sign(ed)?[- ]?(in|out)|log(ged)?[- ]?(in|out)|access|401|permission)\b/i,
        "name the access problem",
        { test: triesGh, what: "ran `gh`" },
      ),
    ),
  },
  {
    name: "stays silent when a recent run already said what blocks it",
    scenario: { wake: blockerReportedWake, workspace: signedOutWorkspace(blockerReportedWake) },
    problems: fromCalls(silentRun(blockerReportedWake, triesGh, "ran `gh`")),
  },
  {
    name: "reports new pull requests once, then records them in its state file",
    scenario: { wake: pullRequestWake, workspace: pullRequestWorkspace },
    problems: fromCalls(stateRunProblems),
  },
  {
    name: "reports the event a watch waits for once, then pauses its own routine",
    scenario: { wake: mergeWatchWake, workspace: buildWorkspace(mergeWatchWake, PASSING_RUNS) },
    problems: fromCalls(mergeRunProblems),
  },
];

describe("the judge, on fixed answers to whether the build is passing", () => {
  it.concurrent.each([
    "Yes, it's green: the latest run on main passed about an hour ago.",
    "It's green. The previous red build was fixed yesterday.",
    "Yes. Both recent runs on main succeeded.",
    "Yes, green. The latest run on main passed an hour ago. I only checked main, not open pull requests.",
  ])("reads %j as passing", async (text) => {
    expect(await Effect.runPromise(judge(ONE_OFF, text, PASSING_QUESTION))).toBe(true);
  });

  it.concurrent.each([
    "It looks green but I couldn't confirm",
    "I can't verify that the build passed",
    "No, the latest run on main failed on link-check.",
    "The build is no longer passing.",
  ])("does not read %j as passing", async (text) => {
    expect(await Effect.runPromise(judge(ONE_OFF, text, PASSING_QUESTION))).toBe(false);
  });
});

describe("the stand-in workspace", () => {
  const run = (command: string) => githubWorkspace(github(runAt, FAILING_RUNS)).run(command);
  const types = (command: string) => run(command).events.map((event) => event.type);

  it("runs no `gh` that a command only prints, and counts one inside `$(…)`", () => {
    expect(types("echo 'gh run list -R acme/docs'")).toEqual([]);
    expect(types('echo "latest: $(gh run list -R acme/docs -L 1)"')).toEqual(["gh", "build-read"]);
  });

  it("has no runs on another branch", () => {
    const other = run("gh run list -R acme/docs --branch release");
    expect(other.output).toBe("no runs found\n");
    expect(other.events.map((event) => event.type)).toEqual(["gh"]);
  });

  it("refuses a change to GitHub, and says so for what it does not support", () => {
    expect(types("gh run rerun 1043 -R acme/docs")).toEqual(["gh", "gh-change"]);
    expect(run("gh run list -R acme/docs --jq '.[0]'").output).toMatch(/not available/);
    expect(run("jq . files/x.json").output).toMatch(/command not found/);
  });

  it("keeps a file written with a here-document for later commands", () => {
    const workspace = githubWorkspace(github(runAt, FAILING_RUNS));
    const write = workspace.run(`cat > ${STATE_FILE} <<'EOF'\n{"reported":[1]}\nEOF`);
    expect(write.events).toEqual([
      { type: "file-write", path: STATE_PATH, content: "" },
      { type: "file-write", path: STATE_PATH, content: '{"reported":[1]}\n' },
    ]);
    expect(workspace.run(`cat ./${STATE_FILE}`).output).toBe('{"reported":[1]}\n');
  });
});

describe("the state-file run check", () => {
  const call = (
    step: number,
    name: string,
    input: unknown,
    events: ReadonlyArray<FixtureEvent> = [],
  ): Call => ({
    step,
    name,
    input,
    output: "",
    events,
  });
  const look = [
    call(1, "run_command", {}, [{ type: "file-read", path: STATE_PATH }]),
    call(1, "run_command", {}, [{ type: "gh" }, { type: "pull-requests-read" }]),
  ];
  const say = (step: number, text: string) => call(step, "say", { text, done: true });
  const report =
    "New on acme/docs: #124 Document the new search API, #125 Fix broken anchors in FAQ.";
  const write = (step: number, numbers: ReadonlyArray<number> = REPORTED_AFTER) =>
    call(step, "run_command", {}, [
      { type: "file-write", path: STATE_PATH, content: JSON.stringify({ reported: numbers }) },
    ]);

  it("accepts a write of every open pull request in a later message", () => {
    expect(stateRunProblems([...look, say(2, report), write(3)])).toEqual([]);
  });

  it.each([
    ["no write", [...look, say(2, report)]],
    ["a write in the same message", [...look, say(2, report), write(2)]],
    ["a write before the message and after it", [...look, write(2), say(3, report), write(4)]],
    ["a write that leaves out #125", [...look, say(2, report), write(3, [118, 121, 124])]],
    ["a message sent with the reads", [...look, say(1, report), write(2)]],
    [
      "a message missing #125",
      [...look, say(2, "New: #124 Document the new search API."), write(3)],
    ],
  ])("rejects %s", (_, calls) => {
    expect(stateRunProblems(calls)).not.toEqual([]);
  });
});

const SKILL_COLUMNS: ReadonlyArray<Skills> = ["with the skill", "without the skill"];

describe.each(MODELS)("%s", (model) => {
  describe.each(SKILL_COLUMNS)("%s", (skills) => {
    it.concurrent.each(cases)("$name", async ({ scenario, problems }) => {
      const turn = await Effect.runPromise(runTurn(model, skills, scenario));
      expect(await Effect.runPromise(problems(turn, { model, skills })), transcript(turn)).toEqual(
        [],
      );
    });
  });
});
