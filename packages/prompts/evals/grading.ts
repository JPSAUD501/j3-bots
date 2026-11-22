// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, tools, type Wake } from "../src/index.ts";
import {
  type Call,
  runTurn,
  type Scenario,
  type Skills,
  transcript,
  type Turn,
} from "./harness.ts";
import { judge } from "./judge.ts";

/**
 * What every eval file shares: the models, the operator's clock, the judge's
 * questions with the fixed messages that check its reading, the readers of a
 * turn's calls, and the loop that runs each case for each model, with the
 * shipped skills and without them.
 */

/** The models to evaluate, cheapest adequate first. Override with a comma-separated `J3_EVAL_MODELS`. */
const MODELS = Effect.runSync(
  Config.String("J3_EVAL_MODELS").pipe(Config.withDefault("claude-haiku-5-5,gpt-6-luna")),
)
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");

export const timeZone = DateTime.zoneMakeNamedUnsafe("Europe/Lisbon");

/**
 * Today at `hour:minute` in the operator's zone. The fixtures take their date
 * from the real current date, as the server takes a wake's time from its
 * clock, so no date in a wake disagrees with one the model was given
 * elsewhere and invites a correction.
 */
export const todayAt = (hour: number, minute: number): DateTime.Utc =>
  DateTime.toUtc(
    DateTime.setParts(DateTime.makeZonedUnsafe(DateTime.nowUnsafe(), { timeZone }), {
      hour,
      minute,
      second: 0,
      millisecond: 0,
    }),
  );

/** When the operator writes. */
export const at = todayAt(9, 41);
export const base = { at, timeZone, sinceLastTurn: [] } as const;

export const userWake = (text: string, when: DateTime.Utc = at): Wake => ({
  ...base,
  at: when,
  kind: "user",
  answer: null,
  messages: [{ at: when, text, attachments: [] }],
});

/**
 * A yes-or-no question the judge answers about a bot's message, with fixed
 * messages it must answer yes and no to on every eval run (`asked` is what
 * those fixed messages answer). They are worded the ways a bot might put it,
 * so a judge that only matches words, or reads past a negation, fails them.
 */
export interface Check {
  readonly question: string;
  /** How a failure names what the message did not say. */
  readonly what: string;
  readonly asked: string;
  readonly accept: ReadonlyArray<string>;
  readonly reject: ReadonlyArray<string>;
}

