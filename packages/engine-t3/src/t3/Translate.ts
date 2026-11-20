// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FailureClass, Question, WorkStep } from "@j3-bots/contracts";
import { WorkStepId } from "@j3-bots/contracts";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DispatchDisposition } from "../Engine.ts";
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
import { HostSpeechId, IdempotencyKey, RequestId, TurnId } from "../ids.ts";
import { dispatchOfMessage, localIdFor, messageIdFor } from "./Keys.ts";

// The engine's thread, mirrored entity by entity, and the J3 Bots events it
// means. Engine events carry whole entities and a snapshot carries all of
// them, so both become the same upserts into a `Mirror`. What the subscriber
// has been told is a `View`; `diff` turns the difference between the two into
// session events. A replay, a snapshot taken mid-stream and live events all go
// through it, which is what makes them interchangeable.

type Run = OrchestrationV2Run;
type Item = OrchestrationV2TurnItem;
type RuntimeRequest = OrchestrationV2RuntimeRequest;

/** The engine's state of one thread, as far as J3 Bots reads it. */
export interface Mirror {
  readonly runs: Map<string, Run>;
  readonly items: Map<string, Item>;
  readonly requests: Map<string, RuntimeRequest>;
}

export const emptyMirror = (): Mirror => ({
  runs: new Map(),
  items: new Map(),
  requests: new Map(),
});

export const mirrorOf = (projection: OrchestrationV2ThreadProjection): Mirror => ({
  runs: new Map(projection.runs.map((run) => [run.id, run])),
  items: new Map(projection.turnItems.map((item) => [item.id, item])),
  requests: new Map(projection.runtimeRequests.map((request) => [request.id, request])),
});

/** Applies one engine event. Returns whether it touched anything J3 Bots reads. */
export const applyEvent = (mirror: Mirror, event: OrchestrationV2DomainEvent): boolean => {
  switch (event.type) {
    case "run.created":
    case "run.updated":
      mirror.runs.set(event.payload.id, event.payload);
      return true;
    case "turn-item.updated":
      mirror.items.set(event.payload.id, event.payload);
      return true;
    case "runtime-request.updated":
      mirror.requests.set(event.payload.id, event.payload);
      return true;
    default:
      return false;
  }
};

// ---------------------------------------------------------------------------
// Runs as turns

const STARTED: ReadonlySet<Run["status"]> = new Set(["starting", "running", "waiting"]);
const ENDED: ReadonlySet<Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const isEnded = (run: Run) => ENDED.has(run.status);
const hasStarted = (run: Run) =>
  STARTED.has(run.status) || (isEnded(run) && run.startedAt !== null);

const turnIdOf = (run: Run) => TurnId.make(run.id);

const runsInOrder = (mirror: Mirror) =>
  [...mirror.runs.values()].sort((a, b) => a.ordinal - b.ordinal);

const itemsOf = (mirror: Mirror, run: Run) =>
  [...mirror.items.values()]
    .filter((item) => item.runId === run.id)
    .sort((a, b) => a.ordinal - b.ordinal);

export const causeOf = (run: Run): TurnCause => {
  const continued =
    run.restartContinuationOfRunId ??
    run.usageLimitContinuationOfRunId ??
    run.manualContinuationOfRunId;
  if (continued !== undefined) return { _tag: "continuation", turnId: TurnId.make(continued) };
  const dispatch = dispatchOfMessage(run.userMessageId);
  if (Option.isSome(dispatch)) return { _tag: "dispatch", key: dispatch.value.key };
  return { _tag: "background" };
};

const FAILURES: Record<string, FailureClass> = {
  usage_limit: "usage-limit",
  provider_error: "provider-error",
  transport_error: "provider-error",
  permission_error: "permission-error",
};

const parseInstant = (value: string | null | undefined) =>
  value === null || value === undefined ? null : Option.getOrNull(DateTime.make(value));

