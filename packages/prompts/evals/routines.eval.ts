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
  firstRun,
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
// blocks it. A "let me know when" request becomes a watch whose saved
// instruction, replayed, stays silent while the event has not happened,
// reports it once and then pauses itself, and pauses without a word when a
// recent run already reported it. A run that keeps a state file leaves it
// updated, written only after its message was recorded.
//
// Each case is one turn per model and skill column, scored on what its tool
// calls did. What a message means is read by the judge (`judge.ts`), on fixed
// questions whose reading is checked on fixed messages below. The graders
// read structure: the order of calls, schedules, ids and file content. The one
// place they look at a message's text is the pull-request digest, where they
// check that #124 and #125 appear as numbers; whether the message reports
// them as new is the judge's. After a run's message, only read-only calls and
// what its case permits may follow.

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

const OPEN_PULL_REQUESTS: ReadonlyArray<PullRequest> = [
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
];

/** Pull request #12, still open. */
const TWELVE_OPEN: PullRequest = {
  number: 12,
  title: "Move the API reference to the new layout",
  author: "mira",
  branch: "api-layout",
  state: "open",
  minutesAgo: 9_000,
};

/** #12, merged `minutesAgo` minutes ago. */
const twelveMerged = (minutesAgo: number): PullRequest => ({
  ...TWELVE_OPEN,
  state: "merged",
  mergedMinutesAgo: minutesAgo,
});

const github = (
  now: DateTime.Utc,
  runs: ReadonlyArray<Run>,
  { signedIn = true, twelve = twelveMerged(25) }: { signedIn?: boolean; twelve?: PullRequest } = {},
): GitHub => ({
  now,
  runs,
  pullRequests: [...OPEN_PULL_REQUESTS, twelve],
  signedIn,
});

const buildWorkspace = (wake: Wake, runs: ReadonlyArray<Run>) => () =>
  githubWorkspace(github(wake.at, runs));

/** A workspace whose GitHub sign-in has expired. */
const signedOutWorkspace = (wake: Wake) => () =>
  githubWorkspace(github(wake.at, PASSING_RUNS, { signedIn: false }));

