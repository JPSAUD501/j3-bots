// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  type FailureClass,
  type ModelChoice,
  PermissionMode,
  type ProviderId,
  type WorkStepId,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { attachmentLimitViolation } from "../attachments.ts";
import { ENGINE_INPUT_LIMIT, engineInputLength } from "../input.ts";
import {
  Engine,
  type DispatchAttachment,
  type DispatchDisposition,
  type DispatchInput,
  type Delivery,
  type RequestResponse,
  type SecretAnswer,
  type SessionSuggestedReply,
} from "../Engine.ts";
import {
  AnswerRejected,
  BackgroundWorkRunning,
  DispatchRejected,
  EngineIndeterminate,
  EngineUnavailable,
  ModelUnavailable,
  OpenRejected,
  PermissionModeRefused,
  RequestClosed,
  RetireRejected,
  SessionBusy,
  SessionNotFound,
  StopRejected,
} from "../errors.ts";
import type {
  BackgroundWork,
  DelegatedResult,
  EndedTurn,
  EngineRequest,
  EngineStep,
  HostSpeech,
  OpenRequest,
  OpenTurn,
  PendingContinuation,
  RequestResolution,
  SessionEvent,
  SteerSettlement,
  ToolCall,
  TurnCause,
  TurnOutcome,
  EngineTurnWork,
} from "../events.ts";
import {
  DelegatedResultId,
  EngineAttachmentId,
  EngineInstanceId,
  EngineProjectId,
  EventCursor,
  HostSpeechId,
  type IdempotencyKey,
  RequestId,
  SessionId,
  ToolCallId,
  TurnId,
} from "../ids.ts";
import { toolInputDigest } from "../toolCaller.ts";

// An in-memory engine that keeps the `Engine` contract, for testing the server
// without an engine process. It models what the server has to get right: keys
// applied once; a first send refused locally before the receipt lookup, and a
// resend that skips it; a refused key refused again, after a lost reply too;
// dispositions that record acceptance, with delivery reported
// by events; a start the engine queues behind a turn it began itself; a steer
// that settles only when its turn ends (read, dropped by Stop, or requeued as a
// follow-up turn), and one refused because its turn waits or did not complete; Stop
// acknowledged before it takes effect, which disarms a pending continuation;
// queue holds reported once per edge, including one the engine puts back on a
// resume; a settings change refused while a turn runs, and a permission mode
// refused while background work runs, as on Claude Code; turns that fail
// before they start; `j3` tool calls the engine records
// after the bridge sees them; usage-limit continuations; requests that expire
// with their turn, and whose card can change while they are open; host
// speech; replies lost after a command was applied; staged files that expire;
// calls held in flight, a Stop whose effects lag its acknowledgment, a Stop
// refused while its work can still run, an opening refused for good under its
// key, permission modes above an administrator's ceiling refused, for a new
// session, a change and a turn alike, a retirement refused for now, a turn
// whose provider is slow to start it, and a dispatch that waits in the
// startup queue and lands late;
// synchronization markers; and resume by cursor with replay or a replacement
// that repeats turns already seen end, as the real engine may. The adapter's
// conformance suite runs the same scenarios against the real engine, which
// keeps this double honest.

/** The engine methods a test can hold in flight with `holdNext`. */
export type HeldMethod =
  | "configureSession"
  | "dispatch"
  | "redispatch"
  | "stageAttachment"
  | "respondSecret"
  | "resumeQueue"
  | "stop"
  | "forceStop"
  | "setHarnessExecutable"
  | "synchronize";

/** A call held at the engine's door. */
export interface Held {
  readonly entered: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
}

/** A dispatch the engine applied, as the test inspects it. */
export interface ReceivedDispatch {
  readonly key: IdempotencyKey;
  readonly text: string;
  readonly attachments: ReadonlyArray<DispatchAttachment>;
  readonly delivery: Delivery;
  /** How the engine applied it, whether or not the caller was told. */
  readonly disposition: DispatchDisposition;
}

