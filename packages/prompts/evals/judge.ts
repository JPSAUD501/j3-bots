// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Schema from "effect/Schema";
import { complete } from "./model.ts";

/**
 * A yes-or-no question about a bot's message, put to one model under a fixed
 * rubric, for what no tool call shows: whether a message tells its reader
 * something, plainly. The judge's reading is itself checked on fixed messages
 * in each eval file that uses it, and an answer that is not a plain yes or no
 * fails the case instead of passing it.
 *
 * `J3_EVAL_JUDGE_MODEL` names the model, by default a small Claude model.
 */

const JUDGE_MODEL = Config.String("J3_EVAL_JUDGE_MODEL").pipe(
  Config.withDefault("claude-haiku-5-5"),
);

/** The judge answered something other than yes or no. */
class JudgeUnclear extends Schema.TaggedError<JudgeUnclear>()("JudgeUnclear", {
  message: Schema.String,
}) {}

const RUBRIC = [
  "You check one message that a bot sent its user in answer to what the user asked, against one question about it. Read the message as that answer.",
  "Answer yes when the message plainly states what the question asks, in any words. Answer no when it states the opposite, does not say, hedges that statement (it looks, seems or is probably so), says it could not check or confirm it, or contradicts itself.",
  "Context around a plain statement does not undo it: what happened earlier, or a note of what the message did not cover, is not a hedge.",
  "First name, in one sentence, the statement the message makes about what the question asks. Then, on a last line of its own, write only yes or no.",
].join("\n");

/** Whether `message`, the bot's answer to `asked`, plainly says what `question` asks, as the judge reads it. */
export const judge = Effect.fn("evals.judge")(function* (
  asked: string,
  message: string,
  question: string,
) {
  const model = yield* JUDGE_MODEL;
  const reply = yield* complete(
    model,
    [
      { role: "system", content: RUBRIC },
      {
        role: "user",
        content: `The user asked:\n${asked}\n\nThe bot's message:\n${message}\n\nQuestion: ${question}`,
      },
    ],
    [],
  );
  // The verdict is the last word of the reply: "no", "Answer: no", "Its last line: no".
  const verdict = /\b(yes|no)\W*$/i.exec((reply.content ?? "").trim())?.[1]?.toLowerCase();
  if (verdict === undefined) {
    return yield* new JudgeUnclear({
      message: `The judge's reply does not end with yes or no: ${reply.content ?? "(no text)"}`,
    });
  }
  return verdict === "yes";
}, Effect.provide(FetchHttpClient.layer));
