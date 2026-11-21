// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Conflict } from "@j3-bots/contracts";
import { NO_TURN_REFUSAL, type ToolInput } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BotSession } from "../bots/EngineSessions.ts";

/** The tools whose effect belongs to the turn that called them. */
const TurnToolName = Schema.Literals(["say", "ask", "message_bot", "set_routine"]);
type TurnToolName = typeof TurnToolName.Type;

/**
 * The call matches no open call of the session's running turn: that turn has
 * ended, or the caller is a subagent. Nothing was published or recorded.
 */
export class TurnEnded extends Schema.TaggedError<TurnEnded>()("TurnEnded", {}) {
  override get message(): string {
    return NO_TURN_REFUSAL;
  }
}

/** The call was matched, and its input cannot be acted on; the reason is for the bot. */
export class TurnToolRefused extends Schema.TaggedError<TurnToolRefused>()("TurnToolRefused", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * The session's events could not be brought up to date (the engine cannot be
 * reached), so the call was neither matched nor refused. Nothing was recorded:
 * the bridge forwards it again, under the same request id, until its deadline.
 */
export class TurnToolRetry extends Schema.TaggedError<TurnToolRetry>()("TurnToolRetry", {}) {}

/** One call to a turn tool: who made it, under which id, and its arguments. */
export type TurnToolCall = {
  [N in TurnToolName]: {
    readonly tool: N;
    readonly requestId: string;
    readonly caller: BotSession;
    /** Decoded with the tool's schema. */
    readonly input: ToolInput<N>;
    /** As the bridge received them: what the engine's record of the call is digested from. */
    readonly arguments: Schema.Json;
  };
}[TurnToolName];

/**
 * Where the tools that act for a turn go: `say` and `ask` deliver to the
 * turn's audience, `message_bot` wakes or holds for a teammate, and
 * `set_routine` changes a routine on the bot's behalf. Each call is first
 * matched to the engine's record of it in the session's admitted turn
 * (`docs/architecture/server.md`, Bot tools). The layer is the turn
 * machinery's (`turns/Speech.ts`).
 */
export class TurnTools extends Context.Service<
  TurnTools,
  {
    readonly call: (
      call: TurnToolCall,
    ) => Effect.Effect<Schema.Json, TurnEnded | TurnToolRefused | TurnToolRetry | Conflict>;
  }
>()("@j3-bots/server/tools/TurnTools") {}