/** Drives the engine's side of a session, and inspects what reached it. */
export class TestEngineControl extends Context.Service<
  TestEngineControl,
  {
    /**
     * While false, every command fails with `EngineUnavailable` and applies
     * nothing. Reachable again, the engine counts as a new start (`starts`).
     */
    readonly setReachable: (reachable: boolean) => Effect.Effect<void>;
    /**
     * The next time the engine becomes reachable, `starts` tells of the new
     * start only at `release`, as when the caller is slow to see it: commands
     * reach that start meanwhile.
     */
    readonly holdNextStartNotice: Effect.Effect<{ readonly release: Effect.Effect<void> }>;
    /**
     * The engine goes down and comes back on an empty data directory: another
     * engine (`instance`), with none of the projects, sessions, keys or staged
     * files of the one before. The streams opened on the one before get
     * nothing more.
     */
    readonly startFresh: Effect.Effect<void>;
    /** The base URL of the provider connection last set; never its key. */
    readonly providerConnection: Effect.Effect<Option.Option<string>>;
    /** The providers `recheckProvider` was asked to check again, in order. */
    readonly recheckedProviders: Effect.Effect<ReadonlyArray<ProviderId>>;
    /** How many times the shared skills were linked into the harness homes. */
    readonly sharedSkillLinks: Effect.Effect<number>;
    /** The workspaces whose bot skills were linked, in order. */
    readonly botSkillLinks: Effect.Effect<ReadonlyArray<string>>;
    /** The providers `updateProvider` was asked to update, in order. */
    readonly updatedProviders: Effect.Effect<ReadonlyArray<ProviderId>>;
    /** Each executable `setHarnessExecutable` was given, in order. */
    readonly harnessExecutables: Effect.Effect<
      ReadonlyArray<{
        readonly providerId: ProviderId;
        readonly executable: string | null;
        readonly version: string | null;
      }>
    >;
    /**
     * The harness guesses the operator's next message after `turnId` of the
     * session, replacing the guess it had there; `null` takes it away. An
     * engine restart loses every guess, as the engine's memory does.
     */
    readonly suggestReply: (input: {
      readonly sessionId: SessionId;
      readonly reply: SessionSuggestedReply | null;
    }) => Effect.Effect<void>;
    /**
     * The next command is applied, and then its reply is lost: it fails with
     * `EngineIndeterminate`.
     */
    readonly loseNextReply: Effect.Effect<void>;
    /**
     * The next call of `method` waits at the engine's door, before anything of
     * it is applied, until `release`. `entered` succeeds once it waits there,
     * so a test can act while the call is in flight.
     */
    readonly holdNext: (method: HeldMethod) => Effect.Effect<Held>;
    /**
     * The next call of `method` is applied, or refused, as usual, and its
     * answer waits until `release`. `entered` succeeds once it was decided,
     * so a test can act between the engine's decision and the caller's
     * hearing of it.
     */
    readonly holdNextAnswer: (method: HeldMethod) => Effect.Effect<Held>;
    /**
     * Every stream of the session opened from now on stalls before its first
     * event, as when the engine is slow to answer a subscription, until
     * `release`.
     */
    readonly withholdEvents: (
      sessionId: SessionId,
    ) => Effect.Effect<{ readonly release: Effect.Effect<void> }>;
    /**
     * The session's open streams stall: every event, and every
     * `synchronize`'s marker, waits for them, in order, until `release`, as
     * when the engine's connection stops delivering. A stream opened
     * meanwhile reads the history as usual.
     */
    readonly stallEvents: (
      sessionId: SessionId,
    ) => Effect.Effect<{ readonly release: Effect.Effect<void> }>;
    /**
     * While set, every `dispatch` and `redispatch` dies before anything of it
     * is applied, as a bug in the adapter would.
     */
    readonly breakDispatches: (broken: boolean) => Effect.Effect<void>;
    /**
     * The next `stop` is acknowledged at once, and its effects (the interrupt,
     * the cancels, the disarmed continuation) wait until `release`, as when
     * the provider's interrupt is slow. The cancels name the turns waiting
     * when it was sent: one queued meanwhile stays, held.
     */
    readonly delayNextStopEffects: Effect.Effect<{ readonly release: Effect.Effect<void> }>;
    /**
     * The next dispatch the engine receives, first send or resend, waits in
     * the engine's startup queue: it and every resend of its key fail with
     * `EngineIndeterminate`, applying nothing, until `land` applies it as it
     * was first sent. A resend after that is answered as the key's receipt.
     */
    readonly deferNextDispatch: Effect.Effect<{ readonly land: Effect.Effect<void> }>;
    /**
     * The engine refuses the next dispatch it receives, applying nothing and
     * keeping a rejected receipt: it fails with `DispatchRejected`, as does a
     * `redispatch` of the key, after a lost reply too.
     */
    readonly rejectNextDispatch: Effect.Effect<void>;
    /**
     * The engine refuses the next answer it receives while its request stays
     * open, keeping a rejected receipt, as when the provider session it would
     * reach is gone: it fails with `AnswerRejected`, as does every resend of
     * its key.
     */
    readonly rejectNextAnswer: Effect.Effect<void>;
    /**
     * The next `count` calls of `openSession` fail with `EngineIndeterminate`,
     * applying nothing, as when the engine dropped them: a later call under
     * the same key opens the session.
     */
    readonly failNextOpenSessions: (count: number) => Effect.Effect<void>;
    /**
     * The next call of `openSession` opens the session and then fails with
     * `EngineIndeterminate`, as when its reply was lost. A later call under the
     * same key returns that session as it was opened, as the engine answers a
     * replayed key.
     */
    readonly loseNextOpenSessionReply: Effect.Effect<void>;
    /**
     * The next `count` calls of `openSession` fail with `ModelUnavailable`,
     * applying nothing, as when the engine no longer offers the model asked
     * for. A later call under the same key opens the session.
     */
    readonly refuseNextOpenSessionModels: (count: number) => Effect.Effect<void>;
    /**
     * The engine refuses the next `openSession` it receives, opening nothing
     * and keeping a rejected receipt: it and every later call under its key
     * fail with `OpenRejected`. A call under another key opens a session.
     */
    readonly rejectNextOpenSession: Effect.Effect<void>;
    /**
     * The engine refuses every session opened in, and every change to, a
     * permission mode above `ceiling`, applying nothing and keeping nothing
     * for the key, with `PermissionModeRefused` naming `ceiling`, as under an
     * administrator's policy. A model sent with a refused mode change stays
     * applied. A session already in such a mode keeps it, and every dispatch
     * that would make a turn there, a start or a steer too late for its turn,
     * is refused the same way, on a first send and on a resend alike, as long
     * as the engine holds no receipt for the key; a steer into a running turn
     * passes, as the engine's ceiling checks only the commands that make a
     * run. The real engine reads its policy when it starts, so a test that
     * changes the ceiling later makes the engine unreachable around the
     * change, as a restart does (`setReachable`).
     */
    readonly limitPermissionModes: (ceiling: PermissionMode) => Effect.Effect<void>;
    /**
     * How many openings, settings changes and dispatches the engine refused
     * for their permission mode.
     */
    readonly modeRefusals: Effect.Effect<number>;
    /**
     * The next `count` calls of `retireSession` on a session still in use
     * fail with `RetireRejected`, applying nothing, as while delegated tasks
     * its Stop has not ended yet still run there.
     */
    readonly rejectNextRetirements: (count: number) => Effect.Effect<void>;
    /** Every session the engine opened, retired ones included, oldest first. */
    readonly openedSessions: Effect.Effect<ReadonlyArray<SessionId>>;
    /** The model a session runs, as it was opened or last configured. */
    readonly sessionModel: (sessionId: SessionId) => Effect.Effect<ModelChoice>;
    /** The permission mode a session runs, as it was opened or last configured. */
    readonly sessionPermissionMode: (sessionId: SessionId) => Effect.Effect<PermissionMode>;
    /**
     * Whether a session's next turn has the browser tools: what its provider
     * session started with, or for one still to start, at its first turn or
     * after `reloadTools`, what its project allows now.
     */
    readonly sessionBrowserTools: (sessionId: SessionId) => Effect.Effect<boolean>;
    /** How many times the browser profile was cleared. */
    readonly browserProfileClears: Effect.Effect<number>;
    /**
     * The engine refuses the next `stop` it receives, applying nothing and
     * keeping a rejected receipt, as when a read fails while it plans the
     * stop. It and every later call with its key fail with `StopRejected`
     * while anything a Stop targets can still run in the session (a running
     * or starting turn, background work, a pending continuation), and
     * succeed as moot once nothing can.
     */
    readonly rejectNextStop: Effect.Effect<void>;
    /**
     * The session's provider ignores the engine's stop from now on: a stop
     * still cancels the turns waiting and holds the queue, but its running
     * turn, or the background work the latest turn left, goes on, and the
     * engine marks the stop unresponsive (`stop-ignored`), until `forceStop`.
     */
    readonly ignoreStops: (sessionId: SessionId) => Effect.Effect<void>;
    /** Every `forceStop` the engine received, in order. */
    readonly forcedStops: Effect.Effect<
      ReadonlyArray<{ readonly sessionId: SessionId; readonly turnId: TurnId }>
    >;
    /**
     * The engine starts, or stops, trying the running turn's provider again
     * after a failure (`turn-retrying`).
     */
    readonly retry: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly retrying: boolean;
    }) => Effect.Effect<void>;
    /**
     * Background work wakes the session while the next `start` dispatch is on
     * its way: the adapter's busy check passes, and the engine then queues the
     * start behind that turn. `origin` is the turn the engine names as the one
     * whose work woke it, as for `startEngineTurn`.
     */
    readonly startEngineTurnDuringNextDispatch: (
      sessionId: SessionId,
      origin?: TurnId | null,
    ) => Effect.Effect<void>;
    /**
     * The next `synchronize` is answered, and its marker never reaches the
     * session's streams, as when the stream stalls. `requested` succeeds once
     * that `synchronize` arrived.
     */
    readonly dropNextMarker: Effect.Effect<{ readonly requested: Effect.Effect<void> }>;
    /**
     * The next turn to end with steers on it settles none of them, as an
     * engine fault would leave them: no `steered`, `steer-dropped` or
     * `steer-requeued` reaches the streams, a replacement lists none, and
     * none becomes a turn. `release` sends each settlement late: `steered`
     * for a steer the agent read, `steer-dropped` for any other.
     */
    readonly withholdNextSteerSettlements: Effect.Effect<{ readonly release: Effect.Effect<void> }>;
    /**
     * The next `stop` takes effect before it answers, and then background
     * work starts a turn in the session, which the stop missed: as when a run
     * begins between a Stop's commands. `started` gives that turn once the
     * engine created it; the stop answers only after `reply`.
     */
    readonly startEngineTurnDuringNextStop: (sessionId: SessionId) => Effect.Effect<{
      readonly started: Effect.Effect<TurnId>;
      readonly reply: Effect.Effect<void>;
    }>;
    /**
     * The next turn the session starts stays starting, its provider turn not
     * started, until `release`: no `turn-started` tells of it, and the
     * session's `synchronized` lists it in `runnableTurns`. A turn that ended
     * meanwhile stays ended.
     */
    readonly holdNextStartup: (
      sessionId: SessionId,
    ) => Effect.Effect<{ readonly release: Effect.Effect<void> }>;
    /**
     * The engine holds the session's queue of waiting turns, which must not be
     * empty: as after an engine restart, or, with `heldAgainOnResume`, a model
     * change while the replaced provider session still runs background work.
     * Then the engine holds the queue again whenever it would start a waiting
     * turn, a resume included, until `endReplacedSessionWork`.
     */
    readonly holdQueue: (input: {
      readonly sessionId: SessionId;
      readonly heldAgainOnResume: boolean;
    }) => Effect.Effect<void>;
    /**
     * The replaced provider session's background work ends. A hold the engine
     * put back in answer to a resume is reported now, as a new `queue-held`.
     */
    readonly endReplacedSessionWork: (sessionId: SessionId) => Effect.Effect<void>;
    /**
     * The next turn the session starts fails before its provider turn starts:
     * it ends `failed` with no `turn-started`.
     */
    readonly failNextStart: (input: {
      readonly sessionId: SessionId;
      readonly failure: FailureClass;
    }) => Effect.Effect<void>;
    /** Adds or replaces (by id) a step of a running turn. */
    readonly step: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly step: EngineStep;
    }) => Effect.Effect<void>;
    /**
     * Replaces a turn's plan and little ones, told at once (`turn-work`): of a
     * running turn, or of an ended one, as a little one it handed off ends.
     */
    readonly turnWork: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly work: EngineTurnWork;
    }) => Effect.Effect<void>;
    /**
     * The agent takes every steer of the running turn, each told at once
     * (`steer-taken`). Each settles as `steered` when the turn ends.
     */
    readonly readSteers: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void>;
    /**
     * The bot calls a `j3` tool in the running turn. With `recorded:
     * "after-next-synchronize"` the engine records the call late: the next
     * `synchronize` is answered before its `tool-call` event.
     */
    readonly toolCall: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly tool: string;
      readonly input: unknown;
      readonly recorded: "now" | "after-next-synchronize";
    }) => Effect.Effect<ToolCallId>;
    /**
     * The engine records an open `j3` tool call again with other input, as it
     * does for an ACP agent that reported the call before its arguments.
     */
    readonly recordToolInput: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly callId: ToolCallId;
      readonly input: unknown;
    }) => Effect.Effect<void>;
    /** A `j3` tool call returns. */
    readonly closeToolCall: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly callId: ToolCallId;
    }) => Effect.Effect<void>;
    /** The turn holds on the operator, holding back `heldCall` when one is given. */
    readonly openRequest: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly request: EngineRequest;
      readonly heldCall?: ToolCallId;
    }) => Effect.Effect<RequestId>;
    /**
     * An open request shows something else, as when the adapter fetched a held
     * file change's diff after the request opened. A request that has closed
     * is a misuse.
     */
    readonly updateRequest: (input: {
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly request: EngineRequest;
    }) => Effect.Effect<void>;
    /** The bot called the host's own speech tool. */
    readonly hostSpeech: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly text: string;
    }) => Effect.Effect<HostSpeechId>;
    /**
     * The turn leaves background work running when it ends, which wakes the
     * session when it ends, as a delegated task or a command whose completion
     * wakes it: its turn reports it as `backgroundWork`. The wake it brings is
     * `startEngineTurn`. With `stoppable: false` the engine's stop does not
     * reach it, as an old provider session's work after another client started
     * a fresh context: it ends by itself or when the session is retired. With
     * `announced: false` the turn's end says it left none, as for a monitor the
     * agent does not await: only the engine's report of the session's
     * background work lists it, as that turn's.
     */
    readonly startBackgroundWork: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stoppable?: boolean;
      readonly announced?: boolean;
    }) => Effect.Effect<void>;
    /**
     * The background work every turn of the session left running ends, and
     * wakes nothing: a wake it brings is `startEngineTurn`.
     */
    readonly endBackgroundWork: (sessionId: SessionId) => Effect.Effect<void>;
    /**
     * The provider could not resume the session's conversation, so the engine
     * runs the turn in a fresh one from its own summary: its end says so.
     */
    readonly recoverContext: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void>;
    /** Whether background work some turn of the session started still runs. */
    readonly backgroundWorkRunning: (sessionId: SessionId) => Effect.Effect<boolean>;
    /**
     * Ends a running turn the way the provider would. Its open requests expire,
     * and each steer it had not taken is requeued as a follow-up turn.
     * `continuation`, for a `failed` turn only, arms a usage-limit resume.
     */
    readonly finishTurn: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly outcome: TurnOutcome;
      readonly continuation?: PendingContinuation;
    }) => Effect.Effect<void>;
    /** The engine runs a turn's pending continuation, as a turn of its own. */
    readonly resumeContinuation: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<TurnId>;
    /** The engine clears a turn's pending continuation. */
    readonly dropContinuation: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void>;
    /**
     * Background work the bot started wakes the session. The turn starts at
     * once, or after the running one. `origin` is the turn the engine names
     * as the one whose work woke it, as for its own delegated tasks; a
     * harness's wake names none.
     */
    readonly startEngineTurn: (
      sessionId: SessionId,
      origin?: TurnId | null,
    ) => Effect.Effect<TurnId>;
    /**
     * A task the turn `origin` delegated ends while `turnId`, another turn,
     * runs: the engine steers its result into that turn, as it does whatever
     * turn delegated it, and the turn takes it. It is told as that turn ends
     * (`delegated-result`).
     */
    readonly delegatedResult: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly origin: TurnId;
      readonly text: string;
    }) => Effect.Effect<DelegatedResultId>;
    /** Forgets the session's event history, so a resume from any cursor gets a `replaced`. */
    readonly pruneHistory: (sessionId: SessionId) => Effect.Effect<void>;
    /**
     * The engine loses the session, as when its data is deleted: its streams
     * end with `SessionNotFound`, and so does every command for it.
     */
    readonly loseSession: (sessionId: SessionId) => Effect.Effect<void>;
    /**
     * The session is archived from the engine's own console: the turns
     * waiting there are cancelled, a turn already running or starting gets no
     * end, every command for it is `SessionNotFound`, and its event streams
     * end with `SessionNotFound` after the events before it, as the
     * adapter's do.
     */
    readonly archiveSession: (sessionId: SessionId) => Effect.Effect<void>;
    /** How many event streams of the session are open. */
    readonly openStreams: (sessionId: SessionId) => Effect.Effect<number>;
    readonly dispatches: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ReceivedDispatch>>;
    readonly responses: (
      sessionId: SessionId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly requestId: RequestId; readonly response: RequestResponse }>
    >;
    /** Each answer the engine refused, first send and resend alike, by its request. */
    readonly rejectedAnswers: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<RequestId>>;
    readonly secretAnswers: (
      sessionId: SessionId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly requestId: RequestId; readonly answer: SecretAnswer }>
    >;
  }
