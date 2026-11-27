// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  CommandId,
  type CommandError,
  type ConnectorCommandError,
  type EntryId,
  type RoomId,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import type { NotPaired } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";

/** Why an intent did not take effect. */
export type IntentFailure =
  /** The server refused the command: `NotFound`, `Conflict` or `Invalid`, with its reason. */
  | { readonly _tag: "refused"; readonly error: CommandError }
  /** The device is not paired, so the command never reached the server. */
  | { readonly _tag: "not-paired" }
  /** The server failed unexpectedly. Its cause is in the server's log. */
  | { readonly _tag: "unexpected" };

export type IntentResult<A = void, F = IntentFailure> =
  | { readonly _tag: "done"; readonly value: A }
  | { readonly _tag: "failed"; readonly failure: F };

/** A connector command's refusal over a secret its settings name (`SecretRefused`). */
type SecretRefused = Extract<ConnectorCommandError, { readonly _tag: "SecretRefused" }>;

/**
 * Why a connector intent that sets what a connector sends, or which bots it
 * goes to, did not take effect: any intent's reasons, or a secret its
 * settings name that those bots cannot use.
 */
export type ConnectorIntentFailure =
  | IntentFailure
  | { readonly _tag: "secret-refused"; readonly error: SecretRefused };

/** A reason the server gives when it refuses a command as it stands (`Conflict`, `Invalid`). */
export type RefusalReason = Extract<CommandError, { readonly reason: string }>["reason"];

/** Whether the server refused the command for `reason`. */
export const refusedWith = (
  outcome: IntentResult<unknown, ConnectorIntentFailure> | ConnectorIntentFailure | null,
  reason: RefusalReason,
): boolean => {
  const failure = outcome?._tag === "failed" ? outcome.failure : outcome;
  return (
    failure?._tag === "refused" &&
    failure.error._tag !== "NotFound" &&
    failure.error.reason === reason
  );
};

/** The secret the server refused a connector command over, if it did. */
export const secretRefusal = (
  outcome: IntentResult<unknown, ConnectorIntentFailure> | ConnectorIntentFailure | null,
): SecretRefused | null => {
  const failure = outcome?._tag === "failed" ? outcome.failure : outcome;
  return failure?._tag === "secret-refused" ? failure.error : null;
};

/** The result of running a connector command that may be refused over a secret. */
export const connectorIntentResult = <A>(
  exit: Exit.Exit<A, ConnectorCommandError | NotPaired>,
): IntentResult<A, ConnectorIntentFailure> => {
  if (Exit.isSuccess(exit)) return { _tag: "done", value: exit.value };
  const error = Cause.findErrorOption(exit.cause);
  if (error._tag === "None") return { _tag: "failed", failure: { _tag: "unexpected" } };
  const value = error.value;
  switch (value._tag) {
    case "NotPaired":
      return { _tag: "failed", failure: { _tag: "not-paired" } };
    case "SecretRefused":
      return { _tag: "failed", failure: { _tag: "secret-refused", error: value } };
    default:
      return { _tag: "failed", failure: { _tag: "refused", error: value } };
  }
};

/** Why a command failed, for a UI that shows outcomes rather than causes. */
export const intentFailure = (cause: Cause.Cause<CommandError | NotPaired>): IntentFailure => {
  const error = Cause.findErrorOption(cause);
  if (error._tag === "None") return { _tag: "unexpected" };
  return error.value._tag === "NotPaired"
    ? { _tag: "not-paired" }
    : { _tag: "refused", error: error.value };
};

/** The result of running a command, for a UI that shows outcomes rather than causes. */
export const intentResult = <A>(exit: Exit.Exit<A, CommandError | NotPaired>): IntentResult<A> =>
  Exit.isSuccess(exit)
    ? { _tag: "done", value: exit.value }
    : { _tag: "failed", failure: intentFailure(exit.cause) };

/**
 * Where an action on one object stands, so the UI can disable what would
 * repeat it. `submitted`: the server accepted it, and the object has not
 * changed since; it ends when a newer copy of the entry arrives.
 */