export const outcomeOf = (mirror: Mirror, run: Run): TurnOutcome => {
  switch (run.status) {
    case "completed":
      return { _tag: "completed" };
    case "failed": {
      const error = itemsOf(mirror, run)
        .filter((item) => item.type === "error")
        .at(-1);
      if (error === undefined || error.type !== "error") {
        return { _tag: "failed", failure: "unknown", retryAt: null };
      }
      return {
        _tag: "failed",
        failure: FAILURES[error.failure.class] ?? "unknown",
        retryAt: parseInstant(error.failure.resetAt),
      };
    }
    case "cancelled":
      // A queued turn cancelled before it began, or a running one an engine restart ended.
      return run.startedAt === null ? { _tag: "cancelled" } : { _tag: "interrupted" };
    default:
      return { _tag: "interrupted" };
  }
};

const LIVE_ITEM: ReadonlySet<Item["status"]> = new Set(["idle", "pending", "running", "waiting"]);

/** Whether work the turn started can still wake the session after it ends. */
const hasBackgroundWork = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).some(
    (item) =>
      LIVE_ITEM.has(item.status) &&
      ((item.type === "command_execution" && item.completionWake === "always") ||
        item.type === "subagent"),
  );

// ---------------------------------------------------------------------------
// Steps

const label = (text: string | null | undefined, fallback: string) => {
  const line =
    (text ?? "")
      .split("\n")
      .find((part) => part.trim().length > 0)
      ?.trim() ?? "";
  const chosen = line.length > 0 ? line : fallback;
  return chosen.length > 200 ? `${chosen.slice(0, 199)}…` : chosen;
};

const SEND_TO_USER = /(^|__|\/|\.)send_to_user$/;

const isHostSpeech = (item: Item) =>
  item.type === "dynamic_tool" && item.toolName !== null && SEND_TO_USER.test(item.toolName);

const stepKind = (item: Item): WorkStep["kind"] | undefined => {
  switch (item.type) {
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "search";
    case "web_search":
      return "web";
    case "subagent":
      return "delegation";
    case "dynamic_tool":
      return isHostSpeech(item) ? undefined : "tool";
    default:
      return undefined;
  }
};

const stepLabel = (item: Item): string => {
  switch (item.type) {
    case "command_execution":
      return label(item.input, "Command");
    case "file_change":
      return label(item.fileName, "Edit");
    case "file_search":
      return label(item.pattern ?? item.title, "Search");
    case "web_search":
      return label(item.patterns?.join(", ") ?? item.title, "Web search");
    case "subagent":
      return label(item.title ?? item.prompt, "Delegated task");
    case "dynamic_tool":
      return label(item.title ?? item.toolName, "Tool");
    default:
      return label(item.title, item.type);
  }
};

const stepStatus = (item: Item): WorkStep["status"] =>
  LIVE_ITEM.has(item.status) ? "running" : item.status === "completed" ? "completed" : "failed";

const stepOf = (item: Item): WorkStep | undefined => {
  const kind = stepKind(item);
  if (kind === undefined) return undefined;
  return {
    id: WorkStepId.make(localIdFor(item.id)),
    kind,
    label: stepLabel(item),
    status: stepStatus(item),
    startedAt: item.startedAt ?? item.updatedAt,
    finishedAt: LIVE_ITEM.has(item.status) ? null : (item.completedAt ?? item.updatedAt),
  };
};

const stepsOf = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).flatMap((item) => {
    const step = stepOf(item);
    return step === undefined ? [] : [step];
  });

const fingerprint = (step: WorkStep) =>
  `${step.status}|${step.label}|${step.finishedAt === null ? "" : DateTime.formatIso(step.finishedAt)}`;

// ---------------------------------------------------------------------------
// Host speech

const SpeechInput = Schema.Struct({ message: Schema.String });
const decodeSpeechInput = Schema.decodeUnknownOption(SpeechInput);