>()("@j3-bots/engine-t3/testing/TestEngine/TestEngineControl") {}

interface SteerRecord {
  readonly key: IdempotencyKey;
  /** Turns waiting when the steer was sent: a follow-up turn runs after these. */
  readonly queuedAhead: ReadonlyArray<TurnId>;
  /** The session's model when it was sent, which a follow-up turn runs on. */
  readonly model: ModelChoice;
  /** `withheld`: its turn ended, and the engine settled it with no event (`withholdNextSteerSettlements`). */
  state: "unread" | "read" | "dropped" | "requeued" | "withheld";
}

/** A steer whose settlement the engine kept back, to send late. */
interface WithheldSteer {
  readonly session: SessionRecord;
  readonly turnId: TurnId;
  readonly steer: SteerRecord;
  /** Whether the agent read it before its turn ended: it settles as `steered`, else `steer-dropped`. */
  readonly read: boolean;
}

interface ToolCallRecord {
  call: ToolCall;
  state: "unrecorded" | "open" | "closed";
}

interface TurnRecord {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
  /**
   * The model the turn starts on, moving the session to it. A turn for a
   * dispatch, or a steer's follow-up, takes the session's model when the
   * engine took it, as the engine starts a queued run on the selection it
   * was queued with; a turn the engine started on its own, as for a
   * delegated task's completion, takes the session's model as it starts
   * (`null` until then). **Read** at `59651c1`, `Orchestrator.ts`,
   * `queuedRunModelSelection` and `followsCurrentConversation`, L1026-1053.
   */
  model: ModelChoice | null;
  startedAt: DateTime.Utc | null;
  readonly steps: Map<WorkStepId, EngineStep>;
  work: EngineTurnWork;
  readonly steers: Array<SteerRecord>;
  /** Delegated results steered into it, told as it ends (`delegatedResult`). */
  readonly landed: Array<DelegatedResult>;
  readonly toolCalls: Map<ToolCallId, ToolCallRecord>;
  readonly hostSpeech: Array<HostSpeech>;
  readonly closedRequests: Array<{
    readonly requestId: RequestId;
    readonly turnId: TurnId;
    readonly resolution: RequestResolution;
    readonly closedAt: DateTime.Utc;
  }>;
  /** It left background work running, which a Stop ends. */
  background: boolean;
  /**
   * That work is not one its end tells of, as a monitor the agent does not
   * await: only the engine's report of the session's background work lists it.
   */
  unannounced: boolean;
  /** It left background work running that a Stop does not reach; retiring the session ends it. */
  unstoppable: boolean;
  /** The engine ran it in a fresh provider conversation, from its summary of the old one. */
  contextRecovered: boolean;
  /** The engine is trying its provider again after a failure (`retry`). */
  retrying: boolean;
  ended: {
    readonly outcome: TurnOutcome;
    readonly at: DateTime.Utc;
    continuation: PendingContinuation | null;
  } | null;
}

type Subscriber = Queue.Enqueue<SessionEvent, SessionNotFound | Cause.Done>;

interface SessionRecord {
  readonly id: SessionId;
  readonly projectId: EngineProjectId;
  retired: boolean;
  model: ModelChoice;
  permissionMode: PermissionMode;
  /**
   * Whether the session's provider session has the browser tools: what its
   * project allowed when it started, at the session's first turn. `null`
   * while it has none, before that first turn and after `reloadTools`.
   */
  browserTools: boolean | null;
  readonly log: Array<{ readonly sequence: number; readonly event: SessionEvent }>;
  /** A resume from a cursor below this sequence cannot be replayed. */
  replayableFrom: number;
  readonly turns: Map<TurnId, TurnRecord>;
  running: TurnId | null;
  readonly waiting: Array<TurnId>;
  /** The waiting turns are held. Never true with none waiting. */
  held: boolean;
  /** The engine put the hold back in answer to a resume, and has not reported it. */
  unreportedHold: boolean;
  /** Set by `holdQueue` with `heldAgainOnResume`, until `endReplacedSessionWork`. */
  replacedSessionWorking: boolean;
  /** Cursors of the holds reported, which `resumeQueue` may name. */
  readonly holdCursors: Set<EventCursor>;
  /** Holds already resumed, by cursor: a resume is keyed by its hold. */
  readonly resumedHolds: Set<EventCursor>;
  readonly requests: Map<RequestId, OpenRequest>;
  readonly dispatches: Map<IdempotencyKey, ReceivedDispatch>;
  readonly responses: Array<{ readonly requestId: RequestId; readonly response: RequestResponse }>;
  readonly rejectedAnswers: Array<RequestId>;
  readonly secretAnswers: Array<{ readonly requestId: RequestId; readonly answer: SecretAnswer }>;
  /** Delegated results told: each steered into a turn other than its own, which has ended. */
  readonly delegatedResults: Array<DelegatedResult>;
  /** Each open stream, with the cursor of the last event it was given. */
  readonly subscribers: Map<Subscriber, { lastCursor: EventCursor }>;
  /** Set by `startEngineTurnDuringNextDispatch`: the turn it names, if any. */
  raceNextStart: { readonly origin: TurnId | null } | null;
  /** Set by `failNextStart`. */
  failNextStart: FailureClass | null;
  /** Set by `holdNextStartup`, until the next turn starts. */
  holdStartup: boolean;
  /** The turn `holdNextStartup` keeps starting, until released. */
  heldStartup: TurnId | null;
  /** Set by `ignoreStops`: its provider ignores the engine's stop. */
  ignoresStops: boolean;
  /** The turn whose stop its provider ignored, as `stop-ignored` told it, until force-stopped. */
  stopIgnored: TurnId | null;
}

type AppliedKey =
  /** `null`: the engine refused it. */
  | { readonly command: "openSession"; readonly sessionId: SessionId | null }
  | {
      readonly command: "dispatch";
      readonly sessionId: SessionId;
      readonly outcome: "applied" | "rejected";
    }
  | { readonly command: "stop"; readonly outcome: "applied" | "rejected" }
  | { readonly command: "respond"; readonly outcome: "applied" | "rejected" };

const initialStatus: EngineStatus = {
  state: { _tag: "ready" },
  pinnedVersion: "test",
  providers: [],
};

/** How long the real adapter lets a staged file wait for its dispatch. */
const STAGED_USABLE_FOR = Duration.hours(12);

