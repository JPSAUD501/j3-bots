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

export interface Case {
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
export const fromCalls =
  (problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>): Case["problems"] =>
  (turn) =>
    Effect.succeed(problems(turn.calls));

const SKILL_COLUMNS: ReadonlyArray<Skills> = ["with the skill", "without the skill"];

/** Runs every case for every model, with the shipped skills as read and without them. */
export const runCases = (cases: ReadonlyArray<Case>): void => {
  describe.each(MODELS)("%s", (model) => {
    describe.each(SKILL_COLUMNS)("%s", (skills) => {
      it.concurrent.each(cases)("$name", async ({ scenario, problems }) => {
        const turn = await Effect.runPromise(runTurn(model, skills, scenario));
        expect(
          await Effect.runPromise(problems(turn, { model, skills })),
          transcript(turn),
        ).toEqual([]);
      });
    });
  });
};