export type ActionState =
  | { readonly _tag: "submitting" }
  | { readonly _tag: "submitted" }
  | { readonly _tag: "failed"; readonly failure: IntentFailure };

/** Every action on one card shares a key: answering and dismissing exclude each other. */
export const cardAction = (entryId: EntryId) => `card:${entryId}`;
/** Retrying a failed message or a failed turn. */
export const retryAction = (entryId: EntryId) => `retry:${entryId}`;
/** Setting or taking off the operator's reaction on a message. */
export const reactAction = (entryId: EntryId) => `react:${entryId}`;
export const stopAction = (botId: BotId) => `stop:${botId}`;
/** Stopping the work addressed to a room. */
export const roomStopAction = (roomId: RoomId) => `room-stop:${roomId}`;

interface Running {
  readonly result: Deferred.Deferred<IntentResult>;
  /** The entry the action is about, when a newer copy of it ends `submitted`. */
  readonly entryId: EntryId | null;
  changed: boolean;
}

/**
 * Actions on cards, messages and bots that must not be sent twice. While one
 * runs, starting it again joins it; once the server accepted it, starting it
 * again does nothing until the entry it changed has arrived anew.
 */
export class Actions extends Context.Service<
  Actions,
  {
    readonly state: Readable<ReadonlyMap<string, ActionState>>;
    /** A new id for one command, reused for every retry of that command. */
    readonly commandId: Effect.Effect<CommandId>;
    /**
     * Runs `command` under `key` unless an action with that key is running or
     * was accepted. `command` runs in the client's scope, so it completes even
     * if the caller stops waiting.
     */
    readonly run: (
      key: string,
      entryId: EntryId | null,
      command: Effect.Effect<void, CommandError | NotPaired>,
    ) => Effect.Effect<IntentResult>;
    /** A newer copy of the entry arrived. */
    readonly entryChanged: (entryId: EntryId) => void;
  }
>()("@j3-bots/client-runtime/intents/Actions") {}

export const layer = Layer.effect(
  Actions,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const scope = yield* Scope.Scope;
    const state = new Cell<ReadonlyMap<string, ActionState>>(new Map());
    const running = new Map<string, Running>();
    // Keys in `submitted`, with the entry whose next copy ends them.
    const held = new Map<string, EntryId>();

    const put = (key: string, next: ActionState | null) =>
      state.update((current) => {
        const copy = new Map(current);
        if (next === null) copy.delete(key);
        else copy.set(key, next);
        return copy;
      });

    const run = Effect.fn("Actions.run")(function* (
      key: string,
      entryId: EntryId | null,
      command: Effect.Effect<void, CommandError | NotPaired>,
    ) {
      const current = running.get(key);
      if (current !== undefined) return yield* Deferred.await(current.result);
      if (held.has(key)) return { _tag: "done", value: undefined } as const;

      const entry: Running = {
        result: yield* Deferred.make<IntentResult>(),
        entryId,
        changed: false,
      };
      running.set(key, entry);
      put(key, { _tag: "submitting" });
      const settle = Effect.fnUntraced(function* (exit: Exit.Exit<void, CommandError | NotPaired>) {
        const result = intentResult(exit);
        running.delete(key);
        if (result._tag === "failed") {
          put(key, { _tag: "failed", failure: result.failure });
        } else if (entry.entryId !== null && !entry.changed) {
          held.set(key, entry.entryId);
          put(key, { _tag: "submitted" });
        } else {
          put(key, null);
        }
        yield* Deferred.succeed(entry.result, result);
      });
      yield* command.pipe(Effect.onExit(settle), Effect.forkIn(scope));
      return yield* Deferred.await(entry.result);
    });

    const entryChanged = (entryId: EntryId) => {
      for (const action of running.values()) {
        if (action.entryId === entryId) action.changed = true;
      }
      for (const [key, heldFor] of held) {
        if (heldFor !== entryId) continue;
        held.delete(key);
        put(key, null);
      }
    };

    const commandId = random
      .randomBytes(16)
      .pipe(Effect.map((bytes) => CommandId.make(Base64Url.encode(bytes))));

    return Actions.of({ state, commandId, run, entryChanged });
  }),
);
