// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Routine, RoutineId } from "@j3-bots/contracts";
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
import { FAILING_RUNS, github, PASSING_RUNS, TWELVE_OPEN, twelveMerged } from "./acme.ts";
import {
  type FixtureEvent,
  type GhEvent,
  githubWorkspace,
  type PullRequest,
  type Run,
} from "./fixtures.ts";
import {
  after,
  at,
  base,
  type Case,
  type Check,
  fromCalls,
  type Grade,
  gradeFromCalls,
  judged,
  judgeOnFixedMessages,
  named,
  replayGrade,
  replayRun,
  runCases,
  says,
  timeZone,
  todayAt,
  userWake,
} from "./grading.ts";
import { type Call, HeldRoutines, type Skills, type Turn } from "./harness.ts";
import { type LocalRun, weekOfRuns } from "./schedule.ts";
import { HOME, type Workspace } from "./shell.ts";

// The routine skill's evals: given the base prompt, with the skill and without
// it, a model creates a routine for recurring work whose saved instruction,
// replayed as a run, stays silent on a passing build and reports a failing
// one; creates none for a one-off request; and in a routine run stays silent
// when a condition is not met, but speaks when it is, when a reminder is due,
// and when it could not do the work, unless a recent run already said what
// blocks it. A "let me know when" request becomes a watch with a cutoff, 14
// days on when the user named none, whose saved instruction, replayed, stays
// silent while the event has not happened, reports it once and then pauses
// itself, and pauses without a word when a recent run already reported it; a
// fixed watch instruction, replayed around its cutoff, keeps watching the day
// before, ends on the day with one message even when its source cannot be
// read, and does not repeat that message. Days the user's words name are kept,
// and work they left the days of runs on weekdays. A run that keeps a state
// file leaves it updated, written only after its message was recorded.
//
// Each case is one turn per model and skill column, scored on what its tool
// calls did. What a message means is read by the judge (`judge.ts`), on fixed
// questions whose reading is checked on fixed messages below. The graders
// read structure: the order of calls, schedules, ids and file content. The one
// place they look at a message's text is the pull-request digest, where they
// check that #124 and #125 appear as numbers; whether the message reports
// them as new is the judge's. After a run's message, only read-only calls and
// what its case permits may follow.

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
  dueAt: null,
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
  dueAt: null,
};

/** Where the evening briefing reads the user's appointments, listed under each date. */
const AGENDA_FILE = "files/agenda.md";
const AGENDA_PATH = `${HOME}/${AGENDA_FILE}`;
const BRIEFING = `Read ${AGENDA_FILE}, which lists your user's appointments under each date, and send your user one short message listing what is on their calendar tomorrow. If nothing is listed for tomorrow, say so.`;

/**
 * The evening briefing, due at 23:00 yesterday, runs at 01:30: J3 Bots was not
 * running at 23:00, and the run is still nearer than the next one. The
 * instruction's "tomorrow" is the day after the run was due, which is today.
 */
const briefingDue = DateTime.subtract(todayAt(23, 0), { days: 1 });
const lateBriefingWake: RoutineWake = {
  ...base,
  at: todayAt(1, 30),
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-5"),
    name: "Evening briefing",
    trigger: { type: "schedule", cron: "0 23 * * *" },
    instruction: BRIEFING,
  },
  recentRuns: [
    {
      at: DateTime.subtract(briefingDue, { days: 1 }),
      outcome: { type: "delivered", text: "Tomorrow: 16:00 budget review with Priya." },
    },
  ],
  triggerData: null,
  dueAt: briefingDue,
};

/** A date as the agenda heads it: `2026-11-20`. */
const agendaDay = (when: DateTime.Utc) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: DateTime.zoneToString(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(DateTime.toDateUtc(when));

const AGENDA = [
  "# Agenda",
  "",
  `## ${agendaDay(briefingDue)}`,
  "- 16:00 Budget review with Priya",
  "",
  `## ${agendaDay(lateBriefingWake.at)}`,
  "- 10:30 Dentist, Dr. Okafor",
  "",
  `## ${agendaDay(DateTime.add(lateBriefingWake.at, { days: 1 }))}`,
  "- 09:00 Team offsite at the river office",
  "",
].join("\n");

const agendaWorkspace = () =>
  githubWorkspace(github(lateBriefingWake.at, PASSING_RUNS), new Map([[AGENDA_FILE, AGENDA]]));

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
  dueAt: null,
};

const pullRequestWorkspace = () =>
  githubWorkspace(github(pullRequestWake.at, PASSING_RUNS), new Map([[STATE_FILE, STATE]]));

// What a message means, as the judge reads it.

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