const speechOf = (item: Item): HostSpeech | undefined => {
  if (item.type !== "dynamic_tool" || !isHostSpeech(item) || item.runId === null) return undefined;
  const input = decodeSpeechInput(item.input);
  if (Option.isNone(input) || input.value.message.trim().length === 0) return undefined;
  return {
    speechId: HostSpeechId.make(localIdFor(item.id)),
    turnId: TurnId.make(item.runId),
    text: input.value.message,
    at: item.startedAt ?? item.updatedAt,
  };
};

// ---------------------------------------------------------------------------
// Requests

const APPROVAL_KINDS: Record<
  Extract<Item, { type: "approval_request" }>["requestKind"],
  Extract<EngineRequest, { _tag: "approval" }>["kind"]
> = {
  command: "command",
  "file-change": "file-change",
  "file-read": "file-read",
  "mcp-elicitation": "tool",
  permission: "other",
};

const questionOf = (
  question: Extract<Item, { type: "user_input_request" }>["questions"][number],
): Question => ({
  id: label(question.id, "question"),
  prompt: question.question.length > 2000 ? question.question.slice(0, 2000) : question.question,
  options: question.options.slice(0, 6).map((option) => ({
    id: label(option.value ?? option.label, "option"),
    label: label(option.label, "Option"),
    description: option.description.slice(0, 1000),
    style: "default" as const,
  })),
  acceptsText: question.allowCustomAnswer ?? false,
  multiple: question.multiSelect ?? false,
});

/** Where the engine takes the answer to a request. */
export type AnswerTarget =
  | { readonly _tag: "runtime-request"; readonly requestId: string }
  | { readonly _tag: "secret"; readonly turnItemId: string };

/** A request item, its state, and what the operator sees of it. */
export interface RequestState {
  readonly requestId: RequestId;
  readonly answerTo: AnswerTarget;
  readonly turnId: TurnId;
  readonly openedAt: DateTime.Utc;
  readonly request: EngineRequest;
  /** `undefined` while it is open. */
  readonly resolution: RequestResolution | undefined;
}

const runtimeResolution = (
  request: RuntimeRequest | undefined,
  item: Item,
): RequestResolution | undefined => {
  const status = request?.status ?? (LIVE_ITEM.has(item.status) ? "pending" : "expired");
  switch (status) {
    case "pending":
      return undefined;
    case "resolved":
      return "answered";
    default:
      return "expired";
  }
};

const secretResolution = (
  item: Extract<Item, { type: "secret_request" }>,
): RequestResolution | undefined => {
  switch (item.secretStatus) {
    case "pending":
      return undefined;
    case "saved":
      return "provided";
    case "declined":
      return "declined";
    case "cancelled":
      return "expired";
  }
};

const requestOf = (mirror: Mirror, item: Item): RequestState | undefined => {
  if (item.runId === null) return undefined;
  const turnId = TurnId.make(item.runId);
  const openedAt = item.startedAt ?? item.updatedAt;
  switch (item.type) {
    case "approval_request": {
      const runtime = mirror.requests.get(item.requestId);
      return {
        requestId: RequestId.make(localIdFor(item.requestId)),
        answerTo: { _tag: "runtime-request", requestId: item.requestId },
        turnId,
        openedAt,
        request: {
          _tag: "approval",
          kind: APPROVAL_KINDS[item.requestKind],
          action: label(item.title ?? item.prompt, "Approval"),
          detail: (item.prompt ?? item.reason ?? null)?.slice(0, 20_000) ?? null,
          allowsSession:
            item.options?.some((option) => option.decision === "acceptForSession") ?? false,
        },
        resolution: runtimeResolution(runtime, item),
      };
    }
    case "user_input_request": {
      const [first, ...rest] = item.questions.map(questionOf);
      if (first === undefined) return undefined;
      return {
        requestId: RequestId.make(localIdFor(item.requestId)),
        answerTo: { _tag: "runtime-request", requestId: item.requestId },
        turnId,
        openedAt,
        request: { _tag: "question", questions: [first, ...rest] },
        resolution: runtimeResolution(mirror.requests.get(item.requestId), item),
      };
    }
    case "secret_request":
      return {
        requestId: RequestId.make(localIdFor(item.id)),
        answerTo: { _tag: "secret", turnItemId: item.id },
        turnId,
        openedAt,
        request: {
          _tag: "secret",
          label: label(item.label, "Secret"),
          reason: item.reason.slice(0, 2000),
          url: item.url?.slice(0, 2000) ?? null,
          placeholder: item.placeholder === undefined ? null : label(item.placeholder, "Secret"),
        },
        resolution: secretResolution(item),
      };
    default:
      return undefined;
  }
};

