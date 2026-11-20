// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  AttachmentId,
  EngineStatus,
  ModelChoice,
  PermissionMode,
  ProviderId,
  QuestionAnswers,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import type {
  EngineDown,
  EngineIncompatible,
  ModelUnavailable,
  ProjectNotFound,
  RequestClosed,
  SessionBusy,
  SessionNotFound,
} from "./errors.ts";
import type { SessionEvent } from "./events.ts";
import type {
  EngineProjectId,
  EventCursor,
  IdempotencyKey,
  RequestId,
  SessionId,
  TurnId,
} from "./ids.ts";

/**
 * How a dispatched message reaches a session. J3 Bots keeps its own queue and
 * dispatches only into an idle session, with one exception: an operator message
 * may steer a turn the operator opened.
 */
export type Delivery =
  /**
   * Start a turn. Fails with `SessionBusy` if a turn is running or waiting to
   * start, and then sends nothing.
   *
   * `freshContext` starts it in a new provider conversation with none of the
   * session's earlier context, for a fresh start or a session rebuilt from
   * memory.
   */
  | { readonly _tag: "start"; readonly freshContext: boolean }
  /**
   * Add the message to the running turn `turnId`, so it can change course. If
   * that turn is ending or cannot take it, the engine makes the message a turn
   * of its own instead: see `DispatchDisposition`.
   */
  | { readonly _tag: "steer"; readonly turnId: TurnId };

/**
 * What the engine did with a dispatch. The same key always returns the same
 * disposition.
 */
export type DispatchDisposition =
  /** A `start` began turn `turnId`. */
  | { readonly _tag: "started"; readonly turnId: TurnId }
  /** A `steer` joined turn `turnId`, whose outcome is its outcome. */
  | { readonly _tag: "steered"; readonly turnId: TurnId }
  /**
   * A `steer` became turn `turnId` of its own: the target turn was already
   * ending, or its provider cannot steer. It starts at once if the session is
   * idle, or after the running turn otherwise. **Read** at `db51b67`.
   */
  | { readonly _tag: "new-turn"; readonly turnId: TurnId };

/** Whether the engine applied a dispatch key, for reconciling after a crash. */
export type DispatchLookup =
  | { readonly _tag: "applied"; readonly disposition: DispatchDisposition }
  /**
   * The engine has the session and positively has no record of the key: sending
   * it again cannot apply it twice.
   */
  | { readonly _tag: "not-applied" }
  /**
   * The engine cannot tell: the session is gone. The dispatch must not be sent
   * into another session on this answer alone.
   */
  | { readonly _tag: "unknown" };

/** A file the message carries. The adapter uploads it to the engine. */
export interface DispatchAttachment {
  /** J3 Bots' id; the engine's own id for the upload is derived from it. */
  readonly id: AttachmentId;
  readonly name: string;
  readonly mediaType: string;
  /** Where the bytes are on disk. */
  readonly path: string;
}

export type RequestResponse =
  | { readonly _tag: "approval"; readonly decision: ApprovalDecision }
  | { readonly _tag: "question"; readonly answers: QuestionAnswers }
  /** The operator dismissed the question; the bot reads it as "no". */
  | { readonly _tag: "dismiss" };

export type SecretAnswer =
  | { readonly _tag: "provide"; readonly value: Redacted.Redacted<string> }
  | { readonly _tag: "decline" };

/** One harness the engine runs bots on. */
export interface ProviderInstance {
  /** J3 Bots' id for it, which `ModelChoice.providerId` names. */
  readonly id: ProviderId;
  readonly harness: "claude-code" | "codex";
  /** As the operator sees it, such as "Claude (work account)". */
  readonly name: string;
  /**
   * The harness's own configuration folder, owned by J3 Bots, so bots do not
   * inherit the operator's personal setup. The adapter writes the `j3` tool
   * server and J3 Bots' launch settings into it, merging with what the harness
   * keeps there.
   */
  readonly home: string;
  /** Extra environment for the harness, such as an API endpoint and its key. Stored as secrets. */
  readonly environment: ReadonlyArray<{
    readonly name: string;
    readonly value: Redacted.Redacted<string>;
  }>;
}