const DAY_AFTER_DUE: Check = {
  question:
    "Does this message give the 10:30 dentist appointment with Dr. Okafor as what is on the calendar, and leave out the 09:00 team offsite?",
  what: "the dentist appointment, not the offsite",
  asked: BRIEFING,
  accept: [
    "Tomorrow: 10:30 dentist with Dr. Okafor.",
    "Today at 10:30 you have the dentist (Dr. Okafor). Sorry this comes late.",
  ],
  reject: [
    "Tomorrow: 09:00 team offsite at the river office.",
    "Nothing is on your calendar tomorrow.",
    "Tomorrow: 10:30 dentist with Dr. Okafor, and 09:00 team offsite at the river office.",
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

/** A loose request about work, with the days and the time left open. */
const LOOSE = "can you keep an eye on the docs build and let me know if it breaks?";

/** A request about work whose words name the days: every morning. */
const EVERY_MORNING = "every morning, check the docs build and tell me if it's broken";

/**
 * For the loose request, which wants a standing check, not a watch for one
 * event: asked of the saved instruction, whose answer must be no.
 */
const ENDS_ITSELF: Check = {
  question:
    "Does this routine instruction give the check an end date or cutoff, or tell a run to pause or stop the routine?",
  what: "an end date, or a step that pauses or stops the routine",
  asked: LOOSE,
  accept: [
    "Check the latest CI run on main in acme/docs. Once it has failed, tell your user once, then pause this routine.",
    "Check the latest CI run on main in acme/docs and tell your user if it failed. After Friday, 4 December 2026 at 08:07, tell your user the check has ended and pause this routine.",
  ],
  reject: [
    DOCS_CHECK,
    "Check the latest CI run on main in acme/docs. If it failed, tell your user which job broke; if it passed, end without a message.",
  ],
};

const EVERY_DAY: Check = {
  question: "Does this message tell its reader the check runs every day, weekends included?",
  what: "that the check runs every day",
  asked: EVERY_MORNING,
  accept: [
    "Every morning at 8:07 I'll check the docs build and tell you if it's broken.",
    "Done: daily at 8:07, weekends too, I'll look at the docs build and only message you if it broke.",
  ],
  reject: [
    "Every weekday at 8:07 I'll check the docs build and tell you if it's broken.",
    "Monday to Friday at 8:07 I'll look at the docs build.",
  ],
};

const WEEKDAYS_ONLY: Check = {
  question:
    "Does this message tell its reader the check runs on weekdays, Monday to Friday, and not at weekends?",
  what: "that the check runs on weekdays only",
  asked: LOOSE,
  accept: [
    "Every weekday at 8:07 I'll check the docs build and tell you if it's broken.",
    "Monday to Friday, at 8:07 in the morning, I'll look at the docs build and only message you if it broke.",
  ],
  reject: [
    "Every morning at 8:07 I'll check the docs build and tell you if it's broken.",
    "Every day at 8:07, weekends included, I'll check the docs build.",
  ],
};

/** A watch with no date that ends it, so it gets the default cutoff, 14 days on. */
const MERGE_ASKED_PLAIN = "can you let me know when PR #12 on acme/docs gets merged?";

/**
 * The same, with a forecast: Mira's "should land today" is when the user
 * expects the merge, not a deadline, so the cutoff is still 14 days on.
 */
const MERGE_ASKED =
  "can you let me know when PR #12 on acme/docs gets merged? mira said it should land today";

const longDate = (when: DateTime.Utc) =>
  local(when, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

const clock = (when: DateTime.Utc) =>
  local(when, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** `days` calendar days after `when`, at the same local time in the operator's zone. */
const calendarDaysOn = (when: DateTime.Utc, days: number) =>
  DateTime.toUtc(DateTime.add(DateTime.makeZonedUnsafe(when, { timeZone }), { days }));

/** A cutoff as a watch holds it: weekday, date and local time. */
const cutoffAt = (when: DateTime.Utc) => `${longDate(when)} at ${clock(when)}`;

/**
 * The default cutoff of a watch set up at `at`, the setup turn's time, and
 * what it is not: the right day without its time, without its weekday or at
 * another time, and another day.
 */
const CUTOFF_DAY = calendarDaysOn(at, 14);
const CUTOFF = cutoffAt(CUTOFF_DAY);
const CUTOFF_DATE_ONLY = longDate(CUTOFF_DAY);
const CUTOFF_NO_WEEKDAY = `${local(CUTOFF_DAY, { day: "numeric", month: "long", year: "numeric" })} at ${clock(CUTOFF_DAY)}`;
const CUTOFF_AT_NOON = `${longDate(CUTOFF_DAY)} at 12:00`;
const NOT_THE_CUTOFF = cutoffAt(calendarDaysOn(at, 7));

const CUTOFF_CONFIRMED: Check = {
  question: `Does this message tell its reader that the watch ends at ${CUTOFF}, giving that weekday, that date and that time, if #12 has not merged by then?`,
  what: `that the watch ends at ${CUTOFF}, with weekday, date and time`,
  asked: MERGE_ASKED,
  accept: [
    `I'll check #12 every 30 minutes and tell you once it merges. If it hasn't by ${CUTOFF}, I'll stop watching and let you know.`,
    `Watching #12 until it merges, or until ${CUTOFF} at the latest.`,
  ],
  reject: [
    "I'll check #12 every 30 minutes and tell you once it merges.",
    `Watching #12 until it merges, or until ${NOT_THE_CUTOFF} at the latest.`,
    `Watching #12 until it merges, or until ${CUTOFF_DATE_ONLY} at the latest.`,
    `Watching #12 until it merges, or until ${CUTOFF_AT_NOON} at the latest.`,
    `Watching #12 until it merges, or until ${CUTOFF_NO_WEEKDAY} at the latest.`,
    "I'll keep watching #12 until it merges, however long that takes.",
  ],
};

/** The watch's delivery line as `set_routine` gives it, with #12 and a cutoff filled in. */
const watchInstruction = (cutoff: string) =>
  `Check whether pull request #12 (Move the API reference to the new layout) on the GitHub repository acme/docs has merged into main. If a recent run already told your user that #12 merged or that the watch ended, pause this routine now, without a message. At or after ${cutoff}, the watch is over: if #12 merged before ${cutoff}, tell your user it did; otherwise tell them once that the watch has ended, saying in that message if the pull request could not be read; a merge at or after ${cutoff} does not count. Before ${cutoff}, once #12 has merged, tell your user in one short message; until then, end without a message. Once the message that #12 merged, or that the watch has ended, has returned, pause this routine. Send that \`say\` alone and wait for its result; the pause is then your last call, never alongside it. A message before ${cutoff} about a source you could not reach does not end the watch.`;

const CUTOFF_SAVED: Check = {
  question: `Does this routine instruction make ${CUTOFF}, with that weekday, that date and that time, the moment at which the watch of #12 ends, telling the user it stopped and pausing itself if #12 has not merged by then?`,
  what: `${CUTOFF}, with weekday, date and time, as the watch's cutoff`,
  asked: MERGE_ASKED,
  accept: [
    watchInstruction(CUTOFF),
    `Check pull request #12 on acme/docs. When it has merged, tell your user once, then pause this routine. If it is still open at ${CUTOFF}, tell your user you stopped watching it and pause this routine.`,
  ],
  reject: [
    watchInstruction(NOT_THE_CUTOFF),
    watchInstruction(CUTOFF_DATE_ONLY),
    watchInstruction(CUTOFF_AT_NOON),
    watchInstruction(CUTOFF_NO_WEEKDAY),
    "Check pull request #12 on acme/docs. When it has merged, tell your user once, then pause this routine; while it is open, end without saying anything.",
  ],
};

/**
 * The cutoff the execution replays run against: noon today, so every replay
 * falls on the real current date and only its time moves around the cutoff.
 */
const NOON_TODAY = cutoffAt(todayAt(12, 0));
const FIXED_WATCH = watchInstruction(NOON_TODAY);

const WATCH_ENDED: Check = {
  question:
    "Does this message tell its reader that the bot has stopped watching pull request #12, or that the watch of it has ended?",
  what: "that the watch of #12 has ended",
  asked: FIXED_WATCH,
  accept: [
    "#12 still hasn't merged, so I've stopped watching it as planned. Ask me if you want me to keep going.",
    "The watch on #12 has ended; I couldn't reach GitHub to check it one last time.",
  ],
  reject: [
    "PR #12 merged about 25 minutes ago.",
    "#12 is still open; I'll check again in half an hour.",
    "I couldn't check #12: GitHub sign-in expired (HTTP 401).",
  ],
};

const SOURCE_UNREACHED: Check = {
  question:
    "Does this message tell its reader that GitHub, or pull request #12, could not be reached or read?",
  what: "that #12 could not be read",
  asked: FIXED_WATCH,
  accept: [
    "The watch on #12 has ended; I couldn't reach GitHub to check it one last time.",
    "I've stopped watching #12. GitHub's sign-in had expired, so I couldn't see its final state.",
    "I couldn't check #12: the GitHub sign-in has expired. Renew it and the next run picks the watch up again.",
  ],
  reject: [
    "#12 still hasn't merged, so I've stopped watching it as planned.",
    "PR #12 merged about 25 minutes ago.",
  ],
};

/** For the closing answer and a run's report: what the app shows should read as sentences, not a status panel. */
const PLAIN_SENTENCES: Check = {
  question:
    "Is this message written in full sentences, with no 'Label: value' status lines and no arrows standing in for words?",
  what: "full sentences, with no status lines or arrows",
  asked: ONE_OFF,
  accept: [
    "Yes, it's green: the latest run on main passed about an hour ago.",
    "The docs build failed on main. The link check found that guides/pricing.md links to /plans, which returns 404.",
  ],
  reject: [
    "Status: green\nLatest run: 1042 (success, 3m12s)",
    "Build → green (run 1042 → success)",
  ],
};

const FIX_NAMED: Check = {
  question:
    "Does this message tell its reader what would let the check run again, such as signing gh in to GitHub again?",
  what: "what would let the check run again",
  asked: DOCS_CHECK,
  accept: [
    "I couldn't check the docs build: GitHub sign-in expired (HTTP 401). Signing gh in again with gh auth login will fix it.",
    "GitHub turned me away, so no build check today; the gh login needs renewing.",
  ],
  reject: [
    "I couldn't check the docs build: GitHub sign-in expired (HTTP 401).",
    "Docs build failed on main: link-check hit a 404.",
  ],
};

const CHECKS: ReadonlyArray<Check> = [
  WEEKDAYS_ONLY,
  ENDS_ITSELF,
  EVERY_DAY,
  CUTOFF_CONFIRMED,
  CUTOFF_SAVED,
  WATCH_ENDED,
  SOURCE_UNREACHED,
  PLAIN_SENTENCES,
  FIX_NAMED,
  BUILD_PASSING,
  BUILD_FAILED,
  FAILURE_NAMED,
  REMINDED,
  DAY_AFTER_DUE,
  ACCESS_LOST,
  MERGED,
  NEW_PULL_REQUESTS_REPORTED,
  WEEKDAYS_AT_EIGHT,
];

// What a turn did.

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

/** A `run_command` that read the agenda. */
const AGENDA_LOOK: Look = {
  what: "read the agenda",
  test: (call) => did(call, (event) => event.type === "file-read" && event.path === AGENDA_PATH),
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
 * What a command did that may have changed something: it left the workspace
 * different (a file written or removed, a folder created or removed, however
 * it went about it), tried to change GitHub, or tried something the workspace
 * could not run, whose effect is unknown.
 */
const mayChange = (event: FixtureEvent): boolean =>
  event.type === "file-written" ||
  event.type === "file-removed" ||
  event.type === "directory-created" ||
  event.type === "directory-removed" ||
  event.type === "gh-change" ||
  event.type === "unavailable";

/**
 * A call that changes nothing, which any run may make after its message: a
 * `j3` tool that only reads, or a command that did nothing {@link mayChange}
 * counts, such as a `gh` read or an `ls`.
 */
const READ_ONLY: Permit = {
  what: "a read-only call",
  test: (call) =>
    ["list_routines", "recall", "list_teammates"].includes(call.name) ||
    (call.name === "run_command" && !call.events.some(mayChange)),
};

const pauseItself = (wake: RoutineWake): Permit => ({
  what: "a `pause` of its own routine",
  test: (call) => pausesItself(call, wake),
});

/**
 * The state-file update `instruction` names, which a run may make after its
 * message: a command whose only change to the workspace is writing files
 * under `files/` whose paths the instruction gives. How it wrote them (a
 * temporary file moved into place, say) does not matter; any other change
 * does.
 */
const stateUpdate = (instruction: string): Permit => ({
  what: "an update of a state file its instruction names",
  test: (call) =>
    call.name === "run_command" &&
    call.events.some((event) => event.type === "file-written") &&
    call.events.every((event) =>
      event.type === "file-written"
        ? event.path.startsWith(`${HOME}/files/`) &&
          instruction.includes(event.path.slice(HOME.length + 1))
        : !mayChange(event),
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

/**
 * A run of the routine a setup turn left saved, as the server would start it:
 * at `next`, by default its next run, with `recentRuns`; `undefined` when it
 * has none, such as a routine waiting for a webhook.
 */
const savedRunWake = (
  routine: Routine,
  recentRuns: (at: DateTime.Utc) => ReadonlyArray<RoutineRunSummary> = () => [],
  next: DateTime.Utc | null = routine.nextRunAt,
): RoutineWake | undefined => {
  if (next === null) return undefined;
  const { trigger } = routine;
  return {
    at: next,
    timeZone,
    sinceLastTurn: [],
    kind: "routine",
    routine: {
      id: routine.id,
      name: routine.name,
      trigger:
        trigger._tag === "schedule"
          ? { type: "schedule", cron: trigger.cron }
          : { type: trigger._tag },
      instruction: routine.instruction,
    },
    recentRuns: recentRuns(next),
    triggerData: null,
    dueAt: null,
  };
};

const NO_RUN = ["the saved routine has no next run to replay"];

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
  routine: Routine,
) {
  const wake = savedRunWake(routine);
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

/** Problems with the calls after `pause`, which must be the run's last call. */
const lastCall = (calls: ReadonlyArray<Call>, pause: Call): ReadonlyArray<string> =>
  calls
    .slice(calls.indexOf(pause) + 1)
    .map((call) => `called \`${call.name}\` after its pause, which must be its last call`);

/**
 * A watch's run that must report and end, but for what its message means:
 * it looks with a call `look` accepts, then, in a later model message, speaks
 * once, then pauses its own routine once, as its last call, as the routine
 * envelope's closing line says. Returns the problems and the message's text.
 */
const endingRun = (
  calls: ReadonlyArray<Call>,
  wake: RoutineWake,
  look: Look = TWELVE_LOOK,
): { readonly problems: ReadonlyArray<string>; readonly text?: string } => {
  const pause = pauseItself(wake);
  const pauses = calls.filter(pause.test);
  const [first] = pauses;
  const { problems, text } = spoke(calls, wake, {
    look,
    permits: [pause, stateUpdate(wake.routine.instruction)],
  });
  const all = [
    ...problems,
    ...(pauses.length === 1 ? [] : [`paused its routine ${pauses.length} times, not once`]),
    ...(first === undefined ? [] : lastCall(calls, first)),
  ];
  return text === undefined ? { problems: all } : { problems: all, text };
};

/** Problems with a watch's run that must pause without a word: it pauses once, as its last call. */
const quietPause = (calls: ReadonlyArray<Call>, wake: RoutineWake): ReadonlyArray<string> => {
  const pause = pauseItself(wake);
  const pauses = calls.filter(pause.test);
  const [first] = pauses;
  return [
    ...(named(calls, "say").length > 0 ? ["called `say`"] : []),
    ...(pauses.length === 1 ? [] : [`paused its routine ${pauses.length} times, not once`]),
    ...(first === undefined ? [] : lastCall(calls, first)),
    ...runRules(calls, wake),
  ];
};

/**
 * The merge watch the setup turn saved, run as the server would: while #12
 * is open, where it must look and end without a word or a pause; once #12
 * has merged, where it must say so once and then pause itself; and once a
 * recent run already said so, where it must pause without a word. What it
 * does at its cutoff is the execution cases' to show, on a fixed instruction.
 */
const savedWatchGrades = (
  model: string,
  skills: Skills,
  routine: Routine,
): ReadonlyArray<Grade> => {
  const wake = savedRunWake(routine);
  const reportedWake = savedRunWake(routine, (next) => [
    {
      at: DateTime.subtract(next, { minutes: 30 }),
      outcome: {
        type: "delivered",
        text: "PR #12 (Move the API reference to the new layout) has merged into main.",
      },
    },
  ]);
  if (wake === undefined || reportedWake === undefined) {
    return [gradeFromCalls("the saved watch runs", NO_RUN)];
  }
  return [
    replayGrade(
      "the saved watch, run while #12 is open",
      model,
      skills,
      { wake, workspace: twelveWorkspace(wake, TWELVE_OPEN) },
      (turn) => Effect.succeed(silentRun(wake, TWELVE_LOOK)(turn.calls)),
    ),
    replayGrade(
      "the saved watch, run once #12 has merged",
      model,
      skills,
      { wake, workspace: twelveWorkspace(wake, twelveMerged(25)) },
      Effect.fn(function* ({ calls }) {
        const { problems, text } = endingRun(calls, wake);
        return text === undefined
          ? problems
          : [...problems, ...(yield* judged(MERGED, wake.routine.instruction, text))];
      }),
    ),
    replayGrade(
      "the saved watch, run after a recent run reported the merge",
      model,
      skills,
      { wake: reportedWake, workspace: twelveWorkspace(reportedWake, twelveMerged(55)) },
      ({ calls }) => Effect.succeed(quietPause(calls, reportedWake)),
    ),
  ];
};

/** A run of {@link FIXED_WATCH} at `when`, after `recentRuns`. */
const fixedWatchWake = (
  when: DateTime.Utc,
  recentRuns: ReadonlyArray<RoutineRunSummary>,
): RoutineWake => ({
  ...base,
  at: when,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-4"),
    name: "PR #12 merge watch",
    trigger: { type: "schedule", cron: "7,37 9-18 * * *" },
    instruction: FIXED_WATCH,
  },
  recentRuns,
  triggerData: null,
  dueAt: null,
});

const halfHourlyQuiet = (when: DateTime.Utc): ReadonlyArray<RoutineRunSummary> =>
  [1, 2, 3].map((runs) => ({
    at: DateTime.subtract(when, { minutes: 30 * runs }),
    outcome: { type: "silent", note: null },
  }));

/** Just before the cutoff, while #12 is open. */
const beforeCutoffWake = fixedWatchWake(todayAt(11, 37), halfHourlyQuiet(todayAt(11, 37)));

/** Just after the cutoff, while #12 is open. */
const atCutoffWake = fixedWatchWake(todayAt(12, 7), halfHourlyQuiet(todayAt(12, 7)));

/** Just before the cutoff, 17 minutes after #12 merged. */
const mergedBeforeCutoffWake = fixedWatchWake(todayAt(11, 37), halfHourlyQuiet(todayAt(11, 37)));

/** Half an hour after a run already said the watch had ended. */
const endReportedWake = fixedWatchWake(todayAt(12, 37), [
  {
    at: todayAt(12, 7),
    outcome: {
      type: "delivered",
      text: "#12 still hasn't merged, so I've stopped watching it, as planned.",
    },
  },
  ...halfHourlyQuiet(todayAt(12, 7)),
]);

/**
 * Problems with a setup turn's own calls, around the one routine it created:
 * it opens with a `say`, looks for an existing routine before creating one,
 * and ends on a `say` with `done: true` sent once every `set_routine` that
 * saved or changed the routine, as the turn leaves it, had returned. Returns
 * the problems and the closing message's text.
 */
const setupProblems = (
  calls: ReadonlyArray<Call>,
  { call: creation, routine }: { readonly call: Call; readonly routine: Routine },
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
      ...named(calls, "set_routine")
        .filter(
          (call) =>
            call === creation ||
            (call.refused === false &&
              call.routine !== undefined &&
              call.routine.action !== "create" &&
              call.routine.id === routine.id),
        )
        .flatMap((saved) =>
          after(saved, closing.call, {
            source: saved === creation ? "saved the routine" : "changed the routine",
            dependent: "confirmed it",
          }),
        ),
      ...(closing.say.done === true ? [] : ["the closing `say` does not carry `done: true`"]),
    ],
    closing: closing.say.text,
  };
};

/**
 * The one routine a setup turn must create, as the turn leaves it, with the
 * call that created it, or why there is none: a `set_routine` the server
 * would refuse fails the setup, even if a later one was saved, whether its
 * schedule or time was refused, its arguments did not decode (a cron with six
 * fields, say) or it named a routine the bot does not have. What a later
 * `update`, `pause` or `delete` did to the routine counts: a routine the turn
 * leaves paused or deleted never runs.
 */
const theCreated = (calls: ReadonlyArray<Call>, held: ReadonlyArray<Routine>) => {
  const refused = named(calls, "set_routine").filter((call) => call.refused === true);
  if (refused.length > 0) {
    return `the server would refuse ${refused.length === 1 ? "a `set_routine` call" : `${refused.length} \`set_routine\` calls`}: ${refused.map((call) => `${JSON.stringify(call.input)} → ${call.output}`).join("; ")}`;
  }
  const sent = creates(calls);
  const [first, ...others] = sent;
  if (first === undefined || others.length > 0)
    return `${sent.length} \`set_routine\` creates, not one`;
  const [routine, ...more] = held;
  if (routine === undefined) return "the routine it created is deleted by the end of the turn";
  if (more.length > 0) return `${held.length} routines at the end of the turn, not one`;
  if (!routine.enabled) return "the routine it created ends the turn paused, so it never runs";
  return { call: first.call, routine };
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
 * judge reads whether it reports them as new, with their titles); every change
 * to the state file, a write or a removal, comes in a later model message than
 * the message; and the file, as the turn leaves it, lists every open pull
 * request.
 */
const stateRunProblems = (
  calls: ReadonlyArray<Call>,
  stateAtEnd: string | undefined,
): ReadonlyArray<string> => {
  const [message] = named(calls, "say");
  if (message === undefined) return [];
  const text = says(calls).find(({ call }) => call === message)?.say.text ?? "";
  const changedState = (type: "file-written" | "file-removed") =>
    calls.filter((call) => did(call, (event) => event.type === type && event.path === STATE_PATH));
  const writes = changedState("file-written");
  const changes = [...writes, ...changedState("file-removed")];
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
    ...(changes.some((call) => call.step <= message.step)
      ? ["changed the state file before its message was recorded"]
      : []),
    ...(JSON.stringify(reportedNumbers) === JSON.stringify(REPORTED_AFTER)
      ? []
      : [
          `the state file ends the turn as ${stateAtEnd === undefined ? "missing" : JSON.stringify(stateAtEnd)}, not listing ${REPORTED_AFTER.join(", ")} under "reported"`,
        ]),
  ];
};

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
        ...(yield* judged(PLAIN_SENTENCES, ONE_OFF, closing.say.text)),
        ...(yield* Effect.forEach(later, ({ say }) =>
          judged(opposite, ONE_OFF, say.text, false),
        )).flat(),
      ];
    }),
  } satisfies Omit<Case, "name">;
};

