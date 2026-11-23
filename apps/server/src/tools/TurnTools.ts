// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Conflict } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { NO_TURN_REFUSAL, type ToolInput } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BotSession } from "../bots/EngineSessions.ts";

/** The tools whose effect belongs to the turn that called them. */
const TurnToolName = Schema.Literals([
  "say",
  "ask",
  "message_bot",
  "set_routine",
  "set_operator_name",
  "request_credential",
]);
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
 * A `fill_credential` call, claimed for its turn before the fill runs
 * (`vault/Fill.ts`).
 */
export interface FillCall {
  readonly tool: "fill_credential";
  readonly requestId: string;
  readonly caller: BotSession;
  /** As the bridge received them: what the engine's record of the call is digested from. */
  readonly arguments: Schema.Json;
}

/**
 * A fill's claim: matched to the engine's record of its call and pinned to
 * that turn, or a forward of the same request that already has its answer.
 */
export type FillClaim =
  | {
      readonly _tag: "claimed";
      readonly turnId: TurnId;
      /** Whether the call is still open in the session's running admitted turn: not stopped, not ended. */
      readonly stillOpen: Effect.Effect<boolean>;
    }
  | { readonly _tag: "stored"; readonly result: Schema.Json };

/**
 * Where the tools that act for a turn go: `say` and `ask` deliver to the
 * turn's audience, `message_bot` wakes or holds for a teammate,
 * `set_routine` changes a routine on the bot's behalf, and
 * `set_operator_name` saves what the operator asked to be called, only in a
 * turn they spoke in, and `request_credential` shows a save-login card in the
 * bot's conversation. Each call is first
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
    /**
     * Pins a fill to the engine's record of its call in the caller's running
     * admitted turn, as `call` pins the other tools, but in a transaction of
     * its own: a fill holds a browser tab for seconds, so it runs after the
     * pin, and its answer is stored with `settle`. A request without such a
     * call, as one that names a session it was not made from, fails with
     * `TurnEnded`.
     */
    readonly claim: (
      call: FillCall,
    ) => Effect.Effect<FillClaim, TurnEnded | TurnToolRefused | TurnToolRetry | Conflict>;
    /** Stores a claimed fill's answer, which a forward retried under its id then gets. */
    readonly settle: (call: FillCall, result: Schema.Json) => Effect.Effect<void>;
  }
>()("@j3-bots/server/tools/TurnTools") {}