const requestsOf = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).flatMap((item) => {
    const state = requestOf(mirror, item);
    return state === undefined ? [] : [state];
  });

/** The engine's own request behind a J3 Bots request id, for answering it. */
export const findRequest = (mirror: Mirror, requestId: RequestId): Option.Option<RequestState> => {
  for (const item of mirror.items.values()) {
    const state = requestOf(mirror, item);
    if (state?.requestId === requestId) return Option.some(state);
  }
  return Option.none();
};

const openRequestOf = (state: RequestState): OpenRequest => ({
  requestId: state.requestId,
  turnId: state.turnId,
  openedAt: state.openedAt,
  request: state.request,
});

// ---------------------------------------------------------------------------
// Steers and dispatches

const STEER_INTENTS: ReadonlySet<string> = new Set(["steer", "promoted_queued_to_steer"]);

/** A steer's own item: the message the engine added to the turn it steers. */
const steerItemsOf = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).flatMap((item) => {
    if (item.type !== "user_message" || !STEER_INTENTS.has(item.inputIntent)) return [];
    const dispatch = dispatchOfMessage(item.messageId);
    return Option.isSome(dispatch) ? [{ item, key: dispatch.value.key }] : [];
  });

const steerSettlement = (item: Item): SteerSettlement["settlement"] | undefined =>
  item.status === "completed" ? "read" : item.status === "cancelled" ? "dropped" : undefined;

/**
 * How the engine accepted a dispatch, from its record of the dispatch's
 * message. `Option.none()` when the engine has no record of it.
 */
export const dispositionOf = (
  mirror: Mirror,
  key: IdempotencyKey,
): Option.Option<DispatchDisposition> => {
  const start = messageIdFor("start", key);
  const steer = messageIdFor("steer", key);
  // A steer the engine added to a turn, read or not.
  for (const item of mirror.items.values()) {
    if (
      item.type === "user_message" &&
      item.messageId === steer &&
      STEER_INTENTS.has(item.inputIntent) &&
      item.runId !== null
    ) {
      return Option.some({ _tag: "steered", turnId: TurnId.make(item.runId) });
    }
  }
  for (const run of runsInOrder(mirror)) {
    if (run.userMessageId !== start && run.userMessageId !== steer) continue;
    // A steer waiting for its turn to be ready to read it.
    if (run.steerWhenReadyRunId !== undefined) {
      return Option.some({ _tag: "steered", turnId: TurnId.make(run.steerWhenReadyRunId) });
    }
    if (run.userMessageId === steer)
      return Option.some({ _tag: "new-turn", turnId: turnIdOf(run) });
    const own = [...mirror.items.values()].find(
      (item) => item.type === "user_message" && item.messageId === start && item.runId === run.id,
    );
    const queued = own?.type === "user_message" && own.inputIntent === "queued_turn";
    return Option.some({ _tag: queued ? "queued" : "started", turnId: turnIdOf(run) });
  }
  return Option.none();
};

// ---------------------------------------------------------------------------
// Diffing a mirror against what the subscriber knows

interface TurnView {
  started: boolean;
  finished: boolean;
}

