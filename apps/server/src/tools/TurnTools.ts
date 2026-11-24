// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Conflict } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { NO_TURN_REFUSAL, type ToolInput } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { MadeBy } from "../bots/Bots.ts";
import type { BotSession } from "../bots/EngineSessions.ts";

/** The tools whose effect belongs to the turn that called them. */
const TurnToolName = Schema.Literals([
  "say",
  "ask",
  "request_browser_help",
  "message_bot",
  "set_routine",
  "set_operator_name",
  "request_credential",
  "suggest_connector",
  "start_room",
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
 * A `create_bot` call. The bot is made by `create`, which the caller gives,
 * since only it holds the bots: the turn's machinery hands it the turn and a
 * claim to run where the bot is saved, which pins the call and counts it
 * toward the turn's cap.
 */
export interface CreateBotCall {
  readonly requestId: string;
  readonly caller: BotSession;
  /** As the bridge received them: what the engine's record of the call is digested from. */
  readonly arguments: Schema.Json;
  readonly create: (
    madeBy: MadeBy<TurnEnded | TurnToolRefused>,
  ) => Effect.Effect<BotId, TurnEnded | TurnToolRefused>;
}

/**
 * A connector call whose request was claimed for its turn before, and which
 * has no answer to give again: the server stopped while it ran, or its answer
 * was lost. Whether it took effect at the connector is not known.
 */
export class CallCutOff extends Schema.TaggedError<CallCutOff>()("CallCutOff", {}) {
  override get message(): string {
    return "J3 Bots lost track of this call while it ran, so it may or may not have taken effect. Check before you make it again.";
  }
}

/** A connector tool's call to claim for its turn: who made it, under which id, and its arguments. */
export interface ClaimedCall {
  /** The tool's name in the `j3` namespace, `<connector>__<tool>`. */
  readonly tool: string;
  readonly requestId: string;
  readonly caller: BotSession;
  /** As the bridge received them: what the engine's record of the call is digested from. */
  readonly arguments: Schema.Json;
}

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
 * turn's audience, `request_browser_help` asks the operator to do a step in
 * the bot's browser, `message_bot` wakes or holds for a teammate,
 * `set_routine` changes a routine on the bot's behalf, and
 * `set_operator_name` saves what the operator asked to be called, only in a
 * turn they spoke in, `request_credential` shows a save-login card in the
 * bot's conversation, `suggest_connector` a connector card there, and
 * `create_bot` and `start_room` build a team in a room, only in a turn the
 * operator spoke in. Each call is first
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
     * `create_bot`: matched and pinned as the other turn tools are, in the
     * transaction that saves the bot, so a turn makes at most
     * `MAX_BOTS_PER_TURN` and `start_room` finds the bots it made.
     */
    readonly createBot: (
      call: CreateBotCall,
    ) => Effect.Effect<Schema.Json, TurnEnded | TurnToolRefused | TurnToolRetry | Conflict>;
    /**
     * Pins a fill to the engine's record of its call in the caller's running
     * admitted turn, as `call` pins the other tools, but in a transaction of
     * its own: a fill holds a browser tab for seconds, so it runs after the
     * pin, and its answer is stored with `settleFill`. A request without such a
     * call, as one that names a session it was not made from, fails with
     * `TurnEnded`.
     */
    readonly claimFill: (
      call: FillCall,
    ) => Effect.Effect<FillClaim, TurnEnded | TurnToolRefused | TurnToolRetry | Conflict>;
    /** Stores a claimed fill's answer, which a forward retried under its id then gets. */
    readonly settleFill: (call: FillCall, result: Schema.Json) => Effect.Effect<void>;
    /**
     * Matches a connector tool's call to the engine's record of it in the
     * session's running admitted turn, as the turn tools are, and claims that
     * record for the request, committed before it returns, so the call is
     * made at the connector once. What the connector answers is not kept: a
     * request claimed before fails with `CallCutOff`.
     */
    readonly claimConnectorCall: (
      call: ClaimedCall,
    ) => Effect.Effect<void, TurnEnded | TurnToolRetry | CallCutOff>;
  }
>()("@j3-bots/server/tools/TurnTools") {}