const setupWake = userWake(SETUP);

const looseWake = userWake(LOOSE);

const everyMorningWake = userWake(EVERY_MORNING);

/**
 * The routine a setup turn created, with its runs over the next week as your
 * user's clock shows them, so any cron expression that runs at the same times
 * grades the same; a string says why there is none.
 */
const createdSchedule = (
  calls: ReadonlyArray<Call>,
  held: ReadonlyArray<Routine>,
  from: DateTime.Utc,
) => {
  const creation = theCreated(calls, held);
  if (typeof creation === "string") return creation;
  const { trigger } = creation.routine;
  const schedule = trigger._tag === "schedule" ? trigger.cron : "";
  return { creation, schedule, runs: weekOfRuns(schedule, timeZone, from) };
};

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_WEEKDAY = [0, 1, 2, 3, 4, 5, 6];

/** Problems with the days a week of `runs` falls on, against the days expected. */
const daysProblems = (
  schedule: string,
  runs: ReadonlyArray<LocalRun>,
  expected: ReadonlyArray<number>,
  what: string,
): ReadonlyArray<string> => {
  const days = [...new Set(runs.map((run) => run.weekday))].sort();
  return days.join(",") === expected.join(",")
    ? []
    : [`schedule "${schedule}" runs on days ${days.join(",") || "(none)"}, not ${what}`];
};