const make = Effect.gen(function* () {
  const status = yield* SubscriptionRef.make(initialStatus);
  let reachable = true;
  /** Each session's suggested reply, kept in memory only, as the engine keeps it. */
  const suggestions = yield* SubscriptionRef.make<ReadonlyMap<SessionId, SessionSuggestedReply>>(
    new Map(),
  );
  /** The engine's starts: one more each time it becomes reachable again. */
  let start = 1;
  const started = yield* SubscriptionRef.make<number | null>(start);
  /** Set by `holdNextStartNotice`; taken by the next start. */
  let startNoticeHeld: "next" | "held" | null = null;
  /** Tells `starts` where the engine stands now. */
  const noticeStart = Effect.suspend(() => SubscriptionRef.set(started, reachable ? start : null));
  let instances = 1;
  /** The base URL of the provider connection, once one is set. */
  let connection = Option.none<string>();
  const rechecked: Array<ProviderId> = [];
  const updated: Array<ProviderId> = [];
  const executables: Array<{
    readonly providerId: ProviderId;
    readonly executable: string | null;
    readonly version: string | null;
  }> = [];
  let sharedSkillLinks = 0;
  const botSkillLinks: Array<string> = [];
  let loseReply = false;
  let rejectDispatch = false;
  let rejectAnswer = false;
  let failingOpenSessions = 0;
  let losingOpenSessionReply = false;
  let refusingOpenSessionModels = 0;
  let rejectOpenSession = false;
  let modeCeiling: PermissionMode | null = null;
  let modeRefusals = 0;
  /** The ceiling's refusal of `mode`, counted, if it refuses it. */
  const modeRefusal = (mode: PermissionMode) => {
    if (
      modeCeiling === null ||
      PermissionMode.literals.indexOf(mode) <= PermissionMode.literals.indexOf(modeCeiling)
    ) {
      return Option.none<PermissionModeRefused>();
    }
    modeRefusals++;
    return Option.some(
      new PermissionModeRefused({ permissionMode: mode, allowed: modeCeiling, engineStart: start }),
    );
  };
  let rejectingRetirements = 0;
  let rejectStop = false;
  const forcedStops: Array<{ readonly sessionId: SessionId; readonly turnId: TurnId }> = [];
  const holds = new Map<
    HeldMethod,
    { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  >();
  let stopEffects: Deferred.Deferred<void> | null = null;
  let droppedMarker: Deferred.Deferred<void> | null = null;
  /** The steers whose settlements the next turn's end keeps back, once armed. */
  let withholding: Array<WithheldSteer> | null = null;
  let turnDuringStop: {
    readonly sessionId: SessionId;
    readonly started: Deferred.Deferred<TurnId>;
    readonly reply: Deferred.Deferred<void>;
  } | null = null;
  let deferNext: Deferred.Deferred<void> | null = null;
  /** Answers held after their command was decided, by method. */
  const answerHolds = new Map<
    HeldMethod,
    { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  >();
  /** Sessions whose new streams stall until released. */
  const withheld = new Map<SessionId, Deferred.Deferred<void>>();
  /** What the stalled streams of a session have not been given yet, in order: events, and ends. */
  const stalled = new Map<SessionId, Array<() => void>>();
  /** While set, every dispatch and redispatch dies before it is applied. */
  let brokenDispatches = false;
  /** Dispatches waiting in the startup queue, by key, until they land. */
  const deferred = new Map<IdempotencyKey, Deferred.Deferred<void>>();
  // One counter for every session, as the real engine numbers its events.
  let sequence = 0;
  let nextId = 0;
  const projects = new Map<string, EngineProjectId>();
  /** The projects `setBrowserAccess` allowed the browser. */
  const browserProjects = new Set<EngineProjectId>();
  let browserProfileClears = 0;
  const sessions = new Map<SessionId, SessionRecord>();
  const keys = new Map<IdempotencyKey, AppliedKey>();
  /** Each staged file, with its `usableUntil`. */
  const staged = new Map<EngineAttachmentId, DateTime.Utc>();

  const newId = (prefix: string) => `${prefix}-${++nextId}`;
  const cursorOf = (value: number) => EventCursor.make(String(value));

  /**
   * Runs a command the way the adapter would: refused without being sent while
   * the engine is unreachable, and failing with `EngineIndeterminate` after it
   * was applied when its reply is lost.
   */
  const command = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EngineUnavailable | EngineIndeterminate, R> =>
    Effect.suspend((): Effect.Effect<A, E | EngineUnavailable | EngineIndeterminate, R> => {
      if (!reachable) return Effect.fail(new EngineUnavailable());
      if (!loseReply) return effect;
      loseReply = false;
      return effect.pipe(Effect.ignore, Effect.andThen(Effect.fail(new EngineIndeterminate())));
    });

  /**
   * Waits at the door when the test holds the next call of `method`, and
   * holds its answer once decided when the test holds that.
   */
  const door = <A, E, R>(method: HeldMethod, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const answered = Effect.suspend(() => {
        const hold = answerHolds.get(method);
        if (hold === undefined) return effect;
        answerHolds.delete(method);
        return Effect.exit(effect).pipe(
          Effect.tap(() => Deferred.succeed(hold.entered, undefined)),
          Effect.tap(() => Deferred.await(hold.release)),
          Effect.flatten,
        );
      });
      const hold = holds.get(method);
      if (hold === undefined) return answered;
      holds.delete(method);
      return Deferred.succeed(hold.entered, undefined).pipe(
        Effect.andThen(Deferred.await(hold.release)),
        Effect.andThen(answered),
      );
    });

  /** A bug in the adapter, while the test has dispatches broken. */
  const unbroken = Effect.suspend(() =>
    brokenDispatches ? Effect.die(new Error("A broken dispatch")) : Effect.void,
  );

  /**
   * A dispatch the startup queue holds: the send waits there, so it answers
   * `EngineIndeterminate` and applies nothing until the test lands it.
   */
  const startupQueue = (input: DispatchInput) =>
    Effect.gen(function* () {
      const waiting = deferred.get(input.key);
      if (waiting !== undefined && !(yield* Deferred.isDone(waiting))) {
        return yield* new EngineIndeterminate();
      }
      if (deferNext === null) return;
      const land = deferNext;
      deferNext = null;
      deferred.set(input.key, land);
      // Applied as first sent, once the test lands it.
      yield* Effect.forkDetach(
        Deferred.await(land).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const session = sessions.get(input.sessionId);
              return session === undefined ? Effect.void : applyDispatch(session, input);
            }),
          ),
          Effect.ignore,
        ),
      );
      return yield* new EngineIndeterminate();
    });

  /** Fails the test: the caller broke the contract, which no engine would tolerate. */
  const misuse = (what: string) => Effect.die(new Error(`Engine contract misuse: ${what}`));

  const liveSession = (sessionId: SessionId) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionId);
      return session === undefined || session.retired
        ? Effect.fail(new SessionNotFound({ sessionId }))
        : Effect.succeed(session);
    });

  const existingSession = (sessionId: SessionId) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionId);
      return session === undefined ? misuse(`no session ${sessionId}`) : Effect.succeed(session);
    });

  /** What the key already did, if anything. A key reused for another command is a bug. */
  const priorUse = (key: IdempotencyKey, command: AppliedKey["command"]) =>
    Effect.suspend(() => {
      const previous = keys.get(key);
      return previous === undefined || previous.command === command
        ? Effect.succeed(previous)
        : misuse(`key ${key} reused for ${command}`);
    });

  /** Hands an event to a stream of the session, or holds it while its streams stall. */
  /** Gives a stream something now, or once its session's stall is released. */
  const give = (session: SessionRecord, given: () => void) => {
    const backlog = stalled.get(session.id);
    if (backlog === undefined) given();
    else backlog.push(given);
  };

  const offer = (session: SessionRecord, subscriber: Subscriber, event: SessionEvent) =>
    give(session, () => void Queue.offerUnsafe(subscriber, event));

  /** Ends every stream of the session with `SessionNotFound`, after what they were given. */
  const endStreams = (session: SessionRecord) => {
    for (const subscriber of session.subscribers.keys()) {
      give(
        session,
        () =>
          void Queue.failCauseUnsafe(
            subscriber,
            Cause.fail(new SessionNotFound({ sessionId: session.id })),
          ),
      );
    }
  };

  const deliver = (session: SessionRecord, event: SessionEvent) => {
    for (const [subscriber, state] of session.subscribers) {
      state.lastCursor = event.cursor;
      offer(session, subscriber, event);
    }
  };

  const emit = (
    session: SessionRecord,
    at: DateTime.Utc,
    make: (stamp: { readonly cursor: EventCursor; readonly at: DateTime.Utc }) => SessionEvent,
  ) => {
    sequence += 1;
    const event = make({ cursor: cursorOf(sequence), at });
    session.log.push({ sequence, event });
    deliver(session, event);
  };

  const newTurn = (
    session: SessionRecord,
    cause: TurnCause,
    model: ModelChoice | null = cause._tag === "background" ? null : session.model,
  ): TurnRecord => {
    const turn: TurnRecord = {
      turnId: TurnId.make(newId("turn")),
      cause,
      model,
      startedAt: null,
      steps: new Map(),
      work: { plan: null, littleOnes: [] },
      steers: [],
      landed: [],
      toolCalls: new Map(),
      hostSpeech: [],
      closedRequests: [],
      background: false,
      unannounced: false,
      unstoppable: false,
      contextRecovered: false,
      retrying: false,
      ended: null,
    };
    session.turns.set(turn.turnId, turn);
    return turn;
  };

  /** Whether the turn left background work that still runs, whether or not a Stop reaches it. */
  const leftWork = (turn: TurnRecord) => turn.background || turn.unstoppable;

  /** Whether the turn's end tells of background work it left running (`leftWork`). */
  const announcesWork = (turn: TurnRecord) =>
    (turn.background && !turn.unannounced) || turn.unstoppable;

  /** Whether background work some turn of the session left still runs. */
  const backgroundRuns = (session: SessionRecord) => [...session.turns.values()].some(leftWork);

  const closeRequest = (
    session: SessionRecord,
    open: OpenRequest,
    resolution: RequestResolution,
    at: DateTime.Utc,
  ) => {
    session.requests.delete(open.requestId);
    session.turns.get(open.turnId)?.closedRequests.push({
      requestId: open.requestId,
      turnId: open.turnId,
      resolution,
      closedAt: at,
    });
    emit(session, at, (stamp) => ({
      _tag: "request-closed",
      ...stamp,
      requestId: open.requestId,
      turnId: open.turnId,
      resolution,
      closedAt: at,
    }));
  };

  const dropContinuation = (session: SessionRecord, turn: TurnRecord, at: DateTime.Utc) => {
    if (turn.ended === null || turn.ended.continuation === null) return;
    turn.ended.continuation = null;
    emit(session, at, (stamp) => ({
      _tag: "continuation-dropped",
      ...stamp,
      turnId: turn.turnId,
    }));
  };

  /** Holds the waiting turns, reporting the edge. Nothing to hold, no edge. */
  const holdWaiting = (session: SessionRecord, at: DateTime.Utc) => {
    if (session.held || session.waiting.length === 0) return;
    session.held = true;
    emit(session, at, (stamp) => {
      session.holdCursors.add(stamp.cursor);
      return { _tag: "queue-held", ...stamp };
    });
  };

  /** A hold is a mark on waiting turns: with none left, nothing is held. */
  const clearEmptyHold = (session: SessionRecord) => {
    if (session.waiting.length > 0) return;
    session.held = false;
    session.unreportedHold = false;
  };

  /**
   * Starts the next waiting turn, unless one runs or the queue is held. While
   * a replaced provider session still runs background work, the engine holds
   * the queue instead.
   */
  const startNext = (session: SessionRecord, at: DateTime.Utc) => {
    if (session.running !== null || session.held) return;
    if (session.replacedSessionWorking) return holdWaiting(session, at);
    const nextId = session.waiting.shift();
    const next = nextId === undefined ? undefined : session.turns.get(nextId);
    if (next !== undefined) startTurn(session, next, at);
  };

  /**
   * A new turn, at the end of the queue; it starts at once if nothing runs and
   * the queue is not held, and is otherwise reported `turn-queued`, whatever
   * its cause, as the adapter reports a run the engine queued. The newer turn
   * takes the place of any pending continuation, which no longer resumes the
   * session's latest turn.
   */
  const addTurn = (session: SessionRecord, cause: TurnCause, at: DateTime.Utc) => {
    for (const turn of session.turns.values()) dropContinuation(session, turn, at);
    const turn = newTurn(session, cause);
    session.waiting.push(turn.turnId);
    startNext(session, at);
    if (session.waiting.includes(turn.turnId)) {
      emit(session, at, (stamp) => ({
        _tag: "turn-queued",
        ...stamp,
        turnId: turn.turnId,
        cause: turn.cause,
      }));
    }
    return turn;
  };

  /**
   * Ends a turn. Its open requests expire and its tool calls close. Each steer
   * settles after its `turn-finished`: taken (`steered`), dropped when Stop
   * ended the turn, or otherwise requeued as a follow-up turn placed after the
   * turns that were already waiting when the steer was sent.
   */
  const endTurn = (
    session: SessionRecord,
    turn: TurnRecord,
    outcome: TurnOutcome,
    at: DateTime.Utc,
    endedBy: "stop" | "other",
    continuation: PendingContinuation | null = null,
  ) => {
    for (const open of session.requests.values()) {
      if (open.turnId === turn.turnId) closeRequest(session, open, "expired", at);
    }
    for (const [callId, record] of turn.toolCalls) {
      if (record.state === "unrecorded") turn.toolCalls.delete(callId);
      else record.state = "closed";
    }
    const waitingIndex = session.waiting.indexOf(turn.turnId);
    if (waitingIndex >= 0) session.waiting.splice(waitingIndex, 1);
    clearEmptyHold(session);
    const settlements: Array<(stamp: { cursor: EventCursor; at: DateTime.Utc }) => SessionEvent> =
      [];
    const withheld = withholding;
    for (const steer of turn.steers) {
      if (withheld !== null && (steer.state === "read" || steer.state === "unread")) {
        withheld.push({ session, turnId: turn.turnId, steer, read: steer.state === "read" });
        steer.state = "withheld";
        continue;
      }
      if (steer.state === "read") {
        settlements.push((stamp) => ({
          _tag: "steered",
          ...stamp,
          key: steer.key,
          turnId: turn.turnId,
        }));
      } else if (steer.state !== "unread") {
        continue;
      } else if (endedBy === "stop") {
        steer.state = "dropped";
        settlements.push((stamp) => ({
          _tag: "steer-dropped",
          ...stamp,
          key: steer.key,
          turnId: turn.turnId,
        }));
      } else {
        steer.state = "requeued";
        const followUp = newTurn(session, { _tag: "dispatch", key: steer.key }, steer.model);
        const place = session.waiting.filter((waiting) => steer.queuedAhead.includes(waiting));
        const last = place.at(-1);
        session.waiting.splice(
          last === undefined ? 0 : session.waiting.indexOf(last) + 1,
          0,
          followUp.turnId,
        );
        settlements.push((stamp) => ({
          _tag: "steer-requeued",
          ...stamp,
          key: steer.key,
          turnId: turn.turnId,
          followUpTurnId: followUp.turnId,
        }));
      }
    }
    // Only the first turn to end with steers keeps theirs back.
    if (withheld !== null && withheld.length > 0) withholding = null;
    turn.ended = { outcome, at, continuation };
    emit(session, at, (stamp) => ({
      _tag: "turn-finished",
      ...stamp,
      turnId: turn.turnId,
      finishedAt: at,
      cause: turn.cause,
      outcome,
      backgroundWork: announcesWork(turn),
      continuation,
      contextRecovered: turn.contextRecovered,
    }));
    for (const settlement of settlements) emit(session, at, settlement);
    for (const result of turn.landed) {
      session.delegatedResults.push(result);
      emit(session, at, (stamp) => ({ _tag: "delegated-result", ...stamp, result }));
    }
    if (session.running === turn.turnId) {
      session.running = null;
      // A failure holds the queue, except a usage limit, which makes it wait
      // for the reset without holding it.
      if (outcome._tag === "failed" && outcome.failure !== "usage-limit") {
        holdWaiting(session, at);
      }
      startNext(session, at);
    }
  };

  const startTurn = (session: SessionRecord, turn: TurnRecord, at: DateTime.Utc): void => {
    session.running = turn.turnId;
    session.browserTools ??= browserProjects.has(session.projectId);
    if (session.failNextStart !== null) {
      const failure = session.failNextStart;
      session.failNextStart = null;
      endTurn(session, turn, { _tag: "failed", failure, retryAt: null }, at, "other");
      return;
    }
    if (session.holdStartup) {
      session.holdStartup = false;
      session.heldStartup = turn.turnId;
      return;
    }
    beginTurn(session, turn, at);
  };

  /** The turn's provider turn starts. */
  const beginTurn = (session: SessionRecord, turn: TurnRecord, at: DateTime.Utc): void => {
    const model = turn.model ?? session.model;
    turn.startedAt = at;
    turn.model = model;
    session.model = model;
    emit(session, at, (stamp) => ({
      _tag: "turn-started",
      ...stamp,
      turnId: turn.turnId,
      cause: turn.cause,
      startedAt: at,
      model,
    }));
  };

  const runningTurn = (session: SessionRecord, turnId: TurnId) => {
    const turn = session.turns.get(turnId);
    return turn !== undefined && session.running === turnId && turn.ended === null
      ? Effect.succeed(turn)
      : misuse(`turn ${turnId} is not running`);
  };

  /**
   * A `start` the engine applies. J3 Bots' messages never release a held
   * queue (**Read** at `db51b67`, `sentByUserFromClient`), so behind one it is
   * `queued`, held with the rest.
   */
  const applyStart = (
    session: SessionRecord,
    key: IdempotencyKey,
    at: DateTime.Utc,
  ): DispatchDisposition => {
    if (session.raceNextStart !== null) {
      const { origin } = session.raceNextStart;
      session.raceNextStart = null;
      addTurn(session, { _tag: "background", origin }, at);
    }
    const turn = addTurn(session, { _tag: "dispatch", key }, at);
    return session.waiting.includes(turn.turnId)
      ? { _tag: "queued", turnId: turn.turnId }
      : { _tag: "started", turnId: turn.turnId };
  };

  /**
   * Stop as it takes effect, after `stop` returned: the engine's own stop holds
   * the queue and disarms a pending continuation, each turn in `cancels` (the
   * turns that waited when the Stop was sent, which the adapter cancels one by
   * one) is cancelled, taken off the queue first: cancelling one starts no
   * other. A turn queued since stays, held. The provider's interrupt ends the
   * running turn, and the background work every turn left running ends, also
   * in a session whose last turn already ended.
   */
  const stopSession = (
    session: SessionRecord,
    at: DateTime.Utc,
    cancels: ReadonlyArray<TurnId>,
  ) => {
    holdWaiting(session, at);
    for (const turn of session.turns.values()) dropContinuation(session, turn, at);
    const cancelled = session.waiting.filter((turnId) => cancels.includes(turnId));
    for (const turnId of cancelled) session.waiting.splice(session.waiting.indexOf(turnId), 1);
    for (const turnId of cancelled) {
      const turn = session.turns.get(turnId);
      if (turn !== undefined) endTurn(session, turn, { _tag: "cancelled" }, at, "stop");
    }
    clearEmptyHold(session);
    const running = session.running === null ? undefined : session.turns.get(session.running);
    if (session.ignoresStops) {
      // The provider never confirms: the running turn, or the work the latest
      // turn left, goes on, and the engine marks the stop unresponsive. With
      // neither, there is nothing to ignore.
      const latest = [...session.turns.values()].findLast((turn) => turn.startedAt !== null);
      const target = running ?? (latest?.background === true ? latest : undefined);
      if (target !== undefined && session.stopIgnored !== target.turnId) {
        session.stopIgnored = target.turnId;
        emit(session, at, (stamp) => ({ _tag: "stop-ignored", ...stamp, turnId: target.turnId }));
      }
      return;
    }
    for (const turn of session.turns.values()) turn.background = false;
    if (running !== undefined) {
      endTurn(session, running, { _tag: "interrupted" }, at, "stop");
    }
  };

  /** Force stop: the turn whose stop was ignored ends, and so does the work it left. */
  const forceStopSession = (session: SessionRecord, turnId: TurnId, at: DateTime.Utc) => {
    if (session.stopIgnored !== turnId) return;
    session.stopIgnored = null;
    const turn = session.turns.get(turnId);
    if (turn !== undefined) {
      turn.background = false;
      if (session.running === turnId) endTurn(session, turn, { _tag: "interrupted" }, at, "stop");
    }
    emit(session, at, (stamp) => ({ _tag: "stop-ignored", ...stamp, turnId: null }));
  };

  /** Whether anything a Stop targets can still run in the session. */
  const stoppable = (session: SessionRecord) =>
    session.running !== null ||
    [...session.turns.values()].some(
      (turn) => turn.background || (turn.ended !== null && turn.ended.continuation !== null),
    );

  /**
   * The engine archives the session, from its console or after
   * `retireSession`'s Stop: it cancels the turns still waiting, leaves a turn
   * already running or starting with no end, and ends the session's streams.
   */
  const archive = (session: SessionRecord, at: DateTime.Utc) => {
    // Ending a turn takes it out of `waiting`, so this walks a copy.
    const waiting = session.waiting.slice();
    for (const turnId of waiting) {
      const turn = session.turns.get(turnId);
      if (turn !== undefined) endTurn(session, turn, { _tag: "cancelled" }, at, "other");
    }
    session.retired = true;
    endStreams(session);
  };

  const retire = (session: SessionRecord, at: DateTime.Utc) => {
    stopSession(session, at, [...session.waiting]);
    for (const turn of session.turns.values()) turn.unstoppable = false;
    archive(session, at);
  };

  /**
   * The engine keeps no sequence for a turn's end, so like the real adapter
   * this cannot tell which turns ended after the cursor. It lists every ended
   * turn, which the contract allows.
   */
  const replacement = (
    session: SessionRecord,
    after: number | null,
    at: DateTime.Utc,
  ): SessionEvent => {
    const openTurns: Array<OpenTurn> = [];
    const endedTurns: Array<EndedTurn> = [];
    const listed: Array<TurnRecord> = [];
    for (const turn of session.turns.values()) {
      const steps = [...turn.steps.values()];
      if (turn.ended === null) {
        openTurns.push({
          turnId: turn.turnId,
          cause: turn.cause,
          startedAt: turn.startedAt,
          model: turn.startedAt === null ? null : turn.model,
          steps,
          work: turn.work,
          takenSteers: turn.steers.flatMap((steer) => (steer.state === "read" ? [steer.key] : [])),
          toolCalls: [...turn.toolCalls.values()].flatMap((record) =>
            record.state === "open" ? [record.call] : [],
          ),
          closedToolCalls: [...turn.toolCalls.values()].flatMap((record) =>
            record.state === "closed" ? [record.call] : [],
          ),
          retrying: turn.retrying,
        });
        listed.push(turn);
      } else if (after !== null) {
        endedTurns.push({
          turnId: turn.turnId,
          cause: turn.cause,
          startedAt: turn.startedAt,
          finishedAt: turn.ended.at,
          outcome: turn.ended.outcome,
          backgroundWork: announcesWork(turn),
          continuation: turn.ended.continuation,
          steps,
          work: turn.work,
          contextRecovered: turn.contextRecovered,
        });
        listed.push(turn);
      }
    }
    const steers: Array<SteerSettlement> = listed.flatMap((turn) =>
      turn.ended === null
        ? []
        : turn.steers.flatMap((steer) =>
            steer.state === "read" || steer.state === "dropped"
              ? [{ key: steer.key, turnId: turn.turnId, settlement: steer.state }]
              : [],
          ),
    );
    // Cursors are numbered across every session, so the latest one covers this
    // session's history too.
    const cursor = cursorOf(sequence);
    const queueHeld = session.held && !session.unreportedHold;
    if (queueHeld) session.holdCursors.add(cursor);
    return {
      _tag: "replaced",
      cursor,
      at,
      openTurns,
      openRequests: [...session.requests.values()],
      endedTurns,
      hostSpeech: listed.flatMap((turn) => turn.hostSpeech),
      closedRequests: listed.flatMap((turn) => turn.closedRequests),
      steers,
      delegatedResults: [...session.delegatedResults],
      model: session.model,
      queueHeld,
      stopIgnored: session.stopIgnored,
    };
  };

  const parseCursor = (cursor: EventCursor) => {
    const value = Number(cursor);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  const sameDelivery = (a: Delivery, b: Delivery) =>
    a._tag === "start"
      ? b._tag === "start" && a.freshContext === b.freshContext
      : b._tag === "steer" && a.turnId === b.turnId;

  /**
   * The engine claims the files before it looks at the key. It refuses a text
   * over its input limit too; the server never sends one.
   */
  const claimAttachments = (text: string, attachments: ReadonlyArray<DispatchAttachment>) =>
    Effect.gen(function* () {
      if (engineInputLength(text) > ENGINE_INPUT_LIMIT)
        return yield* misuse("a text over the engine's input limit");
      const now = yield* DateTime.now;
      for (const attachment of attachments) {
        const usableUntil = staged.get(attachment.stagedId);
        if (usableUntil === undefined) return yield* misuse("an attachment that was never staged");
        if (DateTime.isLessThan(usableUntil, now)) {
          return yield* misuse("a staged attachment past its usableUntil");
        }
      }
      if (attachmentLimitViolation(attachments) !== undefined) {
        return yield* misuse("attachments over the engine's limits");
      }
    });

  /** The engine refuses a dispatch while planning it, keeping a rejected receipt. */
  const refuse = (key: IdempotencyKey, sessionId: SessionId) =>
    Effect.sync(() => {
      keys.set(key, { command: "dispatch", sessionId, outcome: "rejected" });
    }).pipe(Effect.andThen(Effect.fail(new DispatchRejected({ key }))));

  /**
   * The engine applies a dispatch it holds no receipt for, unless it would
   * make a turn of its own in a session whose mode is above the ceiling: a
   * start, or a steer too late for its turn. That it refuses keeping nothing
   * for the key. A steer taken into a running turn makes none, and the
   * ceiling lets it through (**Read** at `59651c1`, `DispatchModeLimit.ts`
   * `runtimeModeCeilingRefusal`, which looks only at `run.created` and
   * `run-attempt.created`).
   */
  const applyDispatch = (session: SessionRecord, input: DispatchInput) =>
    Effect.gen(function* () {
      const { key, text, attachments, delivery } = input;
      const at = yield* DateTime.now;
      let disposition: DispatchDisposition;
      if (delivery._tag === "start") {
        const refusal = modeRefusal(session.permissionMode);
        if (Option.isSome(refusal)) return yield* refusal.value;
        disposition = applyStart(session, key, at);
      } else {
        const target = session.turns.get(delivery.turnId);
        if (target !== undefined && session.running === target.turnId) {
          target.steers.push({
            key,
            queuedAhead: [...session.waiting],
            model: session.model,
            state: "unread",
          });
          disposition = { _tag: "steered", turnId: delivery.turnId };
        } else if (target?.ended?.outcome._tag === "completed") {
          // Too late to steer: the engine keeps the message as a turn of its own.
          const refusal = modeRefusal(session.permissionMode);
          if (Option.isSome(refusal)) return yield* refusal.value;
          disposition = {
            _tag: "new-turn",
            turnId: addTurn(session, { _tag: "dispatch", key }, at).turnId,
          };
        } else {
          // A turn waiting behind another, or one that ended any way but
          // completing, cannot be steered (**Read** at `db51b67`,
          // `dispatchSteerIntoRun`): refused while planning, with a receipt.
          return yield* refuse(key, session.id);
        }
      }
      keys.set(key, { command: "dispatch", sessionId: session.id, outcome: "applied" });
      session.dispatches.set(key, { key, text, attachments, delivery, disposition });
      return disposition;
    });

  const engine = Engine.of({
    status: SubscriptionRef.changes(status),
    starts: SubscriptionRef.changes(started).pipe(Stream.changes),

    instance: Effect.suspend(() =>
      reachable
        ? Effect.succeed(EngineInstanceId.make(`engine-${instances}`))
        : Effect.fail(new EngineUnavailable()),
    ),

    connectProviders: (input) =>
      Effect.sync(() => {
        connection = Option.some(input.baseUrl);
        return { _tag: "applied", baseUrl: input.baseUrl } as const;
      }),

    connectedEndpoint: Effect.sync(() => Option.getOrNull(connection)),

    recheckProvider: (providerId) => command(Effect.sync(() => void rechecked.push(providerId))),

    updateProvider: (providerId) => command(Effect.sync(() => void updated.push(providerId))),
    setHarnessExecutable: (input) =>
      door("setHarnessExecutable", command(Effect.sync(() => void executables.push(input)))),

    consoleLink: command(Effect.succeed("http://127.0.0.1/test-engine")),

    linkSharedSkills: Effect.sync(() => void (sharedSkillLinks += 1)),

    linkBotSkills: (workspacePath) => Effect.sync(() => void botSkillLinks.push(workspacePath)),

    ensureProject: ({ workspacePath }) =>
      command(
        Effect.sync(() => {
          const existing = projects.get(workspacePath);
          if (existing !== undefined) return existing;
          const projectId = EngineProjectId.make(newId("project"));
          projects.set(workspacePath, projectId);
          return projectId;
        }),
      ),

    removeProject: (projectId) =>
      command(
        Effect.gen(function* () {
          const at = yield* DateTime.now;
          for (const [path, id] of projects) if (id === projectId) projects.delete(path);
          browserProjects.delete(projectId);
          for (const session of sessions.values()) {
            if (session.projectId === projectId && !session.retired) retire(session, at);
          }
        }),
      ),

    setBrowserAccess: ({ projectId, enabled }) =>
      command(
        Effect.sync(() => {
          if (enabled) browserProjects.add(projectId);
          else browserProjects.delete(projectId);
        }),
      ),

    withdrawBrowserAccess: (projectId) =>
      command(
        Effect.gen(function* () {
          const at = yield* DateTime.now;
          browserProjects.delete(projectId);
          for (const session of sessions.values()) {
            if (session.projectId !== projectId || session.retired) continue;
            // The engine's stop, with no turn cancelled, then the provider
            // session released: its next one starts without the browser.
            if (session.running !== null) stopSession(session, at, []);
            session.browserTools = null;
          }
        }),
      ),

    clearBrowserProfile: command(Effect.sync(() => void browserProfileClears++)),

    openSession: ({ key, projectId, model, permissionMode }) =>
      command(
        Effect.gen(function* () {
          const previous = yield* priorUse(key, "openSession");
          if (previous?.command === "openSession") {
            if (previous.sessionId === null) return yield* new OpenRejected({ key });
            return previous.sessionId;
          }
          if (failingOpenSessions > 0) {
            failingOpenSessions--;
            return yield* new EngineIndeterminate();
          }
          if (refusingOpenSessionModels > 0) {
            refusingOpenSessionModels--;
            return yield* new ModelUnavailable({
              providerId: model.providerId,
              modelId: model.modelId,
            });
          }
          const refusal = modeRefusal(permissionMode);
          if (Option.isSome(refusal)) return yield* refusal.value;
          if (rejectOpenSession) {
            rejectOpenSession = false;
            keys.set(key, { command: "openSession", sessionId: null });
            return yield* new OpenRejected({ key });
          }
          // Named after its key, as the adapter names the engine's thread
          // (`threadIdFor`): no other engine, a fresh one included, gives it.
          const sessionId = SessionId.make(`session-${key}`);
          keys.set(key, { command: "openSession", sessionId });
          sessions.set(sessionId, {
            id: sessionId,
            projectId,
            retired: false,
            model,
            permissionMode,
            browserTools: null,
            log: [],
            replayableFrom: 0,
            turns: new Map(),
            running: null,
            waiting: [],
            held: false,
            unreportedHold: false,
            replacedSessionWorking: false,
            holdCursors: new Set(),
            resumedHolds: new Set(),
            requests: new Map(),
            dispatches: new Map(),
            responses: [],
            rejectedAnswers: [],
            secretAnswers: [],
            delegatedResults: [],
            subscribers: new Map(),
            raceNextStart: null,
            failNextStart: null,
            holdStartup: false,
            heldStartup: null,
            ignoresStops: false,
            stopIgnored: null,
          });
          if (losingOpenSessionReply) {
            losingOpenSessionReply = false;
            return yield* new EngineIndeterminate();
          }
          return sessionId;
        }),
      ),

    configureSession: ({ sessionId, model, permissionMode, reloadTools }) =>
      door(
        "configureSession",
        command(
          Effect.gen(function* () {
            const session = yield* liveSession(sessionId);
            const changesMode =
              permissionMode !== undefined && permissionMode !== session.permissionMode;
            const changesModel =
              model !== undefined &&
              (model.providerId !== session.model.providerId ||
                model.modelId !== session.model.modelId);
            // Only a provider session that started has tools to reload.
            const reloads = reloadTools === true && session.browserTools !== null;
            if (!changesMode && !changesModel && !reloads) return;
            // The adapter's check, before anything is sent.
            if (session.running !== null) {
              return yield* new SessionBusy({ sessionId, turnId: session.running });
            }
            // The adapter's own check: replacing the provider session would
            // end its background work.
            if (reloads && backgroundRuns(session)) {
              return yield* new BackgroundWorkRunning({ sessionId });
            }
            // As for Claude Code, whose permission mode changes only with a new
            // provider session, which the engine will not start over
            // background work.
            if (changesMode && backgroundRuns(session)) {
              return yield* new BackgroundWorkRunning({ sessionId });
            }
            if (model !== undefined) session.model = model;
            if (permissionMode !== undefined && changesMode) {
              const refusal = modeRefusal(permissionMode);
              if (Option.isSome(refusal)) return yield* refusal.value;
            }
            if (permissionMode !== undefined) session.permissionMode = permissionMode;
            if (reloads) session.browserTools = null;
          }),
        ),
      ),

    retireSession: (sessionId) =>
      command(
        Effect.gen(function* () {
          const session = sessions.get(sessionId);
          if (session === undefined || session.retired) return;
          if (rejectingRetirements > 0) {
            rejectingRetirements--;
            return yield* new RetireRejected({ sessionId });
          }
          retire(session, yield* DateTime.now);
        }),
      ),

    dispatch: (input) =>
      door(
        "dispatch",
        command(
          Effect.gen(function* () {
            yield* unbroken;
            const { key, sessionId, delivery } = input;
            yield* claimAttachments(input.text, input.attachments);
            if (keys.has(key)) {
              return yield* misuse(`dispatch key ${key} sent again without redispatch`);
            }
            // The adapter's checks, before anything is sent.
            const session = yield* liveSession(sessionId);
            if (delivery._tag === "start") {
              const busyWith = session.running ?? session.waiting[0];
              if (busyWith !== undefined) {
                return yield* new SessionBusy({ sessionId, turnId: busyWith });
              }
            }
            yield* startupQueue(input);
            if (rejectDispatch) {
              rejectDispatch = false;
              return yield* refuse(key, sessionId);
            }
            return yield* applyDispatch(session, input);
          }),
        ),
      ),

    redispatch: (input) =>
      door(
        "redispatch",
        command(
          Effect.gen(function* () {
            yield* unbroken;
            const { key, sessionId, text, delivery } = input;
            // Staged ids may be fresh on a resend; the rest must match.
            yield* claimAttachments(input.text, input.attachments);
            yield* startupQueue(input);
            const previous = yield* priorUse(key, "dispatch");
            if (previous?.command === "dispatch") {
              if (previous.sessionId !== sessionId) {
                return yield* misuse(`dispatch key ${key} sent to a second session`);
              }
              if (previous.outcome === "rejected") return yield* new DispatchRejected({ key });
              const first = sessions.get(sessionId)?.dispatches.get(key);
              if (
                first !== undefined &&
                (first.text !== text || !sameDelivery(first.delivery, delivery))
              ) {
                return yield* misuse(`dispatch key ${key} repeated with another input`);
              }
              return;
            }
            // No local check: the engine plans the command itself.
            const session = sessions.get(sessionId);
            if (session === undefined || session.retired) {
              // An inactive thread is refused while planning, with a rejected receipt.
              return yield* refuse(key, sessionId);
            }
            if (rejectDispatch) {
              rejectDispatch = false;
              return yield* refuse(key, sessionId);
            }
            yield* applyDispatch(session, input);
          }),
        ),
      ),

    stageAttachment: () =>
      door(
        "stageAttachment",
        command(
          Effect.gen(function* () {
            const id = EngineAttachmentId.make(newId("attachment"));
            const usableUntil = DateTime.addDuration(yield* DateTime.now, STAGED_USABLE_FOR);
            staged.set(id, usableUntil);
            return { id, usableUntil };
          }),
        ),
      ),

    stop: ({ key, sessionId }) =>
      door(
        "stop",
        command(
          Effect.gen(function* () {
            const previous = yield* priorUse(key, "stop");
            const refuse = previous?.command === "stop" && previous.outcome === "rejected";
            if (previous !== undefined && !refuse) return;
            const session = yield* liveSession(sessionId);
            if (refuse || rejectStop) {
              rejectStop = false;
              keys.set(key, { command: "stop", outcome: "rejected" });
              if (stoppable(session)) return yield* new StopRejected({ key });
              return;
            }
            keys.set(key, { command: "stop", outcome: "applied" });
            const during = turnDuringStop?.sessionId === sessionId ? turnDuringStop : null;
            if (during !== null) {
              turnDuringStop = null;
              const at = yield* DateTime.now;
              stopSession(session, at, [...session.waiting]);
              const turn = addTurn(session, { _tag: "background", origin: null }, at);
              yield* Deferred.succeed(during.started, turn.turnId);
              return yield* Deferred.await(during.reply);
            }
            const delayed = stopEffects;
            stopEffects = null;
            const cancels = [...session.waiting];
            // The engine answers first; the stop takes effect after.
            yield* Effect.forkDetach(
              (delayed === null ? Effect.yieldNow : Deferred.await(delayed)).pipe(
                Effect.andThen(DateTime.now),
                Effect.map((at) => stopSession(session, at, cancels)),
              ),
            );
          }),
        ),
      ),

    forceStop: ({ sessionId, turnId }) =>
      door(
        "forceStop",
        command(
          Effect.gen(function* () {
            const session = yield* liveSession(sessionId);
            forcedStops.push({ sessionId, turnId });
            forceStopSession(session, turnId, yield* DateTime.now);
          }),
        ),
      ),

    resumeQueue: ({ sessionId, hold }) =>
      door(
        "resumeQueue",
        command(
          Effect.gen(function* () {
            const session = yield* liveSession(sessionId);
            if (!session.holdCursors.has(hold)) return yield* misuse(`no hold at ${hold}`);
            if (session.resumedHolds.has(hold)) return;
            session.resumedHolds.add(hold);
            if (!session.held) return;
            if (session.replacedSessionWorking) {
              // Held again in answer, and not reported until the work ends.
              session.unreportedHold = true;
              return;
            }
            session.held = false;
            startNext(session, yield* DateTime.now);
          }),
        ),
      ),

    respond: ({ key, sessionId, requestId, response }) =>
      command(
        Effect.gen(function* () {
          const previous = yield* priorUse(key, "respond");
          if (previous?.command === "respond" && previous.outcome === "applied") return;
          const session = yield* liveSession(sessionId);
          const open = session.requests.get(requestId);
          // A refusal while planning keeps a rejected receipt, which every resend finds.
          const rejected = () => {
            keys.set(key, { command: "respond", outcome: "rejected" });
            session.rejectedAnswers.push(requestId);
            return open === undefined
              ? new RequestClosed({ requestId })
              : new AnswerRejected({ key, requestId });
          };
          if (previous?.command === "respond") return yield* rejected();
          if (open === undefined) return yield* new RequestClosed({ requestId });
          const fits =
            open.request._tag === "approval"
              ? response._tag === "approval"
              : open.request._tag === "question" && response._tag === "question";
          if (!fits) return yield* misuse(`${response._tag} answer to a ${open.request._tag}`);
          if (rejectAnswer) {
            rejectAnswer = false;
            return yield* rejected();
          }
          keys.set(key, { command: "respond", outcome: "applied" });
          session.responses.push({ requestId, response });
          closeRequest(session, open, "answered", yield* DateTime.now);
        }),
      ),

    respondSecret: ({ sessionId, requestId, answer }) =>
      door(
        "respondSecret",
        command(
          Effect.gen(function* () {
            const session = yield* liveSession(sessionId);
            const open = session.requests.get(requestId);
            if (open === undefined || open.request._tag !== "secret") {
              return yield* new RequestClosed({ requestId });
            }
            session.secretAnswers.push({ requestId, answer });
            closeRequest(
              session,
              open,
              answer._tag === "provide" ? "provided" : "declined",
              yield* DateTime.now,
            );
          }),
        ),
      ),

    events: ({ sessionId, after }) =>
      Stream.callback<SessionEvent, SessionNotFound>((queue) =>
        Effect.gen(function* () {
          const session = sessions.get(sessionId);
          if (session === undefined || session.retired) {
            return yield* new SessionNotFound({ sessionId });
          }
          // Read the history and join the live feed in one step, so no event
          // falls between them.
          const join = Effect.gen(function* () {
            const at = yield* DateTime.now;
            const from = after === null ? null : parseCursor(after);
            let lastCursor = after ?? cursorOf(0);
            if (from === null || from < session.replayableFrom) {
              const replaced = replacement(session, from, at);
              lastCursor = replaced.cursor;
              Queue.offerUnsafe(queue, replaced);
            } else {
              for (const entry of session.log) {
                if (entry.sequence <= from) continue;
                lastCursor = entry.event.cursor;
                Queue.offerUnsafe(queue, entry.event);
              }
            }
            session.subscribers.set(queue, { lastCursor });
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => session.subscribers.delete(queue)));
          const held = withheld.get(sessionId);
          if (held === undefined) return yield* join;
          // Stalled: it joins only once the test releases it.
          yield* Effect.forkScoped(Deferred.await(held).pipe(Effect.andThen(join)));
        }),
      ),

    suggestedReplies: (sessionId) =>
      SubscriptionRef.changes(suggestions).pipe(
        Stream.map((current) => current.get(sessionId) ?? null),
        Stream.changes,
      ),

    synchronize: ({ sessionId, token }) =>
      door(
        "synchronize",
        command(
          Effect.gen(function* () {
            const session = yield* liveSession(sessionId);
            const at = yield* DateTime.now;
            const dropped = droppedMarker;
            droppedMarker = null;
            if (dropped !== null) return yield* Deferred.succeed(dropped, undefined);
            // Every event is handed to the streams as it happens, so each stream
            // is already caught up: the marker follows what it was last given.
            // The TestEngine knows every tool's persistence: its work is never in doubt.
            const left =
              session.running === null ? [...session.turns.values()].filter(leftWork) : [];
            const backgroundWork: BackgroundWork = {
              turns: left.map((turn) => turn.turnId),
              unattributed: false,
              stoppable: left.some((turn) => turn.background),
            };
            // The running turn, also one whose provider turn has not started, and those waiting.
            const runnableTurns =
              session.running === null
                ? [...session.waiting]
                : [session.running, ...session.waiting];
            for (const [subscriber, state] of session.subscribers) {
              offer(session, subscriber, {
                _tag: "synchronized",
                cursor: state.lastCursor,
                at,
                token,
                backgroundWork,
                runnableTurns,
              });
            }
            // Tool calls the engine records late appear only after this marker.
            const running =
              session.running === null ? undefined : session.turns.get(session.running);
            if (running === undefined) return;
            for (const record of running.toolCalls.values()) {
              if (record.state !== "unrecorded") continue;
              record.state = "open";
              emit(session, at, (stamp) => ({
                _tag: "tool-call",
                ...stamp,
                turnId: running.turnId,
                call: record.call,
                state: "open",
              }));
            }
          }),
        ),
      ),
  });

  const setReachable = (value: boolean) =>
    Effect.gen(function* () {
      const restarted = value && !reachable;
      if (restarted) start++;
      if (restarted) yield* SubscriptionRef.set(suggestions, new Map());
      reachable = value;
      if (restarted && startNoticeHeld === "next") {
        startNoticeHeld = "held";
      } else if (startNoticeHeld !== "held") {
        yield* noticeStart;
      }
      yield* SubscriptionRef.update(status, (current): EngineStatus => ({
        ...current,
        state: value ? { _tag: "ready" } : { _tag: "unavailable", reason: "down" },
      }));
    });

  const control = TestEngineControl.of({
    providerConnection: Effect.sync(() => connection),
    recheckedProviders: Effect.sync(() => [...rechecked]),
    sharedSkillLinks: Effect.sync(() => sharedSkillLinks),
    botSkillLinks: Effect.sync(() => [...botSkillLinks]),
    updatedProviders: Effect.sync(() => [...updated]),
    harnessExecutables: Effect.sync(() => [...executables]),

    setReachable,

    startFresh: Effect.gen(function* () {
      yield* setReachable(false);
      instances++;
      projects.clear();
      browserProjects.clear();
      sessions.clear();
      keys.clear();
      staged.clear();
      yield* setReachable(true);
    }),

    holdNextStartNotice: Effect.sync(() => {
      startNoticeHeld = "next";
      return {
        release: Effect.suspend(() => {
          startNoticeHeld = null;
          return noticeStart;
        }),
      };
    }),

    suggestReply: ({ sessionId, reply }) =>
      SubscriptionRef.update(suggestions, (current) => {
        const next = new Map(current);
        if (reply === null) next.delete(sessionId);
        else next.set(sessionId, reply);
        return next;
      }),

    loseNextReply: Effect.sync(() => {
      loseReply = true;
    }),

    holdNext: (method) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        holds.set(method, { entered, release });
        return {
          entered: Deferred.await(entered),
          release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
        };
      }),

    holdNextAnswer: (method) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        answerHolds.set(method, { entered, release });
        return {
          entered: Deferred.await(entered),
          release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
        };
      }),

    withholdEvents: (sessionId) =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        withheld.set(sessionId, release);
        return {
          release: Effect.sync(() => withheld.delete(sessionId)).pipe(
            Effect.andThen(Deferred.succeed(release, undefined)),
            Effect.andThen(Effect.yieldNow),
            Effect.asVoid,
          ),
        };
      }),

    stallEvents: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        stalled.set(session.id, []);
        return {
          release: Effect.sync(() => {
            const backlog = stalled.get(session.id) ?? [];
            stalled.delete(session.id);
            for (const given of backlog) given();
          }).pipe(Effect.andThen(Effect.yieldNow)),
        };
      }),

    breakDispatches: (broken) =>
      Effect.sync(() => {
        brokenDispatches = broken;
      }),

    delayNextStopEffects: Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      stopEffects = release;
      return {
        release: Deferred.succeed(release, undefined).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.asVoid,
        ),
      };
    }),

    deferNextDispatch: Effect.gen(function* () {
      const land = yield* Deferred.make<void>();
      deferNext = land;
      return {
        land: Deferred.succeed(land, undefined).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.asVoid,
        ),
      };
    }),

    rejectNextDispatch: Effect.sync(() => {
      rejectDispatch = true;
    }),

    rejectNextAnswer: Effect.sync(() => {
      rejectAnswer = true;
    }),

    failNextOpenSessions: (count) =>
      Effect.sync(() => {
        failingOpenSessions = count;
      }),

    loseNextOpenSessionReply: Effect.sync(() => {
      losingOpenSessionReply = true;
    }),

    refuseNextOpenSessionModels: (count) =>
      Effect.sync(() => {
        refusingOpenSessionModels = count;
      }),

    rejectNextOpenSession: Effect.sync(() => {
      rejectOpenSession = true;
    }),

    limitPermissionModes: (ceiling) =>
      Effect.sync(() => {
        modeCeiling = ceiling;
      }),

    modeRefusals: Effect.sync(() => modeRefusals),

    rejectNextRetirements: (count) =>
      Effect.sync(() => {
        rejectingRetirements = count;
      }),

    openedSessions: Effect.sync(() => [...sessions.keys()]),

    sessionModel: (sessionId) =>
      Effect.suspend(() => {
        const session = sessions.get(sessionId);
        return session === undefined
          ? misuse(`no session ${sessionId}`)
          : Effect.succeed(session.model);
      }),

    sessionPermissionMode: (sessionId) =>
      Effect.suspend(() => {
        const session = sessions.get(sessionId);
        return session === undefined
          ? misuse(`no session ${sessionId}`)
          : Effect.succeed(session.permissionMode);
      }),

    sessionBrowserTools: (sessionId) =>
      Effect.suspend(() => {
        const session = sessions.get(sessionId);
        return session === undefined
          ? misuse(`no session ${sessionId}`)
          : Effect.succeed(session.browserTools ?? browserProjects.has(session.projectId));
      }),

    browserProfileClears: Effect.sync(() => browserProfileClears),

    rejectNextStop: Effect.sync(() => {
      rejectStop = true;
    }),

    ignoreStops: (sessionId) =>
      Effect.map(existingSession(sessionId), (session) => {
        session.ignoresStops = true;
      }),

    forcedStops: Effect.sync(() => [...forcedStops]),

    retry: ({ sessionId, turnId, retrying }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        if (turn.retrying === retrying) return;
        turn.retrying = retrying;
        emit(session, yield* DateTime.now, (stamp) => ({
          _tag: "turn-retrying",
          ...stamp,
          turnId,
          retrying,
        }));
      }),

    holdNextStartup: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.holdStartup = true;
        return {
          release: Effect.gen(function* () {
            const turnId = session.heldStartup;
            session.heldStartup = null;
            const turn = turnId === null ? undefined : session.turns.get(turnId);
            if (turn === undefined || turn.ended !== null) return;
            beginTurn(session, turn, yield* DateTime.now);
          }),
        };
      }),

    startEngineTurnDuringNextDispatch: (sessionId, origin = null) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.raceNextStart = { origin };
      }),

    dropNextMarker: Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      droppedMarker = requested;
      return { requested: Deferred.await(requested) };
    }),

    withholdNextSteerSettlements: Effect.sync(() => {
      const withheld: Array<WithheldSteer> = [];
      withholding = withheld;
      return {
        release: Effect.gen(function* () {
          const at = yield* DateTime.now;
          for (const { session, turnId, steer, read } of withheld.splice(0)) {
            steer.state = read ? "read" : "dropped";
            emit(session, at, (stamp) => ({
              _tag: read ? "steered" : "steer-dropped",
              ...stamp,
              key: steer.key,
              turnId,
            }));
          }
        }),
      };
    }),

    startEngineTurnDuringNextStop: (sessionId) =>
      Effect.gen(function* () {
        yield* existingSession(sessionId);
        const started = yield* Deferred.make<TurnId>();
        const reply = yield* Deferred.make<void>();
        turnDuringStop = { sessionId, started, reply };
        return {
          started: Deferred.await(started),
          reply: Deferred.succeed(reply, undefined).pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.asVoid,
          ),
        };
      }),

    holdQueue: ({ sessionId, heldAgainOnResume }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        if (session.waiting.length === 0) return yield* misuse("a hold with no turn waiting");
        session.replacedSessionWorking = heldAgainOnResume;
        holdWaiting(session, yield* DateTime.now);
      }),

    endReplacedSessionWork: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.replacedSessionWorking = false;
        if (!session.unreportedHold) return;
        session.unreportedHold = false;
        session.held = false;
        holdWaiting(session, yield* DateTime.now);
      }),

    failNextStart: ({ sessionId, failure }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.failNextStart = failure;
      }),

    step: ({ sessionId, turnId, step }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        turn.steps.set(step.id, step);
        emit(session, yield* DateTime.now, (stamp) => ({ _tag: "step", ...stamp, turnId, step }));
      }),

    turnWork: ({ sessionId, turnId, work }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = session.turns.get(turnId);
        if (turn === undefined || turn.startedAt === null) {
          return yield* misuse(`turn ${turnId} has not started`);
        }
        turn.work = work;
        emit(session, yield* DateTime.now, (stamp) => ({
          _tag: "turn-work",
          ...stamp,
          turnId,
          work,
        }));
      }),

    readSteers: ({ sessionId, turnId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        const at = yield* DateTime.now;
        for (const steer of turn.steers) {
          if (steer.state !== "unread") continue;
          steer.state = "read";
          emit(session, at, (stamp) => ({ _tag: "steer-taken", ...stamp, key: steer.key, turnId }));
        }
      }),

    toolCall: ({ sessionId, turnId, tool, input, recorded }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        const call: ToolCall = {
          callId: ToolCallId.make(newId("call")),
          tool,
          inputDigest: yield* toolInputDigest(input),
        };
        if (recorded === "now") {
          turn.toolCalls.set(call.callId, { call, state: "open" });
          emit(session, yield* DateTime.now, (stamp) => ({
            _tag: "tool-call",
            ...stamp,
            turnId,
            call,
            state: "open",
          }));
        } else {
          turn.toolCalls.set(call.callId, { call, state: "unrecorded" });
        }
        return call.callId;
      }),

    recordToolInput: ({ sessionId, turnId, callId, input }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        const record = turn.toolCalls.get(callId);
        if (record?.state !== "open") return yield* misuse(`tool call ${callId} is not open`);
        record.call = { ...record.call, inputDigest: yield* toolInputDigest(input) };
        const call = record.call;
        emit(session, yield* DateTime.now, (stamp) => ({
          _tag: "tool-call",
          ...stamp,
          turnId,
          call,
          state: "open",
        }));
      }),

    closeToolCall: ({ sessionId, turnId, callId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        const record = turn.toolCalls.get(callId);
        if (record?.state !== "open") return yield* misuse(`tool call ${callId} is not open`);
        record.state = "closed";
        emit(session, yield* DateTime.now, (stamp) => ({
          _tag: "tool-call",
          ...stamp,
          turnId,
          call: record.call,
          state: "closed",
        }));
      }),

    openRequest: ({ sessionId, turnId, request, heldCall }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        yield* runningTurn(session, turnId);
        const at = yield* DateTime.now;
        const open: OpenRequest = {
          requestId: RequestId.make(newId("request")),
          turnId,
          openedAt: at,
          request,
          heldCall: heldCall ?? null,
        };
        session.requests.set(open.requestId, open);
        emit(session, at, (stamp) => ({ _tag: "request-opened", ...stamp, open }));
        return open.requestId;
      }),

    updateRequest: ({ sessionId, requestId, request }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const open = session.requests.get(requestId);
        if (open === undefined) return yield* misuse(`request ${requestId} is not open`);
        const at = yield* DateTime.now;
        session.requests.set(requestId, { ...open, request });
        emit(session, at, (stamp) => ({
          _tag: "request-updated",
          ...stamp,
          requestId,
          turnId: open.turnId,
          request,
          heldCall: open.heldCall,
        }));
      }),

    hostSpeech: ({ sessionId, turnId, text }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        const at = yield* DateTime.now;
        const speech: HostSpeech = {
          speechId: HostSpeechId.make(newId("speech")),
          turnId,
          text,
          at,
        };
        turn.hostSpeech.push(speech);
        emit(session, at, (stamp) => ({
          _tag: "host-speech",
          ...stamp,
          speechId: speech.speechId,
          turnId,
          text,
        }));
        return speech.speechId;
      }),

    startBackgroundWork: ({ sessionId, turnId, stoppable = true, announced = true }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        if (stoppable) {
          turn.background = true;
          turn.unannounced = !announced;
        } else turn.unstoppable = true;
      }),

    recoverContext: ({ sessionId, turnId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        turn.contextRecovered = true;
      }),

    endBackgroundWork: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        for (const turn of session.turns.values()) {
          turn.background = false;
          turn.unstoppable = false;
        }
      }),

    backgroundWorkRunning: (sessionId) => Effect.map(existingSession(sessionId), backgroundRuns),

    finishTurn: ({ sessionId, turnId, outcome, continuation }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        if (continuation !== undefined && outcome._tag !== "failed") {
          return yield* misuse("a continuation for a turn that did not fail");
        }
        endTurn(session, turn, outcome, yield* DateTime.now, "other", continuation ?? null);
      }),

    resumeContinuation: ({ sessionId, turnId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = session.turns.get(turnId);
        if (turn?.ended == null || turn.ended.continuation === null) {
          return yield* misuse(`turn ${turnId} has no pending continuation`);
        }
        turn.ended.continuation = null;
        return addTurn(session, { _tag: "continuation", turnId }, yield* DateTime.now).turnId;
      }),

    dropContinuation: ({ sessionId, turnId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = session.turns.get(turnId);
        if (turn?.ended == null || turn.ended.continuation === null) {
          return yield* misuse(`turn ${turnId} has no pending continuation`);
        }
        dropContinuation(session, turn, yield* DateTime.now);
      }),

    delegatedResult: ({ sessionId, turnId, origin, text }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        const result: DelegatedResult = {
          resultId: DelegatedResultId.make(newId("result")),
          turnId,
          origin,
          text,
        };
        turn.landed.push(result);
        return result.resultId;
      }),

    startEngineTurn: (sessionId, origin = null) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        return addTurn(session, { _tag: "background", origin }, yield* DateTime.now).turnId;
      }),

    pruneHistory: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.replayableFrom = sequence;
        session.log.length = 0;
      }),

    loseSession: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.retired = true;
        endStreams(session);
      }),

    openStreams: (sessionId) => Effect.sync(() => sessions.get(sessionId)?.subscribers.size ?? 0),

    archiveSession: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        archive(session, yield* DateTime.now);
      }),

    dispatches: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.dispatches.values()])),

    responses: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.responses])),

    rejectedAnswers: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.rejectedAnswers])),

    secretAnswers: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.secretAnswers])),
  });

  return Context.make(Engine, engine).pipe(Context.add(TestEngineControl, control));
});

/** An in-memory `Engine` and the `TestEngineControl` that drives it. */
export const layer: Layer.Layer<Engine | TestEngineControl> = Layer.effectContext(make);