/** What the subscriber has been told. Copied, never shared, between cursors. */
export interface View {
  readonly turns: Map<string, TurnView>;
  readonly steps: Map<string, string>;
  readonly speech: Set<string>;
  readonly requests: Map<string, "open" | "closed">;
  readonly steers: Set<string>;
}

export const emptyView = (): View => ({
  turns: new Map(),
  steps: new Map(),
  speech: new Set(),
  requests: new Map(),
  steers: new Set(),
});

export const copyView = (view: View): View => ({
  turns: new Map([...view.turns].map(([id, turn]) => [id, { ...turn }])),
  steps: new Map(view.steps),
  speech: new Set(view.speech),
  requests: new Map(view.requests),
  steers: new Set(view.steers),
});

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A session event before it gets its cursor and time. */
export type EventBody = DistributiveOmit<SessionEvent, "cursor" | "at">;

/**
 * The events that bring a subscriber from `view` to `mirror`, in order, and
 * `view` updated to match. Applying them to `view` again yields nothing.
 */
export const diff = (mirror: Mirror, view: View): ReadonlyArray<EventBody> => {
  const events: Array<EventBody> = [];
  for (const run of runsInOrder(mirror)) {
    const turnId = turnIdOf(run);
    const turn = view.turns.get(run.id) ?? { started: false, finished: false };
    view.turns.set(run.id, turn);
    if (turn.finished) continue;
    if (!turn.started && hasStarted(run)) {
      turn.started = true;
      events.push({ _tag: "turn-started", turnId, cause: causeOf(run) });
    }
    for (const { item, key } of steerItemsOf(mirror, run)) {
      const settlement = steerSettlement(item);
      if (settlement === undefined || view.steers.has(item.id)) continue;
      view.steers.add(item.id);
      events.push({ _tag: settlement === "read" ? "steered" : "steer-dropped", key, turnId });
    }
    // A steer that never reached its turn: Stop cancelled the run it waited in.
    if (run.steerWhenReadyRunId !== undefined && run.status === "cancelled") {
      const dispatch = dispatchOfMessage(run.userMessageId);
      if (Option.isSome(dispatch) && !view.steers.has(run.id)) {
        view.steers.add(run.id);
        events.push({
          _tag: "steer-dropped",
          key: dispatch.value.key,
          turnId: TurnId.make(run.steerWhenReadyRunId),
        });
      }
      turn.finished = true;
      continue;
    }
    for (const state of requestsOf(mirror, run)) {
      if (state.resolution === undefined && !view.requests.has(state.requestId)) {
        view.requests.set(state.requestId, "open");
        events.push({ _tag: "request-opened", open: openRequestOf(state) });
      }
    }
    for (const item of itemsOf(mirror, run)) {
      const step = stepOf(item);
      if (step !== undefined) {
        const print = fingerprint(step);
        if (view.steps.get(step.id) !== print) {
          view.steps.set(step.id, print);
          events.push({ _tag: "step", turnId, step });
        }
      }
      const speech = speechOf(item);
      if (speech !== undefined && !view.speech.has(speech.speechId)) {
        view.speech.add(speech.speechId);
        events.push({ _tag: "host-speech", ...speech });
      }
    }
    for (const state of requestsOf(mirror, run)) {
      const resolution = state.resolution ?? (isEnded(run) ? ("expired" as const) : undefined);
      if (resolution !== undefined && view.requests.get(state.requestId) === "open") {
        view.requests.set(state.requestId, "closed");
        events.push({ _tag: "request-closed", requestId: state.requestId, turnId, resolution });
      }
    }
    if (isEnded(run)) {
      turn.finished = true;
      events.push({
        _tag: "turn-finished",
        turnId,
        outcome: outcomeOf(mirror, run),
        backgroundWork: hasBackgroundWork(mirror, run),
      });
    }
  }
  return events;
};

