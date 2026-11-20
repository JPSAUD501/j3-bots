// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  EngineStatus,
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
  RequestResolution,
  SessionEvent,
  SteerSettlement,
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
  TurnId,
} from "../ids.ts";

// An in-memory engine that keeps the `Engine` contract, for testing the server
// without an engine process. It models what the server has to get right: keys
// applied once; dispositions that record acceptance, with delivery reported by
// events; a start the engine queues behind a turn it began itself; a steer that
// is read, dropped by Stop, or started as a follow-up turn when its turn ends
// unread; Stop cancelling waiting turns; requests that expire with their turn;
// host speech; replies lost after a command was applied; synchronization
// markers; and resume by cursor with replay or a replacement that repeats
// turns already seen end, as the real engine may. The adapter's conformance
// suite runs the same scenarios against the real engine, which keeps this
// double honest.

/** A dispatch the engine received, as the test inspects it. */
export interface ReceivedDispatch {
  readonly key: IdempotencyKey;
  readonly text: string;
  readonly attachments: ReadonlyArray<DispatchAttachment>;
  readonly delivery: Delivery;
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
     * The engine or the harness starts a turn of its own in the session while
     * the next `start` dispatch is on its way: the adapter's busy check passes,
     * and the engine then queues the start behind that turn.
     */
    readonly startEngineTurnDuringNextDispatch: (input: {
      readonly sessionId: SessionId;
      readonly cause: Exclude<TurnCause, { readonly _tag: "dispatch" }>;
    }) => Effect.Effect<void>;
    /** Adds or replaces (by id) a step of a running turn. */
    readonly step: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly step: WorkStep;
    }) => Effect.Effect<void>;
    /** The agent reads every steer of the running turn it has not read yet. */
    readonly readSteers: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
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
     * and each steer it had not read becomes a follow-up turn that runs next.
     */
    readonly finishTurn: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly outcome: TurnOutcome;
    }) => Effect.Effect<void>;
    /**
     * The engine or the harness wakes the session itself, as when background
     * work finishes. The turn starts at once, or after the running one.
     */
    readonly startEngineTurn: (input: {
      readonly sessionId: SessionId;
      readonly cause: Exclude<TurnCause, { readonly _tag: "dispatch" }>;
    }) => Effect.Effect<TurnId>;
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
  state: "unread" | "read" | "dropped" | "followed-up";
}

interface TurnRecord {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
  startedAt: DateTime.Utc | null;
  readonly steps: Map<WorkStepId, WorkStep>;
  readonly steers: Array<SteerRecord>;
  readonly hostSpeech: Array<HostSpeech>;
  readonly closedRequests: Array<{
    readonly requestId: RequestId;
    readonly turnId: TurnId;
    readonly resolution: RequestResolution;
  }>;
  backgroundWork: boolean;
  ended: { readonly outcome: TurnOutcome } | null;
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
  readonly requests: Map<RequestId, OpenRequest>;
  readonly dispatches: Map<IdempotencyKey, ReceivedDispatch>;
  readonly responses: Array<{ readonly requestId: RequestId; readonly response: RequestResponse }>;
  readonly secretAnswers: Array<{ readonly requestId: RequestId; readonly answer: SecretAnswer }>;
  /** Each open stream, with the cursor of the last event it was given. */
  readonly subscribers: Map<Subscriber, { lastCursor: EventCursor }>;
  /** Set by `startEngineTurnDuringNextDispatch`. */
  raceNextStart: Exclude<TurnCause, { readonly _tag: "dispatch" }> | null;
}

