// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * A model behind an OpenAI-compatible chat completions endpoint, which is what
 * a local model proxy usually offers for every provider it reaches. The
 * endpoint and its key come from the environment and are never logged:
 *
 * - `J3_EVAL_BASE_URL`: the endpoint's root; requests go to
 *   `<root>/v1/chat/completions`.
 * - `J3_EVAL_API_KEY`: sent as a bearer token.
 */

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});
type ToolCall = typeof ToolCall.Type;

const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literals(["system", "user"]), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    content: Schema.String,
  }),
]);
export type Message = typeof Message.Type;

/** A tool as the endpoint takes it. */
export interface FunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: { readonly [key: string]: unknown };
  };
}

const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Message),
  tools: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("function"),
      function: Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        parameters: Schema.Record(Schema.String, Schema.Unknown),
      }),
    }),
  ),
});

/** The parts of an answer the evals read. Everything else the endpoint sends is ignored. */
const ChatResponse = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.optionalKey(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(ToolCall))),
      }),
      finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

/** One assistant message: its text, the tools it called, and why it ended. */
interface Reply {
  readonly content: string | null;
  readonly toolCalls: ReadonlyArray<ToolCall>;
  /**
   * The endpoint's `finish_reason`: `stop` when the model ended the message
   * itself, `tool_calls` when it stopped to call tools, `length` when it was
   * cut off. `null` when the endpoint did not say. A proxy that reports
   * `stop` alongside tool calls fails the turn as unfinished, on purpose.
   */
  readonly finishReason: string | null;
}

/** Sends a conversation to `model` and returns its next message. */
export const complete = Effect.fn("evals.complete")(function* (
  model: string,
  messages: ReadonlyArray<Message>,
  tools: ReadonlyArray<FunctionTool>,
) {
  const baseUrl = yield* Config.NonEmptyString("J3_EVAL_BASE_URL");
  const apiKey = yield* Config.Redacted("J3_EVAL_API_KEY");
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    // A proxy in front of a subscription answers 429 and 5xx now and then.
    HttpClient.retryTransient({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
  );
  const request = yield* HttpClientRequest.post(
    `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
  ).pipe(
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.schemaBodyJson(ChatRequest)({ model, messages, tools }),
  );
  const response = yield* client.execute(request);
  const body = yield* HttpClientResponse.schemaBodyJson(ChatResponse)(response);
  const [choice] = body.choices;
  return {
    content: choice.message.content ?? null,
    toolCalls: choice.message.tool_calls ?? [],
    finishReason: choice.finish_reason ?? null,
  } satisfies Reply;
});