/**
 * The `replaced` event for a subscriber that resumes without a view, and the
 * view that matches it. `since` bounds the ended turns, speech and resolutions
 * it lists; null lists none, for a subscriber with no cursor.
 */
export const replacement = (
  mirror: Mirror,
  since: DateTime.Utc | null,
): { readonly event: EventBody & { _tag: "replaced" }; readonly view: View } => {
  const openTurns: Array<OpenTurn> = [];
  const openRequests: Array<OpenRequest> = [];
  const endedTurns: Array<EndedTurn> = [];
  const hostSpeech: Array<HostSpeech> = [];
  const closedRequests: Array<{
    requestId: RequestId;
    turnId: TurnId;
    resolution: RequestResolution;
  }> = [];
  const steers: Array<SteerSettlement> = [];

  for (const run of runsInOrder(mirror)) {
    const turnId = turnIdOf(run);
    const ended = isEnded(run);
    const listed =
      !ended ||
      (since !== null &&
        (run.completedAt === null || DateTime.isGreaterThanOrEqualTo(run.completedAt, since)));
    if (!listed) continue;
    const isWaitingSteer = run.steerWhenReadyRunId !== undefined;
    if (!ended && !isWaitingSteer) {
      openTurns.push({
        turnId,
        cause: causeOf(run),
        startedAt: hasStarted(run) ? (run.startedAt ?? run.requestedAt) : null,
        steps: stepsOf(mirror, run),
      });
    } else if (ended && !isWaitingSteer) {
      endedTurns.push({
        turnId,
        cause: causeOf(run),
        outcome: outcomeOf(mirror, run),
        backgroundWork: hasBackgroundWork(mirror, run),
        steps: stepsOf(mirror, run),
      });
    }
    if (isWaitingSteer && run.status === "cancelled") {
      const dispatch = dispatchOfMessage(run.userMessageId);
      if (Option.isSome(dispatch) && run.steerWhenReadyRunId !== undefined) {
        steers.push({
          key: dispatch.value.key,
          turnId: TurnId.make(run.steerWhenReadyRunId),
          settlement: "dropped",
        });
      }
    }
    for (const { item, key } of steerItemsOf(mirror, run)) {
      const settlement = steerSettlement(item);
      if (settlement !== undefined) steers.push({ key, turnId, settlement });
    }
    for (const state of requestsOf(mirror, run)) {
      const resolution = state.resolution ?? (ended ? ("expired" as const) : undefined);
      if (resolution === undefined) openRequests.push(openRequestOf(state));
      else if (since !== null)
        closedRequests.push({ requestId: state.requestId, turnId, resolution });
    }
    if (since !== null) {
      for (const item of itemsOf(mirror, run)) {
        const speech = speechOf(item);
        if (speech !== undefined) hostSpeech.push(speech);
      }
    }
  }

  // The subscriber now knows everything in the mirror.
  const view = emptyView();
  diff(mirror, view);
  return {
    event: {
      _tag: "replaced",
      openTurns,
      openRequests,
      endedTurns,
      hostSpeech,
      closedRequests,
      steers,
    },
    view,
  };
};

/** The turn running or waiting in the session, if any: for the best-effort busy check. */
export const activeTurn = (mirror: Mirror): Option.Option<TurnId> =>
  Option.map(Option.fromNullishOr(runsInOrder(mirror).find((run) => !isEnded(run))), turnIdOf);

/** Runs waiting in the engine's queue. */
export const queuedRuns = (mirror: Mirror) =>
  runsInOrder(mirror).filter((run) => run.status === "queued" || run.status === "preparing");

/** Whether the engine holds a queue that holds a J3 Bots dispatch. */
export const holdsDispatch = (mirror: Mirror) =>
  queuedRuns(mirror).some(
    (run) => run.queueHeld === true && Option.isSome(dispatchOfMessage(run.userMessageId)),
  );

export const runOf = (mirror: Mirror, turnId: TurnId) =>
  Option.fromNullishOr(mirror.runs.get(turnId));
