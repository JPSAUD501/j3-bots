import type {
  ApprovalDecision,
  EngineStatus,
  ModelChoice,
  PermissionMode,
  QuestionAnswers,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type {
  EngineDown,
  EngineIncompatible,
  ModelUnavailable,
  ProjectNotFound,
  RequestClosed,
  SessionBusy,
  SessionNotFound,
  TurnNotRunning,
} from "./errors.ts";
import type { SessionEvent, TurnOutcome } from "./events.ts";
import type {
  EngineProjectId,
  EventCursor,
  IdempotencyKey,
  RequestId,
  SessionId,
  TurnId,
} from "./ids.ts";

/** How a dispatched message reaches a session. */
export type Delivery =
  /**
   * Start a turn now. Fails with `SessionBusy` if a turn is running or queued:
   * use it where a busy session means something went wrong, such as a fresh
   * side session for a routine run.
   */
  | { readonly _tag: "start" }
  /**
   * Add the message to the running turn `turnId`, so it can change course. Fails
   * with `TurnNotRunning` if that turn has ended; nothing is sent, and the
   * caller decides again.
   */
  | { readonly _tag: "steer"; readonly turnId: TurnId }
  /**
   * Run as its own turn after the running turn, at the front or the back of the
   * session's queue. Starts at once if the session is idle.
   */
  | { readonly _tag: "queue"; readonly position: "front" | "back" };

/** What `dispatch` did. The same key always returns the same receipt. */
export type DispatchReceipt =
  | { readonly _tag: "started"; readonly turnId: TurnId }
  | { readonly _tag: "steered"; readonly turnId: TurnId }
  | { readonly _tag: "queued" };

/** Where a dispatch is now, for reconciling after a restart or a gap in events. */
export type DispatchStatus =
  /** The engine never applied this key: dispatching it again is safe. */
  | { readonly _tag: "unknown" }
  | { readonly _tag: "queued" }
  | { readonly _tag: "running"; readonly turnId: TurnId }
  /** It joined `turnId`, whose outcome is its outcome. */
  | { readonly _tag: "steered"; readonly turnId: TurnId }
  | { readonly _tag: "finished"; readonly turnId: TurnId; readonly outcome: TurnOutcome }
  /** It was queued and will never run. */
  | { readonly _tag: "cancelled" };

export type RequestResponse =
  | { readonly _tag: "approval"; readonly decision: ApprovalDecision }
  | { readonly _tag: "question"; readonly answers: QuestionAnswers }
  /** The operator dismissed the question; the bot reads it as "no". */
  | { readonly _tag: "dismiss" };

/**
 * What the adapter's layer is built from. The layer owns the engine process for
 * its whole lifetime: it starts the pinned engine binary on loopback with its
 * own data directory, restarts it when it exits, mints its credentials and
 * keeps one connection open, reconnecting on its own.
 */
export interface EngineOptions {
  /** The engine's data directory, `<J3_HOME>/engine`. Created if missing. */
  readonly home: string;
  /** The pinned engine executable. */
  readonly binaryPath: string;
  /** Loopback port the engine listens on. */
  readonly port: number;
  /**
   * The process each harness starts as the `j3` MCP server in every session,
   * for the bot tools.
   */
  readonly toolBridge: { readonly command: string; readonly args: ReadonlyArray<string> };
  /**
   * The bot's system prompt file, relative to its workspace folder. Every
   * session reads it when its provider process starts, so a change reaches the
   * bot when the session next starts its provider.
   */
  readonly systemPromptFile: string;
}

/**
 * The engine, in J3 Bots terms: projects for bot workspaces, sessions for
 * working context, turns that run in them, and the requests a turn holds on.
 *
 * Contract for every method:
 * - It fails with `EngineDown` when the engine is not reachable or not the
 *   pinned version, and then has applied nothing.
 * - Methods that take a `key` apply it once. Calling again with the same key
 *   returns the first result, even across engine and server restarts.
 * - Methods without a key are idempotent by nature.
 * - It never returns engine identifiers other than the opaque ids in `ids.ts`.
 */
export class Engine extends Context.Service<
  Engine,
  {
    /**
     * The engine's health and its providers, starting with the current value
     * and then on every change. Never fails: an unreachable engine is a state.
     */
    readonly status: Stream.Stream<EngineStatus>;

    /**
     * A link that opens the engine's own web interface, signed in, for setting
     * up providers until J3 Bots has its own screen. Short-lived.
     */
    readonly consoleLink: Effect.Effect<string, EngineDown>;

    /**
     * The project for a workspace folder, created if missing. Looked up by
     * path, so calling it again returns the same project.
     */
    readonly ensureProject: (input: {
      readonly workspacePath: string;
      readonly title: string;
    }) => Effect.Effect<EngineProjectId, EngineDown>;

    /**
     * Removes the project and every session in it, stopping what runs there.
     * The workspace folder is left alone. Succeeds if the project is already gone.
     */
    readonly removeProject: (projectId: EngineProjectId) => Effect.Effect<void, EngineDown>;

    /** A new, idle session in the project. */
    readonly openSession: (input: {
      readonly key: IdempotencyKey;
      readonly projectId: EngineProjectId;
      readonly title: string;
      readonly model: ModelChoice;
      readonly permissionMode: PermissionMode;
    }) => Effect.Effect<SessionId, EngineDown | ProjectNotFound | ModelUnavailable>;

    /** Changes the model or permission mode of a session, from its next turn. */
    readonly configureSession: (input: {
      readonly sessionId: SessionId;
      readonly model?: ModelChoice;
      readonly permissionMode?: PermissionMode;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | ModelUnavailable>;

    /**
     * Takes a replaced session out of use: stops what runs in it and archives
     * it. Its history stays in the engine. Succeeds if it is already retired.
     */
    readonly retireSession: (sessionId: SessionId) => Effect.Effect<void, EngineDown>;

    /**
     * Sends a message into a session. The text is exactly what the model
     * receives, as if the user typed it: the wake envelope is the caller's.
     *
     * `freshContext` starts the turn in a new provider conversation with none
     * of the session's earlier context, for a fresh start or a session rebuilt
     * from memory. It cannot steer.
     *
     * Dispatching never releases a queue the engine put on hold (after a
     * restart, a stop, a provider error or a usage limit): the adapter resumes
     * held queues itself when it reconnects.
     */
    readonly dispatch: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
      readonly text: string;
      readonly delivery: Delivery;
      readonly freshContext: boolean;
    }) => Effect.Effect<
      DispatchReceipt,
      EngineDown | SessionNotFound | SessionBusy | TurnNotRunning
    >;

    /** Where a dispatch stands now. */
    readonly lookupDispatch: (input: {
      readonly sessionId: SessionId;
      readonly key: IdempotencyKey;
    }) => Effect.Effect<DispatchStatus, EngineDown | SessionNotFound>;

    /**
     * Ends a running turn, as when a bot has delivered its answer. Background
     * work it started keeps running. Queued dispatches then start in order. Does
     * nothing if the turn has already ended.
     */
    readonly interrupt: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;

    /**
     * The operator's "Stop": ends the running turn and its background work, and
     * cancels every queued dispatch, which it returns. Does nothing to an idle
     * session.
     */
    readonly stop: (
      sessionId: SessionId,
    ) => Effect.Effect<
      { readonly cancelled: ReadonlyArray<IdempotencyKey> },
      EngineDown | SessionNotFound
    >;

    /** Answers an approval or a question, which lets its turn continue. */
    readonly respond: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly response: RequestResponse;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | RequestClosed>;

    /**
     * The session's events, starting with a `snapshot`. With `after`, events
     * after that cursor follow the snapshot, or the snapshot alone if the engine
     * can no longer replay from there.
     *
     * The stream survives engine restarts and dropped connections: the adapter
     * reconnects and resumes, and emits a new `snapshot` when it cannot replay
     * what it missed. Within one stream no event is delivered twice. It fails
     * only when the session no longer exists or the engine turns out not to be
     * the pinned version.
     */
    readonly events: (input: {
      readonly sessionId: SessionId;
      readonly after: EventCursor | null;
    }) => Stream.Stream<SessionEvent, SessionNotFound | EngineIncompatible>;
  }
>()("@j3-bots/engine-t3/Engine") {}
