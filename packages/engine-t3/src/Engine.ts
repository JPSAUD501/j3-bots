// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  EngineStatus,
  ModelChoice,
  PermissionMode,
  ProviderId,
  QuestionAnswers,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import type {
  DispatchRejected,
  EngineDown,
  EngineIncompatible,
  ModelUnavailable,
  ProjectNotFound,
  RequestClosed,
  SessionBusy,
  SessionNotFound,
  StopRejected,
} from "./errors.ts";
import type { SessionEvent } from "./events.ts";
import type {
  EngineAttachmentId,
  EngineProjectId,
  EventCursor,
  IdempotencyKey,
  RequestId,
  SessionId,
  SyncToken,
  TurnId,
} from "./ids.ts";

/**
 * How a dispatched message reaches a session. J3 Bots keeps its own queue and
 * dispatches into an idle session, with one exception: an operator message may
 * steer a turn opened for the same audience.
 */
export type Delivery =
  /**
   * Start a turn. A first `dispatch` is refused with `SessionBusy`, sending
   * nothing, when the adapter already sees a turn running or waiting in the
   * session. That check is best effort: the engine queues a start that reaches
   * it behind an active turn, including one the engine started itself, and the
   * dispatch is then `queued`.
   *
   * `freshContext` starts it in a new provider conversation with none of the
   * session's earlier context, for a fresh start or a session rebuilt from
   * memory.
   */
  | { readonly _tag: "start"; readonly freshContext: boolean }
  /**
   * Add the message to the running turn `turnId`, so it can change course. If
   * that turn has completed or is completing, or its provider can take no steer
   * at all, the engine makes the message a turn of its own instead: see
   * `DispatchDisposition`. It refuses (`DispatchRejected`) a steer into a turn
   * that waits behind another, or that ended any way but completing. **Read**
   * at `db51b67`, `resolveMessageDispatchIntent` and `dispatchSteerIntoRun`.
   */
  | { readonly _tag: "steer"; readonly turnId: TurnId };

/**
 * How the engine accepted a first `dispatch`. It records acceptance only:
 * delivery is the `turn-started` event whose cause is `dispatch` with the
 * dispatch's key, or, for `steered`, the `steered` event. A `redispatch` has
 * no disposition: the engine's reply to a resend is `{sequence}` whether or not
 * it applied the key just then.
 */
export type DispatchDisposition =
  /** A `start` began turn `turnId`. */
  | { readonly _tag: "started"; readonly turnId: TurnId }
  /**
   * A `start` became turn `turnId`, which waits behind a turn that began before
   * the engine applied the start. It is delivered when `turnId` starts, and
   * never if `stop` cancels it first. **Read** at `db51b67`.
   */
  | { readonly _tag: "queued"; readonly turnId: TurnId }
  /**
   * A `steer` was taken for turn `turnId`. How it settles is decided when that
   * turn ends, from the engine's own record of the steer, and reported then:
   * `steered`, `steer-dropped` or `steer-requeued` (see those events).
   *
   * The same holds when the engine cannot steer `turnId` at once: the turn has
   * not started its provider turn yet (the engine keeps the message aside and
   * steers it in when the turn starts, or runs it as the follow-up turn if the
   * turn ends first), or its provider steers only by interrupting the turn and
   * restarting it with the message, which keeps `turnId` (one turn, several
   * attempts). **Read** at `db51b67`.
   */
  | { readonly _tag: "steered"; readonly turnId: TurnId }
  /**
   * A `steer` became turn `turnId` of its own: the target turn had completed or
   * was completing, or its provider can neither steer nor restart. It starts at once if
   * the session is idle, or after the running turn otherwise. **Read** at
   * `db51b67`.
   */
  | { readonly _tag: "new-turn"; readonly turnId: TurnId };

/** What the engine is given for one dispatch. */
export interface DispatchInput {
  readonly key: IdempotencyKey;
  readonly sessionId: SessionId;
  /**
   * Exactly what the model receives, as if the user typed it: the wake
   * envelope is the caller's, stored before the first send.
   */
  readonly text: string;
  /**
   * Checked first with `attachmentLimitViolation`. The staged ids are the one
   * part of the input that may change between sends of a key: a file whose
   * `usableUntil` has passed is staged again before any send, first or not,
   * because the engine claims the files before it looks at the key.
   */
  readonly attachments: ReadonlyArray<DispatchAttachment>;
  readonly delivery: Delivery;
}