/**
 * A watch's setup turn, graded in parts: one routine saved on a schedule, the
 * default cutoff in its instruction, the same date in the closing `say`, and,
 * when `replay` is set, its saved instruction run as the server would.
 */
const watchSetup = (name: string, asked: string, replay: boolean): Case => {
  const wake = userWake(asked);
  return {
    name,
    scenario: { wake, workspace: twelveWorkspace(wake, TWELVE_OPEN) },
    grades: ({ calls, routines }, { model, skills }) => {
      const creation = theCreated(calls, routines.current);
      if (typeof creation === "string") return [gradeFromCalls("saved one watch", [creation])];
      const { problems, closing } = setupProblems(calls, creation);
      return [
        gradeFromCalls("saved one watch", [
          ...problems,
          ...(creation.routine.trigger._tag === "schedule"
            ? []
            : ["the watch was not saved with a schedule"]),
        ]),
        {
          name: "saved the cutoff",
          problems: judged(CUTOFF_SAVED, asked, creation.routine.instruction),
        },
        {
          name: "confirmed the cutoff",
          problems:
            closing === undefined
              ? Effect.succeed(["no closing `say` confirmed the watch"])
              : judged(CUTOFF_CONFIRMED, asked, closing),
        },
        ...(replay ? savedWatchGrades(model, skills, creation.routine) : []),
      ];
    },
  };
};

