// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolInput } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { BotSession } from "../bots/EngineSessions.ts";

/** The tools whose effect belongs to the turn that called them. */
const TurnToolName = Schema.Literals(["say", "ask", "message_bot", "set_routine"]);
type TurnToolName = typeof TurnToolName.Type;

/** A bot tool that acts for a turn, called before the server can admit tool calls to turns. */
export class TurnToolUnavailable extends Schema.TaggedError<TurnToolUnavailable>()(
  "TurnToolUnavailable",
  { tool: TurnToolName },
) {
  override get message(): string {
    return `${this.tool} is not available yet.`;
  }
}

/** One call to a turn tool: who made it, under which id, and its decoded arguments. */
export type TurnToolCall = {
  [N in TurnToolName]: {
    readonly tool: N;
    readonly requestId: string;
    readonly caller: BotSession;
    readonly input: ToolInput<N>;
  };
}[TurnToolName];

/**
 * Where the tools that act for a turn go: `say` and `ask` deliver to the
 * turn's audience, `message_bot` wakes or holds for a teammate, and
 * `set_routine` changes a routine on the bot's behalf. Each call is first
 * matched to the engine's record of it in the session's admitted turn
 * (`docs/architecture/server.md`, Bot tools), which is the wake pipeline's.
 *
 * Until that exists, `layer` admits none of them.
 */
export class TurnTools extends Context.Service<
  TurnTools,
  { readonly call: (call: TurnToolCall) => Effect.Effect<unknown, TurnToolUnavailable> }
>()("@j3-bots/server/tools/TurnTools") {}

export const layer = Layer.succeed(
  TurnTools,
  TurnTools.of({
    call: Effect.fn("TurnTools.call")(function* (call: TurnToolCall) {
      return yield* new TurnToolUnavailable({ tool: call.tool });
    }),
  }),
);