/** A workspace where #12 is as `twelve` says. */
const twelveWorkspace = (wake: Wake, twelve: PullRequest) => () =>
  githubWorkspace(github(wake.at, PASSING_RUNS, { twelve }));

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
const REMINDER = `Remind your user to submit their ${local(reminderAt, { month: "long" })} expense report in the Acme expenses portal; it is due on ${local(reminderAt, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} at 18:00. Send them one short message saying so.`;
const reminderWake: RoutineWake = {
  ...base,
  at: reminderAt,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-2"),
    name: "Expense report reminder",
    trigger: { type: "once" },
    instruction: REMINDER,
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
/** The open pull requests the state file does not list yet. */
const NEW_PULL_REQUESTS = [124, 125];

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

// What a message means, as the judge reads it.

/**
 * A yes-or-no question the judge answers about a bot's message, with fixed
 * messages it must answer yes and no to on every eval run (`asked` is what
 * those fixed messages answer). They are worded the ways a bot might put it,
 * so a judge that only matches words, or reads past a negation, fails them.
 */
interface Check {
  readonly question: string;
  /** How a failure names what the message did not say. */
  readonly what: string;
  readonly asked: string;
  readonly accept: ReadonlyArray<string>;
  readonly reject: ReadonlyArray<string>;
}

/** The one-off question. */
const ONE_OFF = "is the docs build green right now? the release goes out at noon";

const BUILD_PASSING: Check = {
  question:
    "Does this message tell its reader that the docs build is green, that is, that its latest run passed?",
  what: "that the build is passing",
  asked: ONE_OFF,
  accept: [
    "Yes, it's green: the latest run on main passed about an hour ago.",
    "It's green. The previous red build was fixed yesterday.",
    "Yes. Both recent runs on main succeeded.",
    "Yes, green. The latest run on main passed an hour ago. I only checked main, not open pull requests.",
  ],
  reject: [
    "It looks green but I couldn't confirm",
    "I can't verify that the build passed",
    "No, the latest run on main failed on link-check.",
    "The build is no longer passing.",
  ],
};

const BUILD_FAILED: Check = {
  question:
    "Does this message tell its reader that the docs build failed, that is, that its latest run did not pass?",
  what: "that the build failed",
  asked: DOCS_CHECK,
  accept: [
    "The docs build on main broke (run 1043).",
    "It didn't pass.",
    "Heads-up: link-check is red on main, guides/pricing.md links to /plans, a 404.",
  ],
  reject: [
    "The build is green. No failures found.",
    "I couldn't check the docs build: GitHub sign-in expired (HTTP 401).",
    "It may have failed, I couldn't tell.",
  ],
};

const FAILURE_NAMED: Check = {
  question:
    "Does this message tell its reader that the docs build failed and name what failed in it: its link-check job, or the broken link to /plans?",
  what: "that the build failed and what failed",
  asked: DOCS_CHECK,
  accept: [
    "Docs build failed on main: link-check, guides/pricing.md links to /plans, which returns 404.",
    "Heads-up: the link checker is red; the new pricing page links to /plans, a 404.",
  ],
  reject: [
    "The docs build on main broke (run 1043).",
    "The build is green. No failures found.",
    "It may have failed, I couldn't tell.",
  ],
};

const REMINDED: Check = {
  question: "Does this message remind its reader to submit their expense report?",
  what: "a reminder to submit the expense report",
  asked: REMINDER,
  accept: [
    "Reminder: your expense report is due today at 18:00 in the Acme expenses portal.",
    "Don't forget the expenses portal: your report needs to be in by 18:00.",
  ],
  reject: [
    "Your expense report was submitted this morning.",
    "Good morning! Nothing is due today.",
  ],
};

const ACCESS_LOST: Check = {
  question:
    "Does this message tell its reader that the check could not be done because access to GitHub failed?",
  what: "that access to GitHub failed",
  asked: DOCS_CHECK,
  accept: [
    "I couldn't check the docs build: GitHub sign-in expired (HTTP 401).",
    "GitHub turned me away, so no build check today; the gh login needs renewing.",
  ],
  reject: ["The docs build is passing.", "Docs build failed on main: link-check hit a 404."],
};

const MERGED: Check = {
  question: "Does this message tell its reader that pull request #12 has merged?",
  what: "that #12 merged",
  asked:
    "Check whether pull request #12 on the GitHub repository acme/docs has merged. Once it has, tell your user in one short message, then pause this routine; while it is open, end without saying anything.",
  accept: [
    "PR #12 (Move the API reference to the new layout) merged about 25 minutes ago.",
    "#12 is in: mira's API reference move landed on main.",
  ],
  reject: ["#12 hasn't merged yet", "#12 is still waiting for review."],
};

const NEW_PULL_REQUESTS_REPORTED: Check = {
  question:
    "Does this message tell its reader that pull requests #124 (Document the new search API) and #125 (Fix broken anchors in FAQ) are new, naming each by its number and its title?",
  what: "that #124 and #125 are new, each by number and title",
  asked: pullRequestWake.routine.instruction,
  accept: [
    "New on acme/docs: #124 Document the new search API, #125 Fix broken anchors in FAQ.",
    "Two new pull requests on acme/docs: #125 (lena, Fix broken anchors in FAQ) and #124 (omar, Document the new search API).",
  ],
  reject: [
    "New on acme/docs: #124 Document the new search API.",
    "New on acme/docs: #124 and #125.",
    "#124 Document the new search API and #125 Fix broken anchors in FAQ are still open; you heard about both earlier.",
    "No new pull requests on acme/docs.",
  ],
};

/** The weekday docs check the setup turn is asked for. */
const SETUP =
  "the docs build broke twice this week and nobody noticed until customers did. from now on can you check it every weekday morning at 8 and only bother me if it's red?";

const WEEKDAYS_AT_EIGHT: Check = {
  question:
    "Does this message tell its reader the check will run every Monday to Friday at 8 in the morning (08:00)?",
  what: "every Monday to Friday at 8 in the morning",
  asked: SETUP,
  accept: [
    "Every weekday at 8 I'll check the docs build and tell you only if it's red.",
    "Done: every business day at eight in the morning I'll look at the docs build.",
    "Set up: Monday through Friday at eight in the morning I'll check the build and only message you if it's red.",
  ],
  reject: [
    "Every day at 8:00 I'll check the docs build and tell you only if it's red.",
    "Every weekday at 8 pm I'll check the docs build.",
    "Every Monday at 8:00 I'll check the docs build.",
  ],
};

const CHECKS: ReadonlyArray<Check> = [
  BUILD_PASSING,
  BUILD_FAILED,
  FAILURE_NAMED,
  REMINDED,
  ACCESS_LOST,
  MERGED,
  NEW_PULL_REQUESTS_REPORTED,
  WEEKDAYS_AT_EIGHT,
];

/** Problems with `text`, the bot's answer to `asked`, when the judge does not read it as `check` asks. */
const judged = Effect.fn("evals.judged")(function* (
  check: Check,
  asked: string,
  text: string,
  expected = true,
) {
  return (yield* judge(asked, text, check.question)) === expected
    ? []
    : [
        `the judge did not read the message as ${expected ? "" : "not "}saying ${check.what}: "${text}"`,
      ];
});

// What a turn did.

const named = (calls: ReadonlyArray<Call>, name: string) =>
  calls.filter((call) => call.name === name);

const did = (call: Call, test: (event: FixtureEvent) => boolean): boolean => call.events.some(test);

/** A call that reads what a case needs read, and how a failure names it. */
interface Look {
  readonly what: string;
  readonly test: (call: Call) => boolean;
}

/** A `run_command` that showed acme/docs's CI runs, jobs or logs. */
const BUILD_LOOK: Look = {
  what: "looked at the build",
  test: (call) => did(call, (event) => event.type === "build-read"),
};

/** A `run_command` that ran `gh` at all: with an expired sign-in, each one meets the 401. */
const GH_TRIED: Look = {
  what: "ran `gh`",
  test: (call) => did(call, (event) => event.type === "gh"),
};

/**
 * A read that returned #12: the pull request itself, or a list it is in. A
 * default list holds only open pull requests, so once #12 merged only a
 * merged, closed or full list, or #12 by number, shows it.
 */
const TWELVE_LOOK: Look = {
  what: "read pull request #12",
  test: (call) =>
    did(
      call,
      (event) =>
        (event.type === "pull-request-read" && event.number === 12) ||
        (event.type === "pull-requests-read" && event.numbers.includes(12)),
    ),
};

const decodeSay = Schema.decodeUnknownOption(tools.say.input, DECODE_OPTIONS);

/** The `say` calls the server would accept, decoded, in order. */
const says = (calls: ReadonlyArray<Call>) =>
  named(calls, "say").flatMap((call) => {
    const decoded = decodeSay(call.input);
    return decoded._tag === "Some" ? [{ call, say: decoded.value }] : [];
  });

/** The routine creates the turn sent that the schema accepted, as the server would read them. */
const creates = (calls: ReadonlyArray<Call>) =>
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
 * What no routine run may do, wherever in the turn: `ask`, `message_bot`,
 * change anything on GitHub, or call `set_routine` other than to pause its own
 * routine. Whether that pause is allowed is each case's to say.
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

/** A call a case permits once its message is sent, and how a failure names it. */
interface Permit {
  readonly what: string;
  readonly test: (call: Call) => boolean;
}

/**
 * A call that changes nothing, which any run may make after its message: a
 * `j3` tool that only reads, or a command that neither writes a file nor tries
 * to change GitHub, such as a `gh` read.
 */
const READ_ONLY: Permit = {
  what: "a read-only call",
  test: (call) =>
    ["list_routines", "recall", "list_teammates"].includes(call.name) ||
    (call.name === "run_command" &&
      call.events.every((event) => event.type !== "file-write" && event.type !== "gh-change")),
};

const pauseItself = (wake: RoutineWake): Permit => ({
  what: "a `pause` of its own routine",
  test: (call) => pausesItself(call, wake),
});

/**
 * The state-file update `instruction` names, which a run may make after its
 * message: a command that writes only files under `files/` whose paths the
 * instruction gives, and otherwise only reads.
 */
const stateUpdate = (instruction: string): Permit => ({
  what: "an update of a state file its instruction names",
  test: (call) =>
    call.name === "run_command" &&
    call.events.some((event) => event.type === "file-write") &&
    call.events.every(
      (event) =>
        event.type !== "gh-change" &&
        (event.type !== "file-write" ||
          (event.path.startsWith(`${HOME}/files/`) &&
            instruction.includes(event.path.slice(HOME.length + 1)))),
    ),
});

/**
 * Problems with the calls after `anchor`: each must be read-only or one that
 * `permits` allows, in a later model message, since it depends on `anchor`
 * having returned.
 */
const onlyPermitted = (
  calls: ReadonlyArray<Call>,
  anchor: Call,
  what: string,
  given: ReadonlyArray<Permit>,
): ReadonlyArray<string> => {
  const permits = [READ_ONLY, ...given];
  const allowed = permits.map((permit) => permit.what).join(" or ");
  return calls
    .slice(calls.indexOf(anchor) + 1)
    .flatMap((call) =>
      !permits.some((permit) => permit.test(call))
        ? [`called \`${call.name}\` after ${what}, where only ${allowed} may follow`]
        : call.step <= anchor.step
          ? [`called \`${call.name}\` in the same model message as ${what}`]
          : [],
    );
};

/** Problems with a routine run that must look, with a call `look` accepts, and end without a word or a pause. */
const silentRun =
  (wake: RoutineWake, look: Look) =>
  (calls: ReadonlyArray<Call>): ReadonlyArray<string> => [
    ...(calls.some(look.test) ? [] : [`never ${look.what}`]),
    ...(named(calls, "say").length > 0 ? ["called `say`"] : []),
    ...(calls.some((call) => pausesItself(call, wake))
      ? ["paused its own routine with nothing to report"]
      : []),
    ...runRules(calls, wake),
  ];

/**
 * A routine run that must speak: its first `say` is the message, carries
 * `done: true`, comes in a later model message than a call `look` accepts,
 * when given, and is followed only by what `permits` allows. A pause before
 * it is never right. Returns the problems and the message's text.
 */
const spoke = (
  calls: ReadonlyArray<Call>,
  wake: RoutineWake,
  options: { readonly look?: Look; readonly permits?: ReadonlyArray<Permit> },
): { readonly problems: ReadonlyArray<string>; readonly text?: string } => {
  const [message] = named(calls, "say");
  if (message === undefined) return { problems: ["never called `say`", ...runRules(calls, wake)] };
  const decoded = decodeSay(message.input);
  const problems = [
    ...(decoded._tag === "Some"
      ? decoded.value.done === true
        ? []
        : ["the message does not carry `done: true`"]
      : ["the `say` is not one the server accepts"]),
    ...(options.look === undefined
      ? []
      : after(calls.find(options.look.test), message, {
          source: options.look.what,
          dependent: "spoke",
        })),
    ...(calls.slice(0, calls.indexOf(message)).some((call) => pausesItself(call, wake))
      ? ["paused its own routine before its message"]
      : []),
    ...onlyPermitted(calls, message, "its message", options.permits ?? []),
    ...runRules(calls, wake),
  ];
  return decoded._tag === "Some" ? { problems, text: decoded.value.text } : { problems };
};

/** Problems with a routine run that must speak once, saying what `check` asks, and do nothing after. */
const speaksOnce = (
  wake: RoutineWake,
  check: Check,
  options: { readonly look?: Look; readonly permits?: ReadonlyArray<Permit> } = {},
) =>
  Effect.fn("evals.speaksOnce")(function* (calls: ReadonlyArray<Call>) {
    const { problems, text } = spoke(calls, wake, options);
    return text === undefined
      ? problems
      : [...problems, ...(yield* judged(check, wake.routine.instruction, text))];
  });

/** A turn's problems under a heading, with its transcript, as one line of a case's report. */
const reported = (heading: string, turn: Turn, problems: ReadonlyArray<string>) =>
  problems.length === 0 ? [] : [`${heading}: ${problems.join("; ")}\n${transcript(turn)}`];

/** The id the server gives the routine the setup turn creates. */
const CREATED_ID = Schema.decodeSync(RoutineId)(CREATED_ROUTINE_ID);

/** A run of the routine a setup turn saved, as the server would start it: at its next run, with `recentRuns`. */
const savedRunWake = (
  setup: Wake,
  routine: ToolInput<"set_routine">,
  recentRuns: (at: DateTime.Utc) => ReadonlyArray<RoutineRunSummary> = () => [],
): RoutineWake | undefined => {
  const next = firstRun(routine, setup);
  if (next === undefined || routine.instruction === undefined) return undefined;
  return {
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
    recentRuns: recentRuns(next),
    triggerData: null,
  };
};

/** One run of a saved routine, scored, its problems under `heading`; a turn that did not finish is one. */
const replayRun = (
  model: string,
  skills: Skills,
  heading: string,
  scenario: Scenario,
  problems: (
    turn: Turn,
  ) => Effect.Effect<ReadonlyArray<string>, Effect.Error<ReturnType<typeof judge>>>,
) =>
  runTurn(model, skills, scenario).pipe(
    Effect.flatMap((turn) =>
      problems(turn).pipe(Effect.map((found) => reported(heading, turn, found))),
    ),
    Effect.catchTag("TurnUnfinished", (error) => Effect.succeed([`${heading}: ${error.message}`])),
  );

const NO_RUN = ["the saved routine has no next run or no instruction to replay"];

/**
 * Runs the docs check the setup turn saved as the server would: once on a
 * passing build, where it must end with no `say`, and once on a failing one,
 * where it must say the build failed in one `say` after looking. This is what
 * shows the instruction stands alone and handles the healthy case, whatever
 * its words.
 */
const replayDocsCheck = Effect.fn("evals.replayDocsCheck")(function* (
  model: string,
  skills: Skills,
  setup: Wake,
  routine: ToolInput<"set_routine">,
) {
  const wake = savedRunWake(setup, routine);
  if (wake === undefined) return NO_RUN;
  const results = yield* Effect.all(
    [
      replayRun(
        model,
        skills,
        "the saved instruction, run on a passing build",
        { wake, workspace: buildWorkspace(wake, PASSING_RUNS) },
        (turn) => Effect.succeed(silentRun(wake, BUILD_LOOK)(turn.calls)),
      ),
      replayRun(
        model,
        skills,
        "the saved instruction, run on a failing build",
        { wake, workspace: buildWorkspace(wake, FAILING_RUNS) },
        (turn) =>
          speaksOnce(wake, BUILD_FAILED, {
            look: BUILD_LOOK,
            permits: [stateUpdate(wake.routine.instruction)],
          })(turn.calls),
      ),
    ],
    { concurrency: 2 },
  );
  return results.flat();
});

/**
 * Runs the merge watch the setup turn saved as the server would: while #12
 * is open, where it must look and end without a word or a pause; once #12
 * has merged, where it must say so once and then pause itself; and once a
 * recent run already said so, where it must pause without a word.
 */
const replayMergeWatch = Effect.fn("evals.replayMergeWatch")(function* (
  model: string,
  skills: Skills,
  setup: Wake,
  routine: ToolInput<"set_routine">,
) {
  const wake = savedRunWake(setup, routine);
  const reportedWake = savedRunWake(setup, routine, (next) => [
    {
      at: DateTime.subtract(next, { minutes: 30 }),
      outcome: {
        type: "delivered",
        text: "PR #12 (Move the API reference to the new layout) has merged into main.",
      },
    },
  ]);
  if (wake === undefined || reportedWake === undefined) return NO_RUN;
  const pause = pauseItself(wake);
  const results = yield* Effect.all(
    [
      replayRun(
        model,
        skills,
        "the saved watch, run while #12 is open",
        { wake, workspace: twelveWorkspace(wake, TWELVE_OPEN) },
        (turn) => Effect.succeed(silentRun(wake, TWELVE_LOOK)(turn.calls)),
      ),
      replayRun(
        model,
        skills,
        "the saved watch, run once #12 has merged",
        { wake, workspace: twelveWorkspace(wake, twelveMerged(25)) },
        Effect.fn(function* ({ calls }) {
          const pauses = calls.filter(pause.test).length;
          return [
            ...(yield* speaksOnce(wake, MERGED, {
              look: TWELVE_LOOK,
              permits: [pause, stateUpdate(wake.routine.instruction)],
            })(calls)),
            ...(pauses === 1 ? [] : [`paused its routine ${pauses} times, not once`]),
          ];
        }),
      ),
      replayRun(
        model,
        skills,
        "the saved watch, run after a recent run reported the merge",
        { wake: reportedWake, workspace: twelveWorkspace(reportedWake, twelveMerged(55)) },
        ({ calls }) => {
          const pauses = calls.filter(pause.test);
          const [first] = pauses;
          return Effect.succeed([
            ...(named(calls, "say").length > 0 ? ["called `say`"] : []),
            ...(pauses.length === 1 ? [] : [`paused its routine ${pauses.length} times, not once`]),
            ...(first === undefined ? [] : onlyPermitted(calls, first, "its pause", [])),
            ...runRules(calls, reportedWake),
          ]);
        },
      ),
    ],
    { concurrency: 3 },
  );
  return results.flat();
});

/**
 * Problems with a setup turn's own calls, around the one routine it created:
 * it opens with a `say`, looks for an existing routine before creating one,
 * and ends on a `say` with `done: true` sent once the routine was saved.
 * Returns the problems and the closing message's text.
 */
const setupProblems = (
  calls: ReadonlyArray<Call>,
  creation: Call,
): { readonly problems: ReadonlyArray<string>; readonly closing?: string } => {
  const problems = [
    ...(says(calls)[0]?.call === calls[0] ? [] : ["the first call is not a `say`"]),
    ...after(named(calls, "list_routines")[0], creation, {
      source: "called `list_routines`",
      dependent: "created the routine",
    }),
  ];
  const last = calls.at(-1);
  const closing = says(calls).find((said) => said.call === last);
  if (closing === undefined)
    return { problems: [...problems, "the turn does not end with a `say`"] };
  return {
    problems: [
      ...problems,
      ...after(creation, closing.call, { source: "saved the routine", dependent: "confirmed it" }),
      ...(closing.say.done === true ? [] : ["the closing `say` does not carry `done: true`"]),
    ],
    closing: closing.say.text,
  };
};

/**
 * The one routine a setup turn must create, or why it did not: a create the
 * server would refuse fails the setup, even if a later one was saved.
 */
const theCreated = (calls: ReadonlyArray<Call>) => {
  const sent = creates(calls);
  const refused = sent.filter(({ call }) => call.refused === true);
  const [first, ...others] = sent;
  if (refused.length > 0) {
    return `the server would refuse ${refused.length === 1 ? "a create" : `${refused.length} creates`}: ${refused.map(({ call }) => call.output).join("; ")}`;
  }
  return first !== undefined && others.length === 0
    ? first
    : `${sent.length} \`set_routine\` creates, not one`;
};

const decodeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reported: Schema.Array(Schema.Number) })),
);