/** A file the message carries, staged first with `Engine.stageAttachment`. */
export interface DispatchAttachment {
  readonly stagedId: EngineAttachmentId;
  readonly name: string;
  readonly mediaType: string;
  /** Bytes. */
  readonly size: number;
}

/** A file staged in the engine, ready to name in a dispatch. */
export interface StagedAttachment {
  readonly id: EngineAttachmentId;
  /**
   * Until when a dispatch can name it, first send or resend. The engine
   * removes an upload no message names after 24 hours, and a claimed one stays
   * as the source of copies until then (**Read** at `db51b67`,
   * `apps/server/src/attachmentStore.ts`); the adapter reports half of that.
   * Past it, stage the file again before the next send, first send or
   * recovery alike.
   */
  readonly usableUntil: DateTime.Utc;
}

export type RequestResponse =
  | { readonly _tag: "approval"; readonly decision: ApprovalDecision }
  | { readonly _tag: "question"; readonly answers: QuestionAnswers }
  /**
   * The operator dismissed the question; the bot reads it as "no". The only
   * answer to an `unsupported-question`.
   */
  | { readonly _tag: "dismiss" };

export type SecretAnswer =
  | { readonly _tag: "provide"; readonly value: Redacted.Redacted<string> }
  | { readonly _tag: "decline" };

/** One harness the engine runs bots on. */
export type ProviderInstance = {
  /** J3 Bots' id for it, which `ModelChoice.providerId` names. */
  readonly id: ProviderId;
  /** As the operator sees it, such as "Claude (work account)". */
  readonly name: string;
  /** Extra environment for the harness, such as an API endpoint and its key. Stored as secrets. */
  readonly environment: ReadonlyArray<{
    readonly name: string;
    readonly value: Redacted.Redacted<string>;
  }>;
} & (
  | {
      readonly harness: "claude-code" | "codex";
      /**
       * The harness's own configuration folder, owned by J3 Bots, so bots do
       * not inherit the operator's personal setup. The adapter writes the `j3`
       * tool server and J3 Bots' launch settings into it, merging with what the
       * harness keeps there.
       */
      readonly home: string;
    }
  | {
      /**
       * Any agent that speaks the Agent Client Protocol, started as a local
       * command: the scripted agent the conformance suite runs, which needs no
       * model and spends no allowance. It gets no J3 Bots prompt and no `j3`
       * tools; the engine passes it the message as it does every harness.
       */
      readonly harness: "acp-command";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }
);

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
  /**
   * The caller's containment check: whether `location`, links resolved, is
   * still private state the adapter may write. The adapter asks it for every
   * folder it writes in, at the moment it writes, and leaves alone one it
   * refuses. The folders under `home` it writes are `writtenFolders` (in
   * `@j3-bots/engine-t3/live`), for the caller to check at start too.
   */
  readonly isPrivate: (location: string) => Effect.Effect<boolean>;
}