/**
 * What the adapter's layer is built from: everything the server knows. The
 * layer owns the engine for its whole lifetime. It installs the pinned release
 * (checked against its published checksums) unless `binaryOverride` is set,
 * provisions the engine's settings and the provider instances, starts the
 * engine on loopback with its own data directory, restarts it when it exits,
 * mints its credentials and keeps one connection open, reconnecting on its own.
 */
export interface EngineOptions {
  /** The engine's data directory, `<J3_HOME>/engine`. Created if missing. */
  readonly home: string;
  /** Loopback port the engine listens on. */
  readonly port: number;
  /** An engine executable to run instead of the pinned release, for development. */
  readonly binaryOverride: Option.Option<string>;
  /** The harness instances to create. Changing the list applies to sessions started after. */
  readonly providers: ReadonlyArray<ProviderInstance>;
  /**
   * The process each harness starts as the `j3` MCP server in every session, for
   * the bot tools: the server's stdio bridge.
   */
  readonly toolBridge: { readonly command: string; readonly args: ReadonlyArray<string> };
  /**
   * The bot's system prompt file, relative to its workspace folder: `.j3/system.md`.
   * A session reads it when its provider process starts, so a change reaches the
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
 *
 * `@j3-bots/engine-t3/testing` has an in-memory implementation that keeps this
 * contract, for testing the server without an engine.
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

    /**
     * A new, idle session in the project. `key` is the server's own id for the
     * session, written before this call, so a retry returns the same session.
     */
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
     * it. Its history stays in the engine, so `lookupDispatch` still answers for
     * it. Succeeds if it is already retired.
     */
    readonly retireSession: (sessionId: SessionId) => Effect.Effect<void, EngineDown>;

    /**
     * Sends a message into a session. The text is exactly what the model
     * receives, as if the user typed it: the wake envelope is the caller's, and
     * the caller stores it before this call so a retry sends the same text.
     */
    readonly dispatch: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
      readonly text: string;
      readonly attachments: ReadonlyArray<DispatchAttachment>;
      readonly delivery: Delivery;
    }) => Effect.Effect<DispatchDisposition, EngineDown | SessionNotFound | SessionBusy>;

    /** Whether the engine applied a dispatch key to the session. */
    readonly lookupDispatch: (input: {
      readonly sessionId: SessionId;
      readonly key: IdempotencyKey;
    }) => Effect.Effect<DispatchLookup, EngineDown>;

    /**
     * Ends a running turn. Background work it started keeps running and may
     * wake the session later. Does nothing if the turn has already ended.
     *
     * The server does not use it to end a turn after the bot's answer: at the
     * pin, an interrupted run can lose the delivery of a delegated task's
     * completion. It is for turns the server must end, such as a rotation.
     */
    readonly interrupt: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;

    /**
     * The operator's "Stop": ends the running turn and its background work, and
     * any turn waiting to start. Open requests expire. Does nothing to an idle
     * session. Wakes J3 Bots holds for the bot are the server's to cancel.
     */
    readonly stop: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;

    /** Answers an approval or a question, which lets its turn continue. */
    readonly respond: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly response: RequestResponse;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | RequestClosed>;

    /**
     * Answers a secret request. The value goes to the engine's secret store and
     * reaches the command that asked, never the model. Applied once by nature:
     * the request closes, and answering again fails with `RequestClosed`.
     */
    readonly respondSecret: (input: {
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly answer: SecretAnswer;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | RequestClosed>;

    /**
     * The session's events. With `after`, either every event after that cursor,
     * in order, or a single `replaced` when the engine can no longer replay
     * from there; never both. With `after: null`, a `replaced` first: use it only
     * for a session nothing has been dispatched to yet, and store its cursor
     * before the first dispatch.
     *
     * The stream survives engine restarts and dropped connections: the adapter
     * reconnects and resumes the same way, so within one stream no event is
     * delivered twice and none is skipped without a `replaced` covering it. It
     * fails only when the session no longer exists or the engine turns out not
     * to be the pinned version.
     */
    readonly events: (input: {
      readonly sessionId: SessionId;
      readonly after: EventCursor | null;
    }) => Stream.Stream<SessionEvent, SessionNotFound | EngineIncompatible>;
  }
>()("@j3-bots/engine-t3/Engine") {}