/** Problems with `text`, the bot's answer to `asked`, when the judge does not read it as `check` asks. */
export const judged = Effect.fn("evals.judged")(function* (
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

/** Puts each check's question to its fixed messages, which it must answer as they are listed. */
export const judgeOnFixedMessages = (checks: ReadonlyArray<Check>): void => {
  describe("the judge, on fixed messages", () => {
    describe.each(checks)("$question", (check) => {
      it.concurrent.each(check.accept)("answers yes for %j", async (text) => {
        expect(await Effect.runPromise(judge(check.asked, text, check.question))).toBe(true);
      });
      it.concurrent.each(check.reject)("answers no for %j", async (text) => {
        expect(await Effect.runPromise(judge(check.asked, text, check.question))).toBe(false);
      });
    });
  });
};

export const named = (calls: ReadonlyArray<Call>, name: string) =>
  calls.filter((call) => call.name === name);

const decodeSay = Schema.decodeUnknownOption(tools.say.input, DECODE_OPTIONS);

/** The `say` calls the server would accept, decoded, in order. */
export const says = (calls: ReadonlyArray<Call>) =>
  named(calls, "say").flatMap((call) => {
    const decoded = decodeSay(call.input);
    return decoded._tag === "Some" ? [{ call, say: decoded.value }] : [];
  });

/**
 * Problems with a call that depends on what `source` returned: it must exist,
 * and come in a later model message, since calls sent together are written
 * before any of them returns.
 */
export const after = (
  source: Call | undefined,
  dependent: Call | undefined,
  what: { readonly source: string; readonly dependent: string },
): ReadonlyArray<string> =>
  source === undefined
    ? [`never ${what.source}`]
    : dependent !== undefined && dependent.step <= source.step
      ? [`${what.dependent} in the same message as it ${what.source}, or before`]
      : [];

/** A turn's problems under a heading, with its transcript, as one line of a case's report. */
export const reported = (heading: string, turn: Turn, problems: ReadonlyArray<string>) =>
  problems.length === 0 ? [] : [`${heading}: ${problems.join("; ")}\n${transcript(turn)}`];

/** What grading a turn may fail with: a replayed turn that did not finish, or a judge reply. */
type GradeError = Effect.Error<ReturnType<typeof runTurn | typeof judge>>;

/** The model and skill column a case runs under. */
interface RunOf {
  readonly model: string;
  readonly skills: Skills;
}

/** What is wrong with a turn, or with one part of it; empty when it passes. */
type Problems = Effect.Effect<ReadonlyArray<string>, GradeError>;

/** One part of a case's grade, counted on its own in the report. */
export interface Grade {
  readonly name: string;
  readonly problems: Problems;
}

/**
 * A case: a scenario, and either its `problems` as one grade, or `grades`
 * that the report counts one by one.
 */
export type Case = {
  readonly name: string;
  readonly scenario: Scenario;
} & (
  | { readonly problems: (turn: Turn, run: RunOf) => Problems; readonly grades?: never }
  | { readonly grades: (turn: Turn, run: RunOf) => ReadonlyArray<Grade>; readonly problems?: never }
);

/** A case whose problems the turn's own calls show, with no judge. */
export const fromCalls =
  (problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>) =>
  (turn: Turn): Problems =>
    Effect.succeed(problems(turn.calls));

/** A grade the turn's own calls show, with no judge. */
export const gradeFromCalls = (name: string, problems: ReadonlyArray<string>): Grade => ({
  name,
  problems: Effect.succeed(problems),
});

const SKILL_COLUMNS: ReadonlyArray<Skills> = ["with the skill", "without the skill"];

type Outcome = "passed" | "failed" | "judge unclear";

interface Graded {
  readonly name: string;
  readonly outcome: Outcome;
  readonly problems: ReadonlyArray<string>;
}

const graded = (grade: Grade) =>
  grade.problems.pipe(
    Effect.map((problems): Graded => ({
      name: grade.name,
      outcome: problems.length === 0 ? "passed" : "failed",
      problems,
    })),
    Effect.catchTag("JudgeUnclear", (error) =>
      Effect.succeed<Graded>({
        name: grade.name,
        outcome: "judge unclear",
        problems: [error.message],
      }),
    ),
  );

/**
 * Runs every case for every model, with the shipped skills as read and
 * without them, and records each grade's outcome in the test's metadata. A
 * case fails when any of its grades finds a problem; when
 * none does but the judge could not give a clear answer on one, it is
 * skipped and counted apart, since that says nothing about the bot.
 */
export const runCases = (cases: ReadonlyArray<Case>): void => {
  describe.each(MODELS)("%s", (model) => {
    describe.each(SKILL_COLUMNS)("%s", (skills) => {
      // One `it` per case by its full name: a `$name` template is cut short in reports.
      for (const grading of cases) {
        it.concurrent(grading.name, async (context) => {
          const turn = await Effect.runPromise(runTurn(model, skills, grading.scenario));
          const run = { model, skills };
          const grades =
            grading.grades === undefined
              ? [{ name: "all", problems: grading.problems(turn, run) }]
              : grading.grades(turn, run);
          const results = await Effect.runPromise(
            Effect.forEach(grades, graded, { concurrency: "unbounded" }),
          );
          // Each part's outcome, in the test's metadata, so a JSON report counts
          // how often each part passed, failed or got an unclear judge.
          Object.assign(context.task.meta, {
            grades: results.map(({ name, outcome }) => ({ name, outcome })),
          });
          const failed = results.filter((result) => result.outcome === "failed");
          const unclear = results.filter((result) => result.outcome === "judge unclear");
          if (failed.length === 0 && unclear.length > 0) {
            context.skip(
              `judge unclear: ${unclear.flatMap((result) => result.problems).join("; ")}`,
            );
          }
          expect(
            failed.flatMap((result) =>
              result.problems.map((problem) => `${result.name}: ${problem}`),
            ),
            transcript(turn),
          ).toEqual([]);
        });
      }
    });
  });
};
