// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Schema from "effect/Schema";
import { complete } from "./model.ts";

/**
 * A yes-or-no question about a bot's message, put to one model under a fixed
 * rubric, for what no tool call shows: whether a message tells its reader
 * something, plainly. Every check of what a message means goes through here.
 * The graders themselves look at a message's text in one place only: that the
 * pull-request digest has #124 and #125 in it as numbers, a structural check
 * beside the judge's reading of it.
 *
 * `J3_EVAL_JUDGE_MODEL` names the model, by default a small Claude model. That
 * default is also one of the models under test, so its reading of a bot's
 * message could share the bot's blind spots. What keeps it honest is that
 * every question it answers is also put, on every eval run, to fixed messages
 * whose answer is known, worded in ways a keyword match would miss and
 * including the opposite claim: a judge that drifts fails those, and the run
 * shows it. Its answers are sampled at temperature 0, and a reply that did not
 * finish on its own, called a tool, or whose last line is not yes or no (in
 * any case, with trailing punctuation allowed), is unclear: the report counts
 * it apart from the bot's failures, never either way. Temperature 0 through a proxy
 * is not deterministic (the same message has drawn both answers), so each
 * question is answered three times and the majority decides, for the fixed
 * messages as for a bot's.
 */

const JUDGE_MODEL = Config.String("J3_EVAL_JUDGE_MODEL").pipe(
  Config.withDefault("claude-haiku-5-5"),
);

/** The judge's reply was cut off, or did not end on a line that reads yes or no. */
class JudgeUnclear extends Schema.TaggedError<JudgeUnclear>()("JudgeUnclear", {
  message: Schema.String,
}) {}

const RUBRIC = [
  "You check one message that a bot sent its user, in answer to what the user asked or to the bot's own saved instruction, against one question about it. Read the message as that answer: what it leaves implicit, such as a time of day the user already gave, it means as asked.",
  "Answer yes when the message plainly states what the question asks, in any words. Answer no when it states the opposite, does not say, hedges that statement (it looks, seems or is probably so), says it could not check or confirm it, or contradicts itself.",
  "Context around a plain statement does not undo it: what happened earlier, or a note of what the message did not cover, is not a hedge.",
  "First name, in one sentence, the statement the message makes about what the question asks. Then, on a last line of its own, write only yes or no, in lowercase, with nothing else on that line.",
].join("\n");

/** One judge reply: yes or no, or {@link JudgeUnclear}. */
const verdict = Effect.fn("evals.verdict")(function* (
  model: string,
  asked: string,
  message: string,
  question: string,
) {
  const reply = yield* complete(
    model,
    [
      { role: "system", content: RUBRIC },
      {
        role: "user",
        content: `The bot was answering:\n${asked}\n\nThe bot's message:\n${message}\n\nQuestion: ${question}`,
      },
    ],
    [],
    { temperature: 0 },
  );
  const text = reply.content ?? "";
  const last = text
    .trimEnd()
    .split("\n")
    .at(-1)
    ?.trim()
    .toLowerCase()
    .replace(/[.!*_`]+$/u, "")
    .replace(/^[*_`]+/u, "");
  if (
    reply.finishReason !== "stop" ||
    reply.toolCalls.length > 0 ||
    (last !== "yes" && last !== "no")
  ) {
    return yield* new JudgeUnclear({
      message: `The judge's reply is unclear: it must finish on its own (finish_reason ${reply.finishReason ?? "(none)"}), call no tools (it called ${reply.toolCalls.length}) and end on a line that reads yes or no: ${text === "" ? "(no text)" : text}`,
    });
  }
  return last === "yes";
});

/** How many times the judge answers each question; the verdict is the majority. */
const VOTES = 3;

/**
 * Whether `message`, the bot's answer to `asked`, plainly says what
 * `question` asks, as the majority of {@link VOTES} judge replies reads it.
 * Every reply must be clear: one unclear reply makes the verdict {@link JudgeUnclear}.
 */
export const judge = Effect.fn("evals.judge")(function* (
  asked: string,
  message: string,
  question: string,
) {
  const model = yield* JUDGE_MODEL;
  const votes = yield* Effect.all(
    Array.from({ length: VOTES }, () => verdict(model, asked, message, question)),
    { concurrency: VOTES },
  );
  return votes.filter(Boolean).length * 2 > VOTES;
}, Effect.provide(FetchHttpClient.layer));