const cases: ReadonlyArray<Case> = [
  {
    name: "creates a routine for recurring work, whose saved instruction runs silent on a passing build and reports a failing one",
    scenario: { wake: setupWake, workspace: buildWorkspace(setupWake, PASSING_RUNS) },
    problems: Effect.fn("evals.setupCase")(function* ({ calls, routines }, { model, skills }) {
      const creation = theCreated(calls, routines.current);
      if (typeof creation === "string") return [creation];
      const { problems, closing } = setupProblems(calls, creation);
      const { trigger } = creation.routine;
      const schedule = trigger._tag === "schedule" ? trigger.cron : "";
      const runs = weekOfRuns(schedule, timeZone, setupWake.at);
      const weekdaysAtEight =
        runs.length === WEEKDAYS.length &&
        runs.every((run) => run.hour === 8 && run.minute === 0) &&
        daysProblems(schedule, runs, WEEKDAYS, "").length === 0;
      return [
        ...problems,
        ...(weekdaysAtEight ? [] : [`schedule "${schedule}" is not weekdays at 8:00`]),
        ...(closing === undefined ? [] : yield* judged(WEEKDAYS_AT_EIGHT, SETUP, closing)),
        ...(yield* replayDocsCheck(model, skills, creation.routine)),
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
    problems: Effect.fn("evals.failureCase")(function* ({ calls }) {
      const { text } = spoke(calls, routineWake, { look: BUILD_LOOK });
      return [
        ...(yield* speaksOnce(routineWake, FAILURE_NAMED, { look: BUILD_LOOK })(calls)),
        ...(text === undefined ? [] : yield* judged(PLAIN_SENTENCES, DOCS_CHECK, text)),
      ];
    }),
  },
  {
    name: "sends a due reminder exactly once",
    scenario: { wake: reminderWake, workspace: buildWorkspace(reminderWake, PASSING_RUNS) },
    problems: ({ calls }) => speaksOnce(reminderWake, REMINDED)(calls),
  },
  {
    name: "reads the dates in a late run's instruction against when it was due",
    scenario: { wake: lateBriefingWake, workspace: agendaWorkspace },
    problems: ({ calls }) =>
      speaksOnce(lateBriefingWake, DAY_AFTER_DUE, { look: AGENDA_LOOK })(calls),
  },
  {
    name: "says once what blocked a routine run that lost its access",
    scenario: { wake: routineWake, workspace: signedOutWorkspace(routineWake) },
    problems: Effect.fn("evals.accessLostCase")(function* ({ calls }) {
      const { text } = spoke(calls, routineWake, { look: GH_TRIED });
      return [
        ...(yield* speaksOnce(routineWake, ACCESS_LOST, { look: GH_TRIED })(calls)),
        ...(text === undefined ? [] : yield* judged(FIX_NAMED, DOCS_CHECK, text)),
      ];
    }),
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
  watchSetup(
    "watch setup: an undated request saves a watch with a cutoff 14 days on, confirms that date, and its saved instruction runs right",
    MERGE_ASKED_PLAIN,
    true,
  ),
  watchSetup(
    "watch setup: a forecast of when it lands leaves the cutoff 14 days on, saved and confirmed",
    MERGE_ASKED,
    false,
  ),
  {
    name: "watch execution: just before its cutoff, a run while #12 is open stays silent and keeps watching",
    scenario: { wake: beforeCutoffWake, workspace: twelveWorkspace(beforeCutoffWake, TWELVE_OPEN) },
    problems: fromCalls(silentRun(beforeCutoffWake, TWELVE_LOOK)),
  },
  {
    name: "watch execution: just before its cutoff, a run that cannot reach GitHub says once what blocks it and does not pause",
    scenario: { wake: beforeCutoffWake, workspace: signedOutWorkspace(beforeCutoffWake) },
    problems: Effect.fn("evals.blockedBeforeCutoffCase")(function* ({ calls }) {
      const routineCalls = named(calls, "set_routine").map(
        () => "called `set_routine`, though a blocked run before the cutoff keeps the watch going",
      );
      return [
        ...routineCalls,
        ...(yield* speaksOnce(beforeCutoffWake, SOURCE_UNREACHED, { look: GH_TRIED })(calls)),
      ];
    }),
  },
  {
    name: "watch execution: just before its cutoff, a run once #12 has merged says so once, then pauses",
    scenario: {
      wake: mergedBeforeCutoffWake,
      workspace: twelveWorkspace(mergedBeforeCutoffWake, twelveMerged(17)),
    },
    problems: Effect.fn("evals.mergedBeforeCutoffCase")(function* ({ calls }) {
      const { problems, text } = endingRun(calls, mergedBeforeCutoffWake);
      return text === undefined
        ? problems
        : [...problems, ...(yield* judged(MERGED, FIXED_WATCH, text))];
    }),
  },
  {
    name: "watch execution: just after its cutoff, a run while #12 is open says once that the watch ended, then pauses",
    scenario: { wake: atCutoffWake, workspace: twelveWorkspace(atCutoffWake, TWELVE_OPEN) },
    problems: Effect.fn("evals.atCutoffCase")(function* ({ calls }) {
      const { problems, text } = endingRun(calls, atCutoffWake);
      return text === undefined
        ? problems
        : [...problems, ...(yield* judged(WATCH_ENDED, FIXED_WATCH, text))];
    }),
  },
  {
    name: "watch execution: just after its cutoff, a merge from before the cutoff, first seen now, is reported, then it pauses",
    scenario: { wake: atCutoffWake, workspace: twelveWorkspace(atCutoffWake, twelveMerged(17)) },
    problems: Effect.fn("evals.seenLateCase")(function* ({ calls }) {
      const { problems, text } = endingRun(calls, atCutoffWake);
      return text === undefined
        ? problems
        : [...problems, ...(yield* judged(MERGED, FIXED_WATCH, text))];
    }),
  },
  {
    name: "watch execution: just after its cutoff, a merge after the cutoff does not count: the watch ended, then it pauses",
    scenario: { wake: atCutoffWake, workspace: twelveWorkspace(atCutoffWake, twelveMerged(5)) },
    problems: Effect.fn("evals.lateMergeCase")(function* ({ calls }) {
      const { problems, text } = endingRun(calls, atCutoffWake);
      return text === undefined
        ? problems
        : [...problems, ...(yield* judged(WATCH_ENDED, FIXED_WATCH, text))];
    }),
  },
  {
    name: "watch execution: just after its cutoff, a run that cannot reach GitHub ends the watch and says GitHub was out of reach",
    scenario: { wake: atCutoffWake, workspace: signedOutWorkspace(atCutoffWake) },
    grades: ({ calls }) => {
      const { problems, text } = endingRun(calls, atCutoffWake, GH_TRIED);
      return [
        gradeFromCalls("spoke once, then paused", problems),
        {
          name: "said the watch ended",
          problems:
            text === undefined
              ? Effect.succeed(["no message"])
              : judged(WATCH_ENDED, FIXED_WATCH, text),
        },
        {
          name: "said GitHub was out of reach",
          problems:
            text === undefined
              ? Effect.succeed(["no message"])
              : judged(SOURCE_UNREACHED, FIXED_WATCH, text),
        },
      ];
    },
  },
  {
    name: "watch execution: after a run already said the watch ended, a run pauses without repeating it",
    scenario: { wake: endReportedWake, workspace: twelveWorkspace(endReportedWake, TWELVE_OPEN) },
    problems: fromCalls((calls) => quietPause(calls, endReportedWake)),
  },
  {
    name: "runs a loose request about work on weekdays, and says so",
    scenario: { wake: looseWake, workspace: buildWorkspace(looseWake, PASSING_RUNS) },
    grades: ({ calls, routines }) => {
      const created = createdSchedule(calls, routines.current, looseWake.at);
      if (typeof created === "string") return [gradeFromCalls("saved one routine", [created])];
      const { problems, closing } = setupProblems(calls, created.creation);
      const perDay = Math.max(
        0,
        ...WEEKDAYS.map((day) => created.runs.filter((run) => run.weekday === day).length),
      );
      return [
        gradeFromCalls("saved one routine", problems),
        gradeFromCalls(
          "runs Monday to Friday",
          daysProblems(created.schedule, created.runs, WEEKDAYS, "Monday to Friday"),
        ),
        gradeFromCalls(
          "at most every 15 minutes",
          perDay <= 4 * 24
            ? []
            : [
                `schedule "${created.schedule}" runs ${perDay} times a day, more than every 15 minutes`,
              ],
        ),
        {
          name: "confirmed weekdays",
          problems:
            closing === undefined
              ? Effect.succeed(["no closing `say` confirmed the routine"])
              : judged(WEEKDAYS_ONLY, LOOSE, closing),
        },
        {
          name: "no end date, never pauses itself",
          problems: judged(ENDS_ITSELF, LOOSE, created.creation.routine.instruction, false),
        },
      ];
    },
  },
  {
    name: "keeps every day for a request about work whose words name the days",
    scenario: { wake: everyMorningWake, workspace: buildWorkspace(everyMorningWake, PASSING_RUNS) },
    grades: ({ calls, routines }) => {
      const created = createdSchedule(calls, routines.current, everyMorningWake.at);
      if (typeof created === "string") return [gradeFromCalls("saved one routine", [created])];
      const { problems, closing } = setupProblems(calls, created.creation);
      const morningOnce = EVERY_WEEKDAY.every((day) => {
        const onDay = created.runs.filter((run) => run.weekday === day);
        return onDay.length <= 1 && onDay.every((run) => run.hour >= 5 && run.hour <= 11);
      });
      return [
        gradeFromCalls("saved one routine", problems),
        gradeFromCalls(
          "runs every day",
          daysProblems(created.schedule, created.runs, EVERY_WEEKDAY, "every day"),
        ),
        gradeFromCalls(
          "once, in the morning",
          morningOnce
            ? []
            : [`schedule "${created.schedule}" does not run once a day in the morning`],
        ),
        {
          name: "confirmed every day",
          problems:
            closing === undefined
              ? Effect.succeed(["no closing `say` confirmed the routine"])
              : judged(EVERY_DAY, EVERY_MORNING, closing),
        },
      ];
    },
  },
];

/** A call with no arguments or output, for the checks of the graders and the stand-in workspace below. */
const CALL: Call = { step: 1, name: "run_command", input: {}, output: "", events: [] };

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
    expect(types("gh run list -R acme/docs --jq '.[0]'")).toEqual(["gh", "unavailable"]);
    expect(run("jq . files/x.json").output).toMatch(/command not found/);
  });

  it("counts neither `gh --version` nor help as reaching GitHub", () => {
    expect(types("gh --version")).toEqual([]);
    expect(types("gh run list --help")).toEqual(["unavailable"]);
  });

  /** A workspace with two notes besides the state file, as a run might find it. */
  const notes = () =>
    githubWorkspace(
      github(runAt, FAILING_RUNS),
      new Map([
        [STATE_FILE, STATE],
        ["files/a.txt", "a"],
        ["files/b.txt", "b"],
      ]),
    );
  const changes = (workspace: Workspace<GhEvent>, command: string) =>
    workspace.run(command).events.filter((event) => event.type !== "file-read");

  it("records what a command left changed, not each step it took", () => {
    const workspace = notes();
    expect(changes(workspace, "mv files/a.txt files/c.txt")).toEqual([
      { type: "file-removed", path: `${HOME}/files/a.txt` },
      { type: "file-written", path: `${HOME}/files/c.txt`, content: "a" },
    ]);
    expect(changes(workspace, "rm -f files/b.txt files/missing.txt")).toEqual([
      { type: "file-removed", path: `${HOME}/files/b.txt` },
    ]);
    expect(
      changes(workspace, "echo x > /tmp/scratch && cat /tmp/scratch && rm /tmp/scratch"),
    ).toEqual([]);
    expect(
      changes(workspace, `echo '{"reported":[1]}' > /tmp/state && mv /tmp/state ${STATE_FILE}`),
    ).toEqual([{ type: "file-written", path: STATE_PATH, content: '{"reported":[1]}\n' }]);
    expect(types("curl -X POST https://hooks.example.com/docs")).toEqual(["unavailable"]);
    expect(types("for f in files/*; do rm $f; done")).toEqual(["unavailable"]);
  });

  it("expands an unquoted glob against the workspace, and keeps one that matches nothing", () => {
    const workspace = notes();
    expect(workspace.run("echo files/*").output).toBe(
      "files/a.txt files/b.txt files/docs-prs.json\n",
    );
    expect(workspace.run("echo files/?.txt files/[!a].txt").output).toBe(
      "files/a.txt files/b.txt files/b.txt\n",
    );
    expect(workspace.run("echo 'files/*' files/\\* \"files/*\" files/*.md").output).toBe(
      "files/* files/* files/* files/*.md\n",
    );
    expect(workspace.run("cd files && echo *.txt ../files/a*").output).toBe(
      "a.txt b.txt ../files/a.txt\n",
    );
    expect(workspace.run("ls files/*").output).toBe(
      "files/a.txt\nfiles/b.txt\nfiles/docs-prs.json\n",
    );
  });

  it("removes a folder only with -r, and everything under it", () => {
    const refused = notes();
    const run = refused.run("rm files");
    expect(run.output).toBe("rm: cannot remove files: Is a directory\n");
    expect(run.events).toEqual([]);
    expect(refused.run("rm files && echo removed || echo kept").output).toMatch(/^kept$/m);

    const removed = notes();
    expect(changes(removed, "rm -rf files/")).toEqual([
      { type: "file-removed", path: `${HOME}/files/a.txt` },
      { type: "file-removed", path: `${HOME}/files/b.txt` },
      { type: "file-removed", path: STATE_PATH },
      { type: "directory-removed", path: `${HOME}/files` },
    ]);
    expect(removed.run("ls files").output).toBe("ls: files: No such file or directory\n");
  });

  it("records a folder created, and runs `:` as doing nothing", () => {
    expect(changes(notes(), "mkdir -p files/extra/deep")).toEqual([
      { type: "directory-created", path: `${HOME}/files/extra` },
      { type: "directory-created", path: `${HOME}/files/extra/deep` },
    ]);
    expect(run(": nothing to see")).toEqual({ output: "", events: [] });
  });

  it("keeps a file written with a here-document for later commands", () => {
    const workspace = githubWorkspace(github(runAt, FAILING_RUNS));
    const write = workspace.run(`cat > ${STATE_FILE} <<'EOF'\n{"reported":[1]}\nEOF`);
    expect(write.events).toEqual([
      { type: "file-written", path: STATE_PATH, content: '{"reported":[1]}\n' },
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
      { type: "file-written", path: STATE_PATH, content: JSON.stringify({ reported: numbers }) },
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
        { type: "file-written", path: STATE_PATH, content: final() },
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
    [
      "a removal of the state file before the message",
      [
        ...look,
        call(2, "run_command", {}, [{ type: "file-removed", path: STATE_PATH }]),
        say(3, report),
        write(4),
      ],
      final(),
    ],
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
          { type: "file-written", path: `${HOME}/files/notes.txt`, content: "done" },
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

  describe("on commands run in the stand-in workspace after the message", () => {
    const NOTES = "files/notes.txt";
    const ran = (step: number, command: string) => (workspace: Workspace<GhEvent>) =>
      call(step, "run_command", { command }, workspace.run(command).events);
    /** The run's calls, each command run in one workspace in order, and the state file it leaves. */
    const played = (after: ReadonlyArray<(workspace: Workspace<GhEvent>) => Call>) => {
      const workspace = githubWorkspace(
        github(pullRequestWake.at, PASSING_RUNS),
        new Map([
          [STATE_FILE, STATE],
          [NOTES, "notes"],
        ]),
      );
      const calls = [...look, say(2, report), ...after.map((step) => step(workspace))];
      return stateRun(calls, workspace.file(STATE_FILE));
    };
    const update = `echo '${final()}' > ${STATE_FILE}`;

    it.each([
      ["the state-file update", [ran(3, update)]],
      [
        "the update written to a temporary file and moved into place",
        [ran(3, `echo '${final()}' > ${STATE_FILE}.tmp && mv ${STATE_FILE}.tmp ${STATE_FILE}`)],
      ],
      [
        "the update moved in from /tmp",
        [ran(3, `echo '${final()}' > /tmp/state.json && mv /tmp/state.json ${STATE_FILE}`)],
      ],
      ["a look at the files after it", [ran(3, update), ran(4, "ls files/*")]],
      [
        "an `rm` of a folder without -r, which removes nothing",
        [ran(3, update), ran(4, "rm files")],
      ],
    ])("accepts %s", (_, after) => {
      expect(played(after)).toEqual([]);
    });

    it.each([
      ["an `rm` after it", [ran(3, update), ran(4, `rm ${NOTES}`)]],
      ["an `rm -rf` of the folder", [ran(3, update), ran(4, "rm -rf files/")]],
      ["an `rm -r` of the folder", [ran(3, update), ran(4, "rm -r files")]],
      ["an `rm -f` of a glob", [ran(3, update), ran(4, "rm -f files/*")]],
      ["a folder created", [ran(3, update), ran(4, "mkdir -p files/extra")]],
      [
        "a POST through a command the workspace lacks",
        [ran(3, update), ran(4, "curl -X POST https://hooks.example.com/docs")],
      ],
      ["the update with an `rm` of another file", [ran(3, `${update} && rm ${NOTES}`)]],
      ["the update with an `rm -f` of a glob", [ran(3, `${update} && rm -f files/n*`)]],
      ["the update with a folder created", [ran(3, `${update} && mkdir files/extra`)]],
    ])("rejects %s", (_, after) => {
      expect(played(after)).not.toEqual([]);
    });

    it.each([
      ["ls files/*", true],
      ["cat files/*", true],
      ["echo x > /tmp/scratch && rm /tmp/scratch", true],
      ["rm -rf files/", false],
      ["rm -f files/*", false],
      ["rm -r files", false],
      ["mkdir -p files/extra", false],
    ])("counts %j as read-only: %s", (command, readOnly) => {
      const workspace = githubWorkspace(
        github(pullRequestWake.at, PASSING_RUNS),
        new Map([[NOTES, "n"]]),
      );
      expect(READ_ONLY.test(ran(3, command)(workspace))).toBe(readOnly);
    });

    it.each([
      [`${update} && rm -f files/*`, false],
      [`${update} && rm -f ${NOTES}`, false],
      [`echo '${final()}' > /tmp/state.json && mv /tmp/state.json ${STATE_FILE}`, true],
    ])("counts %j as a state-file update: %s", (command, counts) => {
      const workspace = githubWorkspace(
        github(pullRequestWake.at, PASSING_RUNS),
        new Map([
          [STATE_FILE, STATE],
          [NOTES, "n"],
        ]),
      );
      expect(
        stateUpdate(pullRequestWake.routine.instruction).test(ran(3, command)(workspace)),
      ).toBe(counts);
    });
  });

  describe("on the merge watch's run once #12 has merged", () => {
    const read = call(1, "run_command", {}, [
      { type: "gh" },
      { type: "pull-request-read", number: 12 },
    ]);
    const merged = (step: number) => call(step, "say", { text: "#12 merged.", done: true });
    const pause = (step: number): Call => {
      const routine: ToolInput<"set_routine"> = { action: "pause", id: routineWake.routine.id };
      return { ...call(step, "set_routine", routine), routine };
    };
    const stateWrite = (step: number) =>
      call(step, "run_command", {}, [
        { type: "file-written", path: `${HOME}/files/watch.json`, content: "{}" },
      ]);
    const wake: RoutineWake = {
      ...routineWake,
      routine: {
        ...routineWake.routine,
        instruction:
          "Check pull request #12 on acme/docs. Once it has merged, tell your user, then pause this routine. Keep files/watch.json up to date.",
      },
    };

    it("accepts a message, then a pause as the last call", () => {
      expect(endingRun([read, merged(2), pause(3)], wake).problems).toEqual([]);
    });

    it("rejects a read-only call after the pause", () => {
      expect(
        endingRun([read, merged(2), pause(3), call(4, "list_routines", {})], wake).problems,
      ).not.toEqual([]);
    });

    it("accepts a state-file write between the message and the pause", () => {
      expect(endingRun([read, merged(2), stateWrite(3), pause(4)], wake).problems).toEqual([]);
    });
  });

  it("does not count `gh --version` as trying GitHub in a run that lost its access", () => {
    const ran = (command: string) =>
      call(
        1,
        "run_command",
        { command },
        signedOutWorkspace(blockerReportedWake)().run(command).events,
      );
    const silent = silentRun(blockerReportedWake, GH_TRIED);
    expect(silent([ran("gh --version")])).toContain("never ran `gh`");
    expect(silent([ran("gh auth status")])).toEqual([]);
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

describe("the setup grader", () => {
  const routine: ToolInput<"set_routine"> = {
    action: "create",
    name: "Docs build",
    instruction: DOCS_CHECK,
    schedule: "0 8 * * 1-5",
  };
  /** A setup turn's `set_routine` calls, each answered by the stub in order, and the routines it leaves. */
  const setup = (inputs: ReadonlyArray<ToolInput<"set_routine">>) => {
    const held = new HeldRoutines(setupWake);
    const calls = inputs.map((input, index): Call => {
      const saved = held.set(input);
      return {
        ...CALL,
        step: index + 2,
        name: "set_routine",
        input,
        routine: input,
        output: saved.output,
        refused: saved.refused,
      };
    });
    return { calls, held: held.current };
  };

  it("takes the one create the server saved, as the turn leaves it", () => {
    const { calls, held } = setup([routine]);
    expect(theCreated(calls, held)).toEqual({ call: calls[0], routine: held[0] });
  });

  it("replays the routine as a later update left it", () => {
    const instruction = `${DOCS_CHECK} Mention the run's number.`;
    const { calls, held } = setup([routine, { action: "update", id: "routine-1", instruction }]);
    const created = theCreated(calls, held);
    expect(typeof created === "string" ? created : created.routine.instruction).toBe(instruction);
  });

  it.each([
    ["it is paused later in the turn", [routine, { action: "pause", id: "routine-1" }]],
    ["it is deleted later in the turn", [routine, { action: "delete", id: "routine-1" }]],
    [
      "an update names a routine the bot does not have",
      [routine, { action: "update", id: "routine-9", name: "Docs" }],
    ],
  ] satisfies ReadonlyArray<[string, ReadonlyArray<ToolInput<"set_routine">>]>)(
    "fails a create when %s",
    (_, inputs) => {
      const { calls, held } = setup(inputs);
      expect(theCreated(calls, held)).toBeTypeOf("string");
    },
  );

  it("rejects a closing `say` sent with an update of the routine, not after it returned", () => {
    const { calls, held } = setup([
      routine,
      { action: "update", id: "routine-1", name: "Docs build check" },
    ]);
    const created = theCreated(calls, held);
    if (typeof created === "string") throw new Error(created);
    const turn = (closingStep: number): ReadonlyArray<Call> => [
      { ...CALL, step: 1, name: "say", input: { text: "Setting it up." } },
      { ...CALL, step: 1, name: "list_routines" },
      ...calls,
      { ...CALL, step: closingStep, name: "say", input: { text: "Saved.", done: true } },
    ];
    expect(setupProblems(turn(4), created).problems).toEqual([]);
    expect(setupProblems(turn(3), created).problems).not.toEqual([]);
  });

  it("rejects a create refused before it decoded, though a later one was saved", () => {
    const { calls, held } = setup([routine]);
    const sixFields: Call = {
      ...CALL,
      step: 1,
      name: "set_routine",
      input: { ...routine, schedule: "0 0 8 * * 1-5" },
      output: JSON.stringify({ error: "The call was refused as invalid." }),
      refused: true,
    };
    expect(theCreated([sixFields, ...calls], held)).toBeTypeOf("string");
  });
});

judgeOnFixedMessages(CHECKS);

runCases(cases);
