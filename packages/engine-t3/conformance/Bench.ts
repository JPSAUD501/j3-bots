// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModelChoice } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { IdempotencyKey, SessionId, TurnId } from "../src/ids.ts";

// The conformance suite runs the same scenarios against every `Engine`: the
// real adapter over the pinned engine, and the in-memory TestEngine. A bench
// plays what lies beyond the interface: the agent working in a turn, and the
// engine's other clients.

/** What the agent does in a turn. */
export type Act =
  /** Replies and ends the turn. */
  | { readonly _tag: "reply" }
  /** Keeps working until the turn is stopped. */
  | { readonly _tag: "work" }
  /** Asks permission to change a file, then ends the turn. */
  | { readonly _tag: "approval" }
  /** Asks one multiple-choice question, then ends the turn. */
  | { readonly _tag: "question" }
  /** Speaks to the user through the engine's own tool, then ends the turn. */
  | { readonly _tag: "speak"; readonly text: string }
  /** Asks the operator for a secret, as the one field named `field` when given, then ends the turn. */
  | { readonly _tag: "secret"; readonly field?: string }
  /**
   * Hands a short task to a delegated agent of the engine's own, then ends
   * the turn. The task's completion wakes the session with a new turn.
   */
  | { readonly _tag: "delegate" };

export class Bench extends Context.Service<
  Bench,
  {
    readonly workspacePath: string;
    readonly model: ModelChoice;
    /** A key no earlier run of the suite used against the same engine. */
    readonly key: (name: string) => IdempotencyKey;
    /** The text that makes the agent perform `act` in the turn it starts or steers. */
    readonly prompt: (act: Act) => string;
    /**
     * Has the agent perform `act` in a turn that started on `prompt(act)`. The
     * real agent follows its prompt on its own; the double is driven here.
     */
    readonly perform: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly act: Act;
    }) => Effect.Effect<void>;
    /** The agent reads the steers sent to its running turn. The real agent reads them at once. */
    readonly readSteers: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void>;
    /** Another client of the engine starts a turn in the session: work nobody in J3 Bots dispatched. */
    readonly startForeignTurn: (sessionId: SessionId) => Effect.Effect<void>;
  }
>()("@j3-bots/engine-t3/conformance/Bench") {}