/**
 * The engine, in J3 Bots terms: projects for bot workspaces, sessions for
 * working context, turns that run in them, and the requests a turn holds on.
 *
 * Contract for every method:
 * - It fails with `EngineDown` when the engine cannot answer. `EngineUnavailable`
 *   and `EngineIncompatible` mean nothing was sent. `EngineIndeterminate` means
 *   a command was sent and no reply settled it: it may have been applied, and
 *   never counts as "not applied". Once a call has sent a command, any later
 *   failure of the call is `EngineIndeterminate`, except `DispatchRejected`.
 * - Methods that take a `key` apply it once, even across engine and server
 *   restarts: calling again with the same key and input applies nothing new.
 *   After `EngineIndeterminate`, that is how the caller learns what happened;
 *   for a dispatch, the second call is `redispatch`.
 * - Methods without a key are idempotent by nature, except where noted.
 * - It never returns engine identifiers other than the opaque ids in `ids.ts`.
 *
 * The engine holds a session's queue of waiting turns after an engine restart,
 * a provider error, a model or provider change while the replaced provider
 * session still runs background work, and a Stop. Each time the queue becomes
 * held, the session's events carry one `queue-held`; the server answers it with
 * `resumeQueue`, through its per-session gate. The adapter never resumes a
 * queue on its own.
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
     * Takes a replaced session out of use, as a rotation does: stops what runs
     * in it as `stop` does and archives it. Its history stays in the engine.
     * Succeeds if it is already retired.
     */
    readonly retireSession: (sessionId: SessionId) => Effect.Effect<void, EngineDown>;

    /**
     * Sends a message into a session for the first time: the caller has never
     * sent this key. The result is acceptance only (see `DispatchDisposition`).
     *
     * - `SessionBusy`, `SessionNotFound`: the adapter refused it before
     *   sending anything. The key was never sent.
     * - `DispatchRejected`: the engine refused it and applied nothing.
     * - `EngineIndeterminate`: anything else, including an error the adapter
     *   cannot identify. Resolve it with `redispatch`, never with `dispatch`.
     *
     * Calling it twice with one key is a defect: once a send may have reached
     * the engine, every later send of the key is a `redispatch`.
     */
    readonly dispatch: (
      input: DispatchInput,
    ) => Effect.Effect<
      DispatchDisposition,
      EngineDown | SessionNotFound | SessionBusy | DispatchRejected
    >;

    /**
     * Sends a key again after a send whose answer was lost, with the same
     * text, files and delivery (staged ids may be fresh: see `DispatchInput`).
     * It skips every local check, the busy check included, since the turn
     * that makes the session busy may be this key's own: it always reaches
     * the engine with the same command id.
     *
     * Success means the engine holds the key as accepted. It says nothing of
     * how: the engine answers a resend with `{sequence}` whether it applied
     * the key now or earlier, so the events say where it went, as for any
     * dispatch. `DispatchRejected` means it was refused and nothing was
     * applied. `EngineIndeterminate` leaves it open, as before.
     */
    readonly redispatch: (
      input: DispatchInput,
    ) => Effect.Effect<void, EngineDown | DispatchRejected>;

    /**
     * Uploads a file for a later dispatch. The engine mints the id; the caller
     * stores it with the dispatch before dispatching, and stages the file again
     * whenever `usableUntil` has passed before a send of the dispatch, the
     * first send or a recovery. Not keyed: a retry after a lost reply stages a
     * second copy, which the engine removes unused.
     */
    readonly stageAttachment: (input: {
      readonly name: string;
      readonly mediaType: string;
      /** Bytes; the file at `path` must have exactly this size. */
      readonly size: number;
      /** Where the bytes are on disk. */
      readonly path: string;
    }) => Effect.Effect<StagedAttachment, EngineDown>;

    /**
     * The operator's Stop, for one session: the engine's own stop, which
     * interrupts the running turn and the background work the engine can
     * reach (delegated tasks, and pending work of a turn that already ended)
     * and holds the queue, then a cancel for each turn waiting in the engine's
     * queue. It also disarms a pending usage-limit continuation. The engine's
     * stop is always sent, also to a session with no running turn, since
     * background work can outlive its turn (**Read** at `db51b67`,
     * `Orchestrator.ts`, `dispatchThreadStop`).
     *
     * Success acknowledges the commands; it does not mean they took effect.
     * The engine interrupts a provider turn asynchronously (**Read** at
     * `db51b67`, `Orchestrator.ts`, `dispatchThreadStop`: the interrupt is an
     * effect run after the commit). The events say when they did: the running
     * turn's `turn-finished`, a `turn-finished` with `cancelled` for each
     * waiting turn, `steer-dropped` for each untaken steer,
     * `continuation-dropped` for a disarmed continuation, and a
     * `synchronized` with no `pending` background work and no
     * `runnableTurns` for the background work of a turn that had already
     * ended and for a turn the engine started or queued on its own. An
     * `undecidable` tool such a marker still shows was live when the engine
     * accepted the stop, which covered it, or started in a turn that began
     * after: a refusal with one live is never moot.
     *
     * A message the engine counts as a user's releases the hold Stop put on
     * the queue, so a dispatch sent between the stop and the cancels starts a
     * turn the cancels miss (**Read**, `sentByUserFromClient`). The caller
     * sends a session nothing while a Stop of it is unsettled.
     *
     * Every command is resolved by its key, as a dispatch is: an error reply
     * is answered by a resend of the same command, whose receipt says whether
     * the engine applied it. A refusal is moot, and counts as done, when
     * nothing it targets can still run, nor may: background work the
     * `synchronized` event would call `undecidable` keeps it from being moot.
     * Otherwise it is `StopRejected`, and
     * the key is spent. `EngineIndeterminate` is resolved by calling again
     * with the same key.
     *
     * `key` is derived from the Stop command, the session and the round, and
     * stored with the Stop's targets before this call. Wakes J3 Bots holds
     * for the bot are the server's to cancel.
     */
    readonly stop: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | StopRejected>;

    /**
     * Releases the session's held queue, in answer to the `queue-held` event
     * whose cursor is `hold`, which is also its key: a retry sends the same
     * command. If the engine holds the queue again in answer, as it does while
     * a replaced provider session still runs background work, the events
     * carry no new `queue-held` until that cause has passed.
     */
    readonly resumeQueue: (input: {
      readonly sessionId: SessionId;
      readonly hold: EventCursor;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;

    /**
     * Answers an approval or a question, which lets its turn continue. Fails
     * with `RequestClosed` when the request is no longer open, including when
     * the engine refuses the answer for that reason.
     */
    readonly respond: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly response: RequestResponse;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | RequestClosed>;

    /**
     * Answers a secret request. The value goes to the engine's secret store and
     * reaches the command that asked, never the model. Applied once by nature:
     * the request closes, and answering again fails with `RequestClosed`. The
     * adapter submits one answer per request at a time, so of two concurrent
     * calls the second waits and then fails with `RequestClosed`.
     *
     * Success is the only proof that this call's answer was the one applied.
     * After `EngineIndeterminate`, a retry that fails with `RequestClosed` says
     * only that the request is closed: its resolution (from `request-closed`,
     * after `synchronize`) is how it closed, which may be another submission's
     * answer, a decline from elsewhere, or `expired`.
     */
    readonly respondSecret: (input: {
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly answer: SecretAnswer;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | RequestClosed>;

    /**
     * The session's events. With `after`, either every event after that cursor,
     * in order, or a single `replaced` when the adapter can no longer replay
     * from there; never both. A cursor names the engine's position, and the
     * adapter replays only from a batch the same process emitted and still
     * keeps. A `replaced` lists every turn that ended, not only those after
     * the cursor. A stream that reconnects and gets a snapshot from the engine
     * continues with a `replaced` too, never with a diff of it. With `after: null`, a `replaced` first: use it only
     * for a session nothing has been dispatched to yet, and store its cursor
     * before the first dispatch.
     *
     * The stream survives engine restarts and dropped connections: the adapter
     * reconnects and resumes the same way, so within one stream no event is
     * delivered twice and none is skipped without a `replaced` covering it. It
     * fails only when the session no longer exists or the engine turns out not
     * to be the pinned version. A stream counts as open from when it is
     * subscribed (when it starts running), before it emits anything: a
     * `synchronize` called after that reaches it. **Verified** on release
     * `4969` by the conformance scenario "counts a stream as open from its
     * subscription, before it emits anything", which subscribes and reads
     * nothing, calls `synchronize`, and then reads until the `synchronized`
     * event with its token arrives.
     */
    readonly events: (input: {
      readonly sessionId: SessionId;
      readonly after: EventCursor | null;
    }) => Stream.Stream<SessionEvent, SessionNotFound | EngineIncompatible>;

    /**
     * Asks for a `synchronized` event carrying `token` on every open `events`
     * stream of the session, after every event the engine had recorded for the
     * session when this was called. Once the server has applied that event, it
     * knows the session's state as of this call: the bot tool bridge uses it to
     * find the `tool-call` a tool request came from. The event also says
     * what background work the session still has (`BackgroundWork`), which
     * a Stop's interrupt ends only after it answered. Choose
     * the token, and start waiting for it, before calling.
     *
     * A stream counts as open from when it is subscribed, so one subscribed
     * before this call emits the event even if it has emitted nothing yet
     * (**Verified**, as on `events`).
     * Each stream emits the event only once the engine's completion marker
     * reached it, and the call returns once every open stream has emitted it
     * or closed. A catch-up that fails or times out fails the call with
     * `EngineUnavailable`; retry it.
     */
    readonly synchronize: (input: {
      readonly sessionId: SessionId;
      readonly token: SyncToken;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;
  }
>()("@j3-bots/engine-t3/Engine") {}