type AppliedKey =
  | { readonly command: "openSession"; readonly sessionId: SessionId }
  | { readonly command: "dispatch"; readonly sessionId: SessionId }
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
      return effect.pipe(Effect.andThen(Effect.fail(new EngineIndeterminate())));
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

  const startTurn = (session: SessionRecord, turn: TurnRecord, at: DateTime.Utc) => {
    turn.startedAt = at;
    session.running = turn.turnId;
    emit(session, at, (stamp) => ({
      _tag: "turn-started",
      ...stamp,
      turnId: turn.turnId,
      cause: turn.cause,
    }));
  };

  const newTurn = (session: SessionRecord, cause: TurnCause): TurnRecord => {
    const turn: TurnRecord = {
      turnId: TurnId.make(newId("turn")),
      cause,
      startedAt: null,
      steps: new Map(),
      steers: [],
      hostSpeech: [],
      closedRequests: [],
      backgroundWork: false,
      ended: null,
    };
    session.turns.set(turn.turnId, turn);
    return turn;
  };

  /** A new turn that starts at once, or waits at the end of the queue. */
  const addTurn = (session: SessionRecord, cause: TurnCause, at: DateTime.Utc) => {
    const turn = newTurn(session, cause);
    if (session.running === null) startTurn(session, turn, at);
    else session.waiting.push(turn.turnId);
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

  /**
   * Ends a turn. Its open requests expire. A steer it had not read is dropped
   * when Stop ended it, and otherwise becomes a follow-up turn, placed after
   * the turns that were already waiting when the steer was sent.
   */
  const endTurn = (
    session: SessionRecord,
    turn: TurnRecord,
    outcome: TurnOutcome,
    at: DateTime.Utc,
    endedBy: "stop" | "other",
  ) => {
    for (const open of session.requests.values()) {
      if (open.turnId === turn.turnId) closeRequest(session, open, "expired", at);
    }
    for (const steer of turn.steers) {
      if (steer.state !== "unread") continue;
      if (endedBy === "stop") {
        steer.state = "dropped";
        emit(session, at, (stamp) => ({
          _tag: "steer-dropped",
          ...stamp,
          key: steer.key,
          turnId: turn.turnId,
        }));
      } else {
        steer.state = "followed-up";
        const followUp = newTurn(session, { _tag: "dispatch", key: steer.key });
        const place = session.waiting.filter((waiting) => steer.queuedAhead.includes(waiting));
        const last = place.at(-1);
        session.waiting.splice(
          last === undefined ? 0 : session.waiting.indexOf(last) + 1,
          0,
          followUp.turnId,
        );
      }
    }
    const waitingIndex = session.waiting.indexOf(turn.turnId);
    if (waitingIndex >= 0) session.waiting.splice(waitingIndex, 1);
    turn.ended = { outcome };
    emit(session, at, (stamp) => ({
      _tag: "turn-finished",
      ...stamp,
      turnId: turn.turnId,
      outcome,
      backgroundWork: turn.backgroundWork,
    }));
    if (session.running === turn.turnId) {
      session.running = null;
      // The adapter resumes a queue the engine held after a provider error,
      // so a waiting turn always follows here.
      const nextId = session.waiting.shift();
      const next = nextId === undefined ? undefined : session.turns.get(nextId);
      if (next !== undefined) startTurn(session, next, at);
    }
  };

  const runningTurn = (session: SessionRecord, turnId: TurnId) => {
    const turn = session.turns.get(turnId);
    return turn !== undefined && session.running === turnId && turn.ended === null
      ? Effect.succeed(turn)
      : misuse(`turn ${turnId} is not running`);
  };

  /**
   * Stops everything in the session: waiting turns are cancelled, the running
   * turn's unread steers are dropped, and it ends with its background work.
   */
  const stopAll = (session: SessionRecord, at: DateTime.Utc) => {
    // Emptied first, so the running turn's end below starts none of them.
    for (const turnId of session.waiting.splice(0)) {
      const turn = session.turns.get(turnId);
      if (turn !== undefined) endTurn(session, turn, { _tag: "cancelled" }, at, "stop");
    }
    const running = session.running === null ? undefined : session.turns.get(session.running);
    if (running !== undefined) {
      running.backgroundWork = false;
      endTurn(session, running, { _tag: "interrupted" }, at, "stop");
    }
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
        });
        listed.push(turn);
      } else if (after !== null) {
        endedTurns.push({
          turnId: turn.turnId,
          cause: turn.cause,
          outcome: turn.ended.outcome,
          backgroundWork: turn.backgroundWork,
          steps,
        });
        listed.push(turn);
      }
    }
    const steers: Array<SteerSettlement> = listed.flatMap((turn) =>
      turn.steers.flatMap((steer) =>
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
            if (session.projectId !== projectId || session.retired) continue;
            stopAll(session, at);
            session.retired = true;
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
            requests: new Map(),
            dispatches: new Map(),
            responses: [],
            secretAnswers: [],
            subscribers: new Map(),
            raceNextStart: null,
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
          stopAll(session, yield* DateTime.now);
          session.retired = true;
        }),
      ),

    dispatch: ({ key, sessionId, text, attachments, delivery }) =>
      command(
        Effect.gen(function* () {
          const previous = yield* priorUse(key, "dispatch");
          if (previous?.command === "dispatch") {
            if (previous.sessionId !== sessionId) {
              return yield* misuse(`dispatch key ${key} sent to a second session`);
            }
            const first = sessions.get(sessionId)?.dispatches.get(key);
            if (first !== undefined) return first.disposition;
          }
          const session = yield* liveSession(sessionId);
          if (attachments.some((attachment) => !staged.has(attachment.stagedId))) {
            return yield* misuse("an attachment that was never staged");
          }
          if (attachmentLimitViolation(attachments) !== undefined) {
            return yield* misuse("attachments over the engine's limits");
          }
          const at = yield* DateTime.now;
          let disposition: DispatchDisposition;
          if (delivery._tag === "start") {
            const busyWith = session.running ?? session.waiting[0];
            if (busyWith !== undefined) {
              return yield* new SessionBusy({ sessionId, turnId: busyWith });
            }
            // The adapter's check passed; a turn may still begin before the
            // engine applies the start.
            if (session.raceNextStart !== null) {
              addTurn(session, session.raceNextStart, at);
              session.raceNextStart = null;
            }
            const turn = addTurn(session, { _tag: "dispatch", key }, at);
            disposition =
              turn.startedAt === null
                ? { _tag: "queued", turnId: turn.turnId }
                : { _tag: "started", turnId: turn.turnId };
          } else {
            const target =
              session.running === delivery.turnId ? session.turns.get(delivery.turnId) : undefined;
            if (target !== undefined) {
              target.steers.push({ key, queuedAhead: [...session.waiting], state: "unread" });
              disposition = { _tag: "steered", turnId: delivery.turnId };
            } else {
              // The target turn already ended: the engine keeps the message as a turn of its own.
              disposition = {
                _tag: "new-turn",
                turnId: addTurn(session, { _tag: "dispatch", key }, at).turnId,
              };
            }
          }
          keys.set(key, { command: "dispatch", sessionId });
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

    lookupDispatch: ({ sessionId, key }) =>
      command(
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          if (session === undefined) return { _tag: "unknown" } as const;
          const received = session.dispatches.get(key);
          return received === undefined
            ? ({ _tag: "not-applied" } as const)
            : ({ _tag: "applied", disposition: received.disposition } as const);
        }),
      ),

    stop: ({ key, sessionId }) =>
      command(
        Effect.gen(function* () {
          if ((yield* priorUse(key, "stop")) !== undefined) return;
          const session = yield* liveSession(sessionId);
          keys.set(key, { command: "stop" });
          stopAll(session, yield* DateTime.now);
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

    startEngineTurnDuringNextDispatch: ({ sessionId, cause }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.raceNextStart = cause;
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
        const at = yield* DateTime.now;
        for (const steer of turn.steers) {
          if (steer.state !== "unread") continue;
          steer.state = "read";
          emit(session, at, (stamp) => ({ _tag: "steered", ...stamp, key: steer.key, turnId }));
        }
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

    finishTurn: ({ sessionId, turnId, outcome }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        endTurn(session, turn, outcome, yield* DateTime.now, "other");
      }),

    startEngineTurn: ({ sessionId, cause }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        return addTurn(session, cause, yield* DateTime.now).turnId;
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
