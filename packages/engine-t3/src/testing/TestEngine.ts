// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  EngineStatus,
  FailureClass,
  ModelChoice,
  PermissionMode,
  WorkStep,
  WorkStepId,
} from "@j3-bots/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { attachmentLimitViolation } from "../attachments.ts";
import {
  Engine,
  type DispatchAttachment,
  type DispatchDisposition,
  type DispatchInput,
  type Delivery,
  type RequestResponse,
  type SecretAnswer,
} from "../Engine.ts";
import {
  DispatchRejected,
  EngineIndeterminate,
  EngineUnavailable,
  ProjectNotFound,
  RequestClosed,
  SessionBusy,
  SessionNotFound,
} from "../errors.ts";
import type {
  EndedTurn,
  EngineRequest,
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
} from "../events.ts";
import {
  EngineAttachmentId,
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
// resume; turns that fail before they start; `j3` tool calls the engine records
// after the bridge sees them; usage-limit continuations; requests that expire
// with their turn, and whose card can change while they are open; host
// speech; replies lost after a command was applied; staged files that expire;
// calls held in flight, a Stop whose effects lag its acknowledgment and a
// dispatch that waits in the startup queue and lands late; synchronization
// markers; and resume by cursor with
// replay or a replacement that repeats turns already seen end, as the real
// engine may. The adapter's conformance suite runs the same scenarios against
// the real engine, which keeps this double honest.

/** The engine methods a test can hold in flight with `holdNext`. */
export type HeldMethod = "dispatch" | "redispatch" | "stageAttachment" | "respondSecret" | "stop";

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
    /** While false, every command fails with `EngineUnavailable` and applies nothing. */
    readonly setReachable: (reachable: boolean) => Effect.Effect<void>;
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
     * The next `stop` is acknowledged at once, and its effects (the interrupt,
     * the cancels, the disarmed continuation) wait until `release`, as when
     * the provider's interrupt is slow.
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
     * Background work wakes the session while the next `start` dispatch is on
     * its way: the adapter's busy check passes, and the engine then queues the
     * start behind that turn.
     */
    readonly startEngineTurnDuringNextDispatch: (sessionId: SessionId) => Effect.Effect<void>;
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
      readonly step: WorkStep;
    }) => Effect.Effect<void>;
    /**
     * The agent takes every steer of the running turn. Each settles as
     * `steered` when the turn ends.
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
    /** A `j3` tool call returns. */
    readonly closeToolCall: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly callId: ToolCallId;
    }) => Effect.Effect<void>;
    /** The turn holds on the operator. */
    readonly openRequest: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly request: EngineRequest;
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
    /** The turn leaves background work running when it ends. */
    readonly startBackgroundWork: (input: {
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
     * once, or after the running one.
     */
    readonly startEngineTurn: (sessionId: SessionId) => Effect.Effect<TurnId>;
    /** Forgets the session's event history, so a resume from any cursor gets a `replaced`. */
    readonly pruneHistory: (sessionId: SessionId) => Effect.Effect<void>;
    /**
     * The engine loses the session, as when its data is deleted: its streams
     * end with `SessionNotFound`, and so does every command for it.
     */
    readonly loseSession: (sessionId: SessionId) => Effect.Effect<void>;
    readonly dispatches: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ReceivedDispatch>>;
    readonly responses: (
      sessionId: SessionId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly requestId: RequestId; readonly response: RequestResponse }>
    >;
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
  state: "unread" | "read" | "dropped" | "requeued";
}

interface ToolCallRecord {
  readonly call: ToolCall;
  state: "unrecorded" | "open" | "closed";
}

interface TurnRecord {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
  startedAt: DateTime.Utc | null;
  readonly steps: Map<WorkStepId, WorkStep>;
  readonly steers: Array<SteerRecord>;
  readonly toolCalls: Map<ToolCallId, ToolCallRecord>;
  readonly hostSpeech: Array<HostSpeech>;
  readonly closedRequests: Array<{
    readonly requestId: RequestId;
    readonly turnId: TurnId;
    readonly resolution: RequestResolution;
  }>;
  backgroundWork: boolean;
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
  readonly secretAnswers: Array<{ readonly requestId: RequestId; readonly answer: SecretAnswer }>;
  /** Each open stream, with the cursor of the last event it was given. */
  readonly subscribers: Map<Subscriber, { lastCursor: EventCursor }>;
  /** Set by `startEngineTurnDuringNextDispatch`. */
  raceNextStart: boolean;
  /** Set by `failNextStart`. */
  failNextStart: FailureClass | null;
}

type AppliedKey =
  | { readonly command: "openSession"; readonly sessionId: SessionId }
  | {
      readonly command: "dispatch";
      readonly sessionId: SessionId;
      readonly outcome: "applied" | "rejected";
    }
  | { readonly command: "stop" | "respond" };

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
  let loseReply = false;
  let rejectDispatch = false;
  const holds = new Map<
    HeldMethod,
    { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  >();
  let stopEffects: Deferred.Deferred<void> | null = null;
  let deferNext: Deferred.Deferred<void> | null = null;
  /** Dispatches waiting in the startup queue, by key, until they land. */
  const deferred = new Map<IdempotencyKey, Deferred.Deferred<void>>();
  // One counter for every session, as the real engine numbers its events.
  let sequence = 0;
  let nextId = 0;
  const projects = new Map<string, EngineProjectId>();
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

  /** Waits at the door when the test holds the next call of `method`. */
  const door = <A, E, R>(method: HeldMethod, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const hold = holds.get(method);
      if (hold === undefined) return effect;
      holds.delete(method);
      return Deferred.succeed(hold.entered, undefined).pipe(
        Effect.andThen(Deferred.await(hold.release)),
        Effect.andThen(effect),
      );
    });

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

  const deliver = (session: SessionRecord, event: SessionEvent) => {
    for (const [subscriber, state] of session.subscribers) {
      state.lastCursor = event.cursor;
      Queue.offerUnsafe(subscriber, event);
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

  const newTurn = (session: SessionRecord, cause: TurnCause): TurnRecord => {
    const turn: TurnRecord = {
      turnId: TurnId.make(newId("turn")),
      cause,
      startedAt: null,
      steps: new Map(),
      steers: [],
      toolCalls: new Map(),
      hostSpeech: [],
      closedRequests: [],
      backgroundWork: false,
      ended: null,
    };
    session.turns.set(turn.turnId, turn);
    return turn;
  };

  const closeRequest = (
    session: SessionRecord,
    open: OpenRequest,
    resolution: RequestResolution,
    at: DateTime.Utc,
  ) => {
    session.requests.delete(open.requestId);
    session.turns
      .get(open.turnId)
      ?.closedRequests.push({ requestId: open.requestId, turnId: open.turnId, resolution });
    emit(session, at, (stamp) => ({
      _tag: "request-closed",
      ...stamp,
      requestId: open.requestId,
      turnId: open.turnId,
      resolution,
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
   * the queue is not held. The newer turn takes the place of any pending
   * continuation, which no longer resumes the session's latest turn.
   */
  const addTurn = (session: SessionRecord, cause: TurnCause, at: DateTime.Utc) => {
    for (const turn of session.turns.values()) dropContinuation(session, turn, at);
    const turn = newTurn(session, cause);
    session.waiting.push(turn.turnId);
    startNext(session, at);
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
    for (const steer of turn.steers) {
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
        const followUp = newTurn(session, { _tag: "dispatch", key: steer.key });
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
    turn.ended = { outcome, at, continuation };
    emit(session, at, (stamp) => ({
      _tag: "turn-finished",
      ...stamp,
      turnId: turn.turnId,
      cause: turn.cause,
      outcome,
      backgroundWork: turn.backgroundWork,
      continuation,
    }));
    for (const settlement of settlements) emit(session, at, settlement);
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
    if (session.failNextStart !== null) {
      const failure = session.failNextStart;
      session.failNextStart = null;
      endTurn(session, turn, { _tag: "failed", failure, retryAt: null }, at, "other");
      return;
    }
    turn.startedAt = at;
    emit(session, at, (stamp) => ({
      _tag: "turn-started",
      ...stamp,
      turnId: turn.turnId,
      cause: turn.cause,
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
    if (session.raceNextStart) {
      session.raceNextStart = false;
      addTurn(session, { _tag: "background" }, at);
    }
    const turn = addTurn(session, { _tag: "dispatch", key }, at);
    return session.waiting.includes(turn.turnId)
      ? { _tag: "queued", turnId: turn.turnId }
      : { _tag: "started", turnId: turn.turnId };
  };

  /**
   * Stop as it takes effect, after `stop` returned: the engine's own stop holds
   * the queue and disarms a pending continuation, each waiting turn is
   * cancelled (taken off the queue first: cancelling one starts no other), the
   * provider's interrupt ends the running turn, and the background work every
   * turn left running ends, also in a session whose last turn already ended.
   */
  const stopSession = (session: SessionRecord, at: DateTime.Utc) => {
    for (const turn of session.turns.values()) turn.backgroundWork = false;
    holdWaiting(session, at);
    for (const turn of session.turns.values()) dropContinuation(session, turn, at);
    for (const turnId of session.waiting.splice(0)) {
      const turn = session.turns.get(turnId);
      if (turn !== undefined) endTurn(session, turn, { _tag: "cancelled" }, at, "stop");
    }
    clearEmptyHold(session);
    const running = session.running === null ? undefined : session.turns.get(session.running);
    if (running !== undefined) {
      endTurn(session, running, { _tag: "interrupted" }, at, "stop");
    }
  };

  const retire = (session: SessionRecord, at: DateTime.Utc) => {
    stopSession(session, at);
    session.retired = true;
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
          steps,
          toolCalls: [...turn.toolCalls.values()].flatMap((record) =>
            record.state === "open" ? [record.call] : [],
          ),
        });
        listed.push(turn);
      } else if (after !== null) {
        endedTurns.push({
          turnId: turn.turnId,
          cause: turn.cause,
          startedAt: turn.startedAt,
          finishedAt: turn.ended.at,
          outcome: turn.ended.outcome,
          backgroundWork: turn.backgroundWork,
          continuation: turn.ended.continuation,
          steps,
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
      queueHeld,
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

  /** The engine claims the files before it looks at the key. */
  const claimAttachments = (attachments: ReadonlyArray<DispatchAttachment>) =>
    Effect.gen(function* () {
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

  /** The engine applies a dispatch it holds no receipt for. */
  const applyDispatch = (session: SessionRecord, input: DispatchInput) =>
    Effect.gen(function* () {
      const { key, text, attachments, delivery } = input;
      const at = yield* DateTime.now;
      let disposition: DispatchDisposition;
      if (delivery._tag === "start") {
        disposition = applyStart(session, key, at);
      } else {
        const target = session.turns.get(delivery.turnId);
        if (target !== undefined && session.running === target.turnId) {
          target.steers.push({ key, queuedAhead: [...session.waiting], state: "unread" });
          disposition = { _tag: "steered", turnId: delivery.turnId };
        } else if (target?.ended?.outcome._tag === "completed") {
          // Too late to steer: the engine keeps the message as a turn of its own.
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

    consoleLink: command(Effect.succeed("http://127.0.0.1/test-engine")),

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
          for (const session of sessions.values()) {
            if (session.projectId === projectId && !session.retired) retire(session, at);
          }
        }),
      ),

    openSession: ({ key, projectId, model, permissionMode }) =>
      command(
        Effect.gen(function* () {
          const previous = yield* priorUse(key, "openSession");
          if (previous?.command === "openSession") return previous.sessionId;
          if (![...projects.values()].includes(projectId)) {
            return yield* new ProjectNotFound({ projectId });
          }
          const sessionId = SessionId.make(newId("session"));
          keys.set(key, { command: "openSession", sessionId });
          sessions.set(sessionId, {
            id: sessionId,
            projectId,
            retired: false,
            model,
            permissionMode,
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
            secretAnswers: [],
            subscribers: new Map(),
            raceNextStart: false,
            failNextStart: null,
          });
          return sessionId;
        }),
      ),

    configureSession: ({ sessionId, model, permissionMode }) =>
      command(
        Effect.gen(function* () {
          const session = yield* liveSession(sessionId);
          if (model !== undefined) session.model = model;
          if (permissionMode !== undefined) session.permissionMode = permissionMode;
        }),
      ),

    retireSession: (sessionId) =>
      command(
        Effect.gen(function* () {
          const session = sessions.get(sessionId);
          if (session === undefined || session.retired) return;
          retire(session, yield* DateTime.now);
        }),
      ),

    dispatch: (input) =>
      door(
        "dispatch",
        command(
          Effect.gen(function* () {
            const { key, sessionId, delivery } = input;
            yield* claimAttachments(input.attachments);
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
            const { key, sessionId, text, delivery } = input;
            // Staged ids may be fresh on a resend; the rest must match.
            yield* claimAttachments(input.attachments);
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
            if ((yield* priorUse(key, "stop")) !== undefined) return;
            const session = yield* liveSession(sessionId);
            keys.set(key, { command: "stop" });
            const delayed = stopEffects;
            stopEffects = null;
            // The engine answers first; the stop takes effect after.
            yield* Effect.forkDetach(
              (delayed === null ? Effect.yieldNow : Deferred.await(delayed)).pipe(
                Effect.andThen(DateTime.now),
                Effect.map((at) => stopSession(session, at)),
              ),
            );
          }),
        ),
      ),

    resumeQueue: ({ sessionId, hold }) =>
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

    respond: ({ key, sessionId, requestId, response }) =>
      command(
        Effect.gen(function* () {
          if ((yield* priorUse(key, "respond")) !== undefined) return;
          const session = yield* liveSession(sessionId);
          const open = session.requests.get(requestId);
          if (open === undefined) return yield* new RequestClosed({ requestId });
          const fits =
            open.request._tag === "approval"
              ? response._tag === "approval"
              : open.request._tag === "question"
                ? response._tag !== "approval"
                : open.request._tag === "unsupported-question" && response._tag === "dismiss";
          if (!fits) return yield* misuse(`${response._tag} answer to a ${open.request._tag}`);
          keys.set(key, { command: "respond" });
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
          yield* Effect.addFinalizer(() => Effect.sync(() => session.subscribers.delete(queue)));
        }),
      ),

    synchronize: ({ sessionId, token }) =>
      command(
        Effect.gen(function* () {
          const session = yield* liveSession(sessionId);
          const at = yield* DateTime.now;
          // Every event is handed to the streams as it happens, so each stream
          // is already caught up: the marker follows what it was last given.
          for (const [subscriber, state] of session.subscribers) {
            Queue.offerUnsafe(subscriber, {
              _tag: "synchronized",
              cursor: state.lastCursor,
              at,
              token,
            });
          }
          // Tool calls the engine records late appear only after this marker.
          const running = session.running === null ? undefined : session.turns.get(session.running);
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
  });

  const control = TestEngineControl.of({
    setReachable: (value) =>
      Effect.gen(function* () {
        reachable = value;
        yield* SubscriptionRef.update(status, (current): EngineStatus => ({
          ...current,
          state: value ? { _tag: "ready" } : { _tag: "unavailable", reason: "down" },
        }));
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

    startEngineTurnDuringNextDispatch: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.raceNextStart = true;
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

    readSteers: ({ sessionId, turnId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        for (const steer of turn.steers) if (steer.state === "unread") steer.state = "read";
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

    openRequest: ({ sessionId, turnId, request }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        yield* runningTurn(session, turnId);
        const at = yield* DateTime.now;
        const open: OpenRequest = {
          requestId: RequestId.make(newId("request")),
          turnId,
          openedAt: at,
          request,
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

    startBackgroundWork: ({ sessionId, turnId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        turn.backgroundWork = true;
      }),

    backgroundWorkRunning: (sessionId) =>
      existingSession(sessionId).pipe(
        Effect.map((session) => [...session.turns.values()].some((turn) => turn.backgroundWork)),
      ),

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

    startEngineTurn: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        return addTurn(session, { _tag: "background" }, yield* DateTime.now).turnId;
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
        for (const subscriber of session.subscribers.keys()) {
          yield* Queue.fail(subscriber, new SessionNotFound({ sessionId }));
        }
      }),

    dispatches: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.dispatches.values()])),

    responses: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.responses])),

    secretAnswers: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.secretAnswers])),
  });

  return Context.make(Engine, engine).pipe(Context.add(TestEngineControl, control));
});

/** An in-memory `Engine` and the `TestEngineControl` that drives it. */
export const layer: Layer.Layer<Engine | TestEngineControl> = Layer.effectContext(make);
