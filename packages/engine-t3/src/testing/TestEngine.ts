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
// applied once, a refused key refused again, and a repeat that cannot say how
// the first was accepted; dispositions that record acceptance, with delivery
// reported by events; a start the engine queues behind a turn it began itself;
// a steer that settles only when its turn ends (read, dropped by Stop, or
// requeued as a follow-up turn), and one refused because its turn waits or did
// not complete; Stop as the engine's own stop followed by a cancel per waiting turn,
// with a message able to slip in between; queues the engine holds and the
// adapter resumes once; turns that fail before they start; `j3` tool calls the
// engine records after the bridge sees them; usage-limit continuations;
// requests that expire with their turn; host speech; replies lost after a
// command was applied; synchronization markers; and resume by cursor with
// replay or a replacement that repeats turns already seen end, as the real
// engine may. The adapter's conformance suite runs the same scenarios against
// the real engine, which keeps this double honest.

/** A dispatch the engine applied, as the test inspects it. */
export interface ReceivedDispatch {
  readonly key: IdempotencyKey;
  readonly text: string;
  readonly attachments: ReadonlyArray<DispatchAttachment>;
  readonly delivery: Delivery;
  /** As the first submission was answered. */
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
     * The engine refuses the next dispatch it receives, applying nothing and
     * spending its key: it fails with `DispatchRejected`, as does every repeat.
     */
    readonly rejectNextDispatch: Effect.Effect<void>;
    /**
     * Background work wakes the session while the next `start` dispatch is on
     * its way: the adapter's busy check passes, and the engine then queues the
     * start behind that turn.
     */
    readonly startEngineTurnDuringNextDispatch: (sessionId: SessionId) => Effect.Effect<void>;
    /**
     * A `start` that passed the adapter's busy check reaches the engine in the
     * middle of the session's next `stop`: after the engine's own stop, before
     * the cancels. As a user's message, it releases the hold that stop put on
     * the queue.
     */
    readonly dispatchDuringNextStop: (input: {
      readonly sessionId: SessionId;
      readonly key: IdempotencyKey;
      readonly text: string;
    }) => Effect.Effect<void>;
    /**
     * The engine holds the session's queue, as after a model change while the
     * replaced provider session still runs background work. The adapter
     * resumes it once; with `heldAgainOnResume` the engine holds it again in
     * answer, and it stays held until the next call. A hold a Stop made is
     * never resumed.
     */
    readonly holdQueue: (input: {
      readonly sessionId: SessionId;
      readonly heldAgainOnResume: boolean;
    }) => Effect.Effect<void>;
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
  /** Whether the queue is held, and by what. */
  hold: "none" | "stop" | "engine";
  readonly requests: Map<RequestId, OpenRequest>;
  readonly dispatches: Map<IdempotencyKey, ReceivedDispatch>;
  readonly responses: Array<{ readonly requestId: RequestId; readonly response: RequestResponse }>;
  readonly secretAnswers: Array<{ readonly requestId: RequestId; readonly answer: SecretAnswer }>;
  /** Each open stream, with the cursor of the last event it was given. */
  readonly subscribers: Map<Subscriber, { lastCursor: EventCursor }>;
  /** Set by `startEngineTurnDuringNextDispatch`. */
  raceNextStart: boolean;
  /** Set by `dispatchDuringNextStop`. */
  dispatchDuringStop: { readonly key: IdempotencyKey; readonly text: string } | null;
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
  // One counter for every session, as the real engine numbers its events.
  let sequence = 0;
  let nextId = 0;
  const projects = new Map<string, EngineProjectId>();
  const sessions = new Map<SessionId, SessionRecord>();
  const keys = new Map<IdempotencyKey, AppliedKey>();
  const staged = new Set<EngineAttachmentId>();

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