/** A number as a message names a pull request: on its own, not inside a longer number. */
const namesNumber = (text: string, number: number) =>
  new RegExp(`(?<!\\d)${number}(?!\\d)`).test(text);

/**
 * Problems specific to the pull-request watch's run: before its message, in
 * an earlier model message, it read the state file and a list holding the new
 * pull requests; the message has both numbers in it (a structural check: the
 * judge reads whether it reports them as new, with their titles); every write
 * of the state file comes in a later model message than the message; and the
 * file, as the turn leaves it, lists every open pull request.
 */
const stateRunProblems = (
  calls: ReadonlyArray<Call>,
  stateAtEnd: string | undefined,
): ReadonlyArray<string> => {
  const [message] = named(calls, "say");
  if (message === undefined) return [];
  const text = says(calls).find(({ call }) => call === message)?.say.text ?? "";
  const writes = calls.filter((call) =>
    did(call, (event) => event.type === "file-write" && event.path === STATE_PATH),
  );
  const state = stateAtEnd === undefined ? undefined : decodeState(stateAtEnd);
  const reportedNumbers =
    state?._tag === "Some" ? state.value.reported.toSorted((a, b) => a - b) : undefined;
  return [
    ...after(
      calls.find((call) =>
        did(call, (event) => event.type === "file-read" && event.path === STATE_PATH),
      ),
      message,
      { source: "read the state file", dependent: "spoke" },
    ),
    ...after(
      calls.find((call) =>
        did(
          call,
          (event) =>
            event.type === "pull-requests-read" &&
            NEW_PULL_REQUESTS.every((number) => event.numbers.includes(number)),
        ),
      ),
      message,
      { source: "listed the open pull requests", dependent: "spoke" },
    ),
    ...(NEW_PULL_REQUESTS.every((number) => namesNumber(text, number))
      ? []
      : ["the message does not name both new pull requests, #124 and #125"]),
    ...(writes.length === 0 ? ["never wrote the state file"] : []),
    ...(writes.some((call) => call.step <= message.step)
      ? ["wrote the state file before its message was recorded"]
      : []),
    ...(JSON.stringify(reportedNumbers) === JSON.stringify(REPORTED_AFTER)
      ? []
      : [
          `the state file ends the turn as ${stateAtEnd === undefined ? "missing" : JSON.stringify(stateAtEnd)}, not listing ${REPORTED_AFTER.join(", ")} under "reported"`,
        ]),
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

/** A case whose problems the turn's own calls show, with no judge. */
const fromCalls =
  (problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>): Case["problems"] =>
  (turn) =>
    Effect.succeed(problems(turn.calls));

/**
 * A one-off question about the build, asked of a workspace whose build is as
 * `runs` says. The answer graded is the closing one, the last `say` with
 * `done: true`, sent after the check: the judge must read it as saying the
 * build passed, or failed, as it did. A message after it that says the
 * opposite fails the case.
 */
const oneOff = (runs: ReadonlyArray<Run>, passing: boolean) => {
  const wake = userWake(ONE_OFF);
  const [claim, opposite] = passing ? [BUILD_PASSING, BUILD_FAILED] : [BUILD_FAILED, BUILD_PASSING];
  return {
    scenario: { wake, workspace: buildWorkspace(wake, runs) },
    problems: Effect.fn("evals.oneOffCase")(function* ({ calls }: Turn) {
      const checked = calls.find(BUILD_LOOK.test);
      const said = says(calls);
      const closing = said.findLast(({ say }) => say.done === true);
      const problems = [
        ...(named(calls, "set_routine").length > 0 ? ["called `set_routine`"] : []),
        ...(checked === undefined ? ["never checked the build"] : []),
      ];
      if (closing === undefined)
        return [...problems, "no `say` with `done: true` delivered the answer"];
      const later = said.slice(said.indexOf(closing) + 1);
      return [
        ...problems,
        ...(checked === undefined
          ? []
          : after(checked, closing.call, {
              source: "checked the build",
              dependent: "delivered the answer",
            })),
        ...(yield* judged(claim, ONE_OFF, closing.say.text)),
        ...(yield* Effect.forEach(later, ({ say }) =>
          judged(opposite, ONE_OFF, say.text, false),
        )).flat(),
      ];
    }),
  } satisfies Omit<Case, "name">;
};

const setupWake = userWake(SETUP);

const mergeSetupWake = userWake(
  "can you let me know when PR #12 on acme/docs gets merged? mira said it should land today",
);

const cases: ReadonlyArray<Case> = [
  {
    name: "creates a routine for recurring work, whose saved instruction runs silent on a passing build and reports a failing one",
    scenario: { wake: setupWake, workspace: buildWorkspace(setupWake, PASSING_RUNS) },
    problems: Effect.fn("evals.setupCase")(function* ({ calls }, { model, skills }) {
      const creation = theCreated(calls);
      if (typeof creation === "string") return [creation];
      const { problems, closing } = setupProblems(calls, creation.call);
      const schedule = creation.routine.schedule ?? "";
      const [minute, hour, day, month, weekday] = schedule.split(/\s+/);
      const weekdaysAtEight =
        minute === "0" &&
        hour === "8" &&
        day === "*" &&
        month === "*" &&
        ["1-5", "mon-fri"].includes((weekday ?? "").toLowerCase());
      return [
        ...problems,
        ...(weekdaysAtEight ? [] : [`schedule "${schedule}" is not weekdays at 8:00`]),
        ...(closing === undefined ? [] : yield* judged(WEEKDAYS_AT_EIGHT, SETUP, closing)),
        ...(yield* replayDocsCheck(model, skills, setupWake, creation.routine)),
      ];
    }),
  },
  {
    name: "answers a one-off request in the turn from a check of the build, with no routine",
    ...oneOff(PASSING_RUNS, true),
  },
  {
    name: "answers a one-off request about a failing build without calling it passing",
    ...oneOff(FAILING_RUNS, false),
  },
  {
    name: "keeps a routine run silent when nothing is worth saying",
    scenario: { wake: routineWake, workspace: buildWorkspace(routineWake, PASSING_RUNS) },
    problems: fromCalls(silentRun(routineWake, BUILD_LOOK)),
  },
  {
    name: "speaks once in a routine run when something is worth saying",
    scenario: { wake: routineWake, workspace: buildWorkspace(routineWake, FAILING_RUNS) },
    problems: ({ calls }) => speaksOnce(routineWake, FAILURE_NAMED, { look: BUILD_LOOK })(calls),
  },
  {
    name: "sends a due reminder exactly once",
    scenario: { wake: reminderWake, workspace: buildWorkspace(reminderWake, PASSING_RUNS) },
    problems: ({ calls }) => speaksOnce(reminderWake, REMINDED)(calls),
  },
  {
    name: "says once what blocked a routine run that lost its access",
    scenario: { wake: routineWake, workspace: signedOutWorkspace(routineWake) },
    problems: ({ calls }) => speaksOnce(routineWake, ACCESS_LOST, { look: GH_TRIED })(calls),
  },
  {
    name: "stays silent when a recent run already said what blocks it",
    scenario: { wake: blockerReportedWake, workspace: signedOutWorkspace(blockerReportedWake) },
    problems: fromCalls(silentRun(blockerReportedWake, GH_TRIED)),
  },
  {
    name: "reports new pull requests once, then records them in its state file",
    scenario: { wake: pullRequestWake, workspace: pullRequestWorkspace },
    problems: Effect.fn("evals.pullRequestCase")(function* ({ calls, workspace }) {
      const { problems, text } = spoke(calls, pullRequestWake, {
        permits: [stateUpdate(pullRequestWake.routine.instruction)],
      });
      return [
        ...problems,
        ...stateRunProblems(calls, workspace.file(STATE_FILE)),
        ...(text === undefined
          ? []
          : yield* judged(NEW_PULL_REQUESTS_REPORTED, pullRequestWake.routine.instruction, text)),
      ];
    }),
  },
  {
    name: "turns a request to hear when something happens into a watch that reports it once, then pauses itself",
    scenario: { wake: mergeSetupWake, workspace: twelveWorkspace(mergeSetupWake, TWELVE_OPEN) },
    problems: Effect.fn("evals.mergeWatchCase")(function* ({ calls }, { model, skills }) {
      const creation = theCreated(calls);
      if (typeof creation === "string") return [creation];
      const { problems } = setupProblems(calls, creation.call);
      if (creation.routine.schedule === undefined) {
        return [...problems, "the watch was not saved with a schedule"];
      }
      return [
        ...problems,
        ...(yield* replayMergeWatch(model, skills, mergeSetupWake, creation.routine)),
      ];
    }),
  },
];

/** A call with no arguments or output, for the checks of the graders and the stand-in workspace below. */
const CALL: Call = { step: 1, name: "run_command", input: {}, output: "", events: [] };

describe("the judge, on fixed messages", () => {
  describe.each(CHECKS)("$question", (check) => {
    it.concurrent.each(check.accept)("answers yes for %j", async (text) => {
      expect(await Effect.runPromise(judge(check.asked, text, check.question))).toBe(true);
    });
    it.concurrent.each(check.reject)("answers no for %j", async (text) => {
      expect(await Effect.runPromise(judge(check.asked, text, check.question))).toBe(false);
    });
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

  it.each([
    ["gh pr list -R acme/docs", false],
    ["gh pr list -R acme/docs --state merged", true],
    ["gh pr list -R acme/docs --state closed --json number,state", true],
    ["gh api 'repos/acme/docs/pulls?state=closed'", true],
    ["gh api repos/acme/docs/pulls", false],
    ["gh pr view 12 -R acme/docs", true],
  ])("counts %j as a read of a merged #12: %s", (command, counts) => {
    expect(TWELVE_LOOK.test({ ...CALL, events: run(command).events })).toBe(counts);
  });
});

describe("the run graders", () => {
  const call = (
    step: number,
    name: string,
    input: unknown,
    events: ReadonlyArray<FixtureEvent> = [],
  ): Call => ({ ...CALL, step, name, input, events });
  const look = [
    call(1, "run_command", {}, [{ type: "file-read", path: STATE_PATH }]),
    call(1, "run_command", {}, [
      { type: "gh" },
      { type: "pull-requests-read", numbers: [125, 124, 121, 118] },
    ]),
  ];
  const say = (step: number, text: string) => call(step, "say", { text, done: true });
  const report =
    "New on acme/docs: #124 Document the new search API, #125 Fix broken anchors in FAQ.";
  const write = (step: number, numbers: ReadonlyArray<number> = REPORTED_AFTER) =>
    call(step, "run_command", {}, [
      { type: "file-write", path: STATE_PATH, content: JSON.stringify({ reported: numbers }) },
    ]);
  const final = (numbers: ReadonlyArray<number> = REPORTED_AFTER) =>
    JSON.stringify({ reported: numbers });
  const stateRun = (calls: ReadonlyArray<Call>, stateAtEnd: string | undefined) => [
    ...spoke(calls, pullRequestWake, {
      permits: [stateUpdate(pullRequestWake.routine.instruction)],
    }).problems,
    ...stateRunProblems(calls, stateAtEnd),
  ];

  it("accepts a state-file write of every open pull request in a later message", () => {
    expect(stateRun([...look, say(2, report), write(3)], final())).toEqual([]);
  });

  it("accepts read-only calls after the message", () => {
    const reads = [
      call(3, "list_routines", {}),
      call(3, "run_command", {}, [{ type: "gh" }, { type: "pull-requests-read", numbers: [125] }]),
      call(4, "run_command", {}, [
        { type: "file-read", path: `${HOME}/files/notes.txt` },
        { type: "file-write", path: STATE_PATH, content: final() },
      ]),
    ];
    expect(stateRun([...look, say(2, report), ...reads], final())).toEqual([]);
  });

  it.each([
    ["no write", [...look, say(2, report)], STATE],
    ["a write in the same message", [...look, say(2, report), write(2)], final()],
    [
      "a write before the message and after it",
      [...look, write(2), say(3, report), write(4)],
      final(),
    ],
    [
      "a write that leaves out #125",
      [...look, say(2, report), write(3, [118, 121, 124])],
      final([118, 121, 124]),
    ],
    ["a write the turn then deleted", [...look, say(2, report), write(3)], undefined],
    ["a message sent with the reads", [...look, say(1, report), write(2)], final()],
    [
      "a message missing #125",
      [...look, say(2, "New: #124 Document the new search API."), write(3)],
      final(),
    ],
    [
      "a `remember` after the message",
      [...look, say(2, report), write(3), call(4, "remember", { fact: "Reported #124 and #125." })],
      final(),
    ],
    ["a second `say`", [...look, say(2, report), write(3), say(4, "Recorded them.")], final()],
    [
      "a write after the message to a file the instruction does not name",
      [
        ...look,
        say(2, report),
        write(3),
        call(4, "run_command", {}, [
          { type: "file-write", path: `${HOME}/files/notes.txt`, content: "done" },
        ]),
      ],
      final(),
    ],
    [
      "a message without `done: true`",
      [...look, call(2, "say", { text: report }), write(3)],
      final(),
    ],
  ])("rejects %s", (_, calls, stateAtEnd) => {
    expect(stateRun(calls, stateAtEnd)).not.toEqual([]);
  });

  it("rejects a pause of its own routine in a silent run", () => {
    const pause = {
      ...call(2, "set_routine", {}),
      routine: { action: "pause", id: routineWake.routine.id },
    } satisfies Call;
    expect(
      silentRun(
        routineWake,
        BUILD_LOOK,
      )([call(1, "run_command", {}, [{ type: "build-read" }]), pause]),
    ).toContain("paused its own routine with nothing to report");
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