  /** Starts the next waiting turn, unless one runs or the queue is held. */
  const startNext = (session: SessionRecord, at: DateTime.Utc) => {
    if (session.running !== null || session.hold !== "none") return;
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
      outcome,
      backgroundWork: turn.backgroundWork,
      continuation,
    }));
    for (const settlement of settlements) emit(session, at, settlement);
    if (session.running === turn.turnId) {
      session.running = null;
      // The engine holds its queue after a provider error and the adapter
      // resumes it, so a waiting turn follows here unless a Stop holds it.
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
   * A `start` the engine applies. A user's message releases a held queue
   * (**Read** at `db51b67`), so it is `queued` behind every turn left waiting.
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
    session.hold = "none";
    const turn = addTurn(session, { _tag: "dispatch", key }, at);
    return session.waiting.includes(turn.turnId)
      ? { _tag: "queued", turnId: turn.turnId }
      : { _tag: "started", turnId: turn.turnId };
  };

  /**
   * Stop as the adapter runs it: the engine's own stop ends the running turn
   * with its background work and holds the queue; then each turn still waiting
   * is cancelled. A dispatch armed by `dispatchDuringNextStop` lands between
   * the two.
   */
  const stopSession = (session: SessionRecord, at: DateTime.Utc) => {
    session.hold = "stop";
    const running = session.running === null ? undefined : session.turns.get(session.running);
    if (running !== undefined) {
      running.backgroundWork = false;
      endTurn(session, running, { _tag: "interrupted" }, at, "stop");
    }
    const slipped = session.dispatchDuringStop;
    if (slipped !== null) {
      session.dispatchDuringStop = null;
      const delivery: Delivery = { _tag: "start", freshContext: false };
      keys.set(slipped.key, { command: "dispatch", sessionId: session.id, outcome: "applied" });
      session.dispatches.set(slipped.key, {
        key: slipped.key,
        text: slipped.text,
        attachments: [],
        delivery,
        disposition: applyStart(session, slipped.key, at),
      });
    }
    // Taken off the queue first: cancelling one turn starts no other.
    for (const turnId of session.waiting.splice(0)) {
      const turn = session.turns.get(turnId);
      if (turn !== undefined) endTurn(session, turn, { _tag: "cancelled" }, at, "stop");
    }
  };

  const retire = (session: SessionRecord, at: DateTime.Utc) => {
    stopSession(session, at);
    for (const turn of session.turns.values()) dropContinuation(session, turn, at);
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
    return {
      _tag: "replaced",
      // Cursors are numbered across every session, so the latest one covers this
      // session's history too.
      cursor: cursorOf(sequence),
      at,
      openTurns,
      openRequests: [...session.requests.values()],
      endedTurns,
      hostSpeech: listed.flatMap((turn) => turn.hostSpeech),
      closedRequests: listed.flatMap((turn) => turn.closedRequests),
      steers,
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
            hold: "none",
            requests: new Map(),
            dispatches: new Map(),
            responses: [],
            secretAnswers: [],
            subscribers: new Map(),
            raceNextStart: false,
            dispatchDuringStop: null,
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

    dispatch: ({ key, sessionId, text, attachments, delivery }) =>
      command(
        Effect.gen(function* () {
          if (attachments.some((attachment) => !staged.has(attachment.stagedId))) {
            return yield* misuse("an attachment that was never staged");
          }
          if (attachmentLimitViolation(attachments) !== undefined) {
            return yield* misuse("attachments over the engine's limits");
          }
          // The engine answers a key it holds a receipt for before anything else.
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
            return { _tag: "applied-earlier" } as const;
          }
          const session = yield* liveSession(sessionId);
          if (delivery._tag === "start") {
            // The adapter's check, before anything is sent.
            const busyWith = session.running ?? session.waiting[0];
            if (busyWith !== undefined) {
              return yield* new SessionBusy({ sessionId, turnId: busyWith });
            }
          }
          if (rejectDispatch) {
            rejectDispatch = false;
            keys.set(key, { command: "dispatch", sessionId, outcome: "rejected" });
            return yield* new DispatchRejected({ key });
          }
          const at = yield* DateTime.now;
          let disposition: DispatchDisposition;
          if (delivery._tag === "start") {
            disposition = applyStart(session, key, at);
          } else {
            const target = session.turns.get(delivery.turnId);
            if (target !== undefined && session.running === target.turnId) {
              target.steers.push({
                key,
                queuedAhead: [...session.waiting],
                state: "unread",
              });
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
              // `dispatchSteerIntoRun`).
              keys.set(key, { command: "dispatch", sessionId, outcome: "rejected" });
              return yield* new DispatchRejected({ key });
            }
          }
          keys.set(key, { command: "dispatch", sessionId, outcome: "applied" });
          session.dispatches.set(key, { key, text, attachments, delivery, disposition });
          return disposition;
        }),
      ),

    stageAttachment: () =>
      command(
        Effect.gen(function* () {
          const id = EngineAttachmentId.make(newId("attachment"));
          staged.add(id);
          return { id, usableUntil: DateTime.addDuration(yield* DateTime.now, STAGED_USABLE_FOR) };
        }),
      ),

    stop: ({ key, sessionId }) =>
      command(
        Effect.gen(function* () {
          if ((yield* priorUse(key, "stop")) !== undefined) return;
          const session = yield* liveSession(sessionId);
          keys.set(key, { command: "stop" });
          stopSession(session, yield* DateTime.now);
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
              : open.request._tag === "question" && response._tag !== "approval";
          if (!fits) return yield* misuse(`${response._tag} answer to a ${open.request._tag}`);
          keys.set(key, { command: "respond" });
          session.responses.push({ requestId, response });
          closeRequest(session, open, "answered", yield* DateTime.now);
        }),
      ),

    respondSecret: ({ sessionId, requestId, answer }) =>
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
          state: value ? { _tag: "ready" } : { _tag: "unavailable" },
        }));
      }),

    loseNextReply: Effect.sync(() => {
      loseReply = true;
    }),

    rejectNextDispatch: Effect.sync(() => {
      rejectDispatch = true;
    }),

    startEngineTurnDuringNextDispatch: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.raceNextStart = true;
      }),

    dispatchDuringNextStop: ({ sessionId, key, text }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.dispatchDuringStop = { key, text };
      }),

    holdQueue: ({ sessionId, heldAgainOnResume }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        if (session.hold === "stop") return;
        // The adapter resumes the hold once; the engine may hold it again.
        session.hold = heldAgainOnResume ? "engine" : "none";
        startNext(session, yield* DateTime.now);
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
