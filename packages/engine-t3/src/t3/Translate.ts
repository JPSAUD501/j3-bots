// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FailureClass, Question, WorkStep } from "@j3-bots/contracts";
import { WorkStepId } from "@j3-bots/contracts";
import {
  OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DispatchDisposition } from "../Engine.ts";
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
  HostSpeechId,
  IdempotencyKey,
  RequestId,
  ToolCallId,
  type ToolInputDigest,
  TurnId,
} from "../ids.ts";
import { toolInputDigest } from "../toolCaller.ts";
import { dispatchOfMessage, localIdFor, messageIdFor } from "./Keys.ts";
import { TOOL_SERVER } from "./Provision.ts";

// The engine's thread, mirrored entity by entity, and the J3 Bots events it
// means. Engine events carry whole entities and a snapshot carries all of
// them, so both become the same upserts into a `Mirror`. What the subscriber
// has been told is a `View`; `diff` turns the difference between the two into
// session events. A replay, a snapshot taken mid-stream and live events all go
// through it, which is what makes them interchangeable.

type Run = OrchestrationV2Run;
type Item = OrchestrationV2TurnItem;
type RuntimeRequest = OrchestrationV2RuntimeRequest;
type Thread = OrchestrationV2AppThread;

/** The engine's state of one thread, as far as J3 Bots reads it. */
export interface Mirror {
  /** `undefined` until the engine has sent it. */
  thread: Thread | undefined;
  readonly runs: Map<string, Run>;
  readonly items: Map<string, Item>;
  readonly requests: Map<string, RuntimeRequest>;
  /**
   * `toolInputDigest` of each `j3` tool call's input, by item id, with the
   * input it was taken of. Kept by `digestToolCalls`, which `diff` relies on.
   */
  readonly toolDigests: Map<string, { readonly input: unknown; readonly digest: ToolInputDigest }>;
}

export const emptyMirror = (): Mirror => ({
  thread: undefined,
  runs: new Map(),
  items: new Map(),
  requests: new Map(),
  toolDigests: new Map(),
});

export const mirrorOf = (projection: OrchestrationV2ThreadProjection): Mirror => ({
  thread: projection.thread,
  runs: new Map(projection.runs.map((run) => [run.id, run])),
  items: new Map(projection.turnItems.map((item) => [item.id, item])),
  requests: new Map(projection.runtimeRequests.map((request) => [request.id, request])),
  toolDigests: new Map(),
});

const isThread = Schema.is(OrchestrationV2AppThread);

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
      // Every thread event carries the whole thread record.
      if (event.type.startsWith("thread.") && isThread(event.payload)) {
        mirror.thread = event.payload;
        return true;
      }
      return false;
  }
};

/** Whether the session was retired: the engine archived its thread. */
export const isRetired = (mirror: Mirror) =>
  mirror.thread !== undefined && mirror.thread.archivedAt !== null;

// ---------------------------------------------------------------------------
// Runs as turns

const ENDED: ReadonlySet<Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const isEnded = (run: Run) => ENDED.has(run.status);

/**
 * Whether the run's provider turn started. A run is `starting` before that,
 * with no `startedAt`, and can still fail there (**Read** at `db51b67`,
 * `Orchestrator.ts`).
 */
const hasStarted = (run: Run) =>
  run.startedAt !== null || run.status === "running" || run.status === "waiting";

const turnIdOf = (run: Run) => TurnId.make(run.id);

const runsInOrder = (mirror: Mirror) =>
  [...mirror.runs.values()].sort((a, b) => a.ordinal - b.ordinal);

const itemsOf = (mirror: Mirror, run: Run) =>
  [...mirror.items.values()]
    .filter((item) => item.runId === run.id)
    .sort((a, b) => a.ordinal - b.ordinal);

type UserMessage = Extract<Item, { type: "user_message" }>;

const STEER_INTENTS: ReadonlySet<UserMessage["inputIntent"]> = new Set([
  "steer",
  "promoted_queued_to_steer",
]);

const isSteerItem = (item: Item): item is UserMessage =>
  item.type === "user_message" && STEER_INTENTS.has(item.inputIntent);

const userMessagesOf = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).filter((item): item is UserMessage => item.type === "user_message");

/**
 * The message a run was started for: what its first attempt ran. Not
 * `run.userMessageId`, which the engine moves to a steer it restarts the run
 * with (**Verified**). The run's own message items keep the message it opened
 * with; a run with none yet opened with `userMessageId`.
 */
const openingMessageOf = (mirror: Mirror, run: Run): string | undefined => {
  const messages = userMessagesOf(mirror, run);
  const opening = messages.find((item) => !STEER_INTENTS.has(item.inputIntent));
  if (opening !== undefined) return opening.messageId;
  return messages.length === 0 ? run.userMessageId : undefined;
};

/**
 * A steer the engine keeps aside until its target run's provider turn starts.
 * It is no turn while it waits: when the target starts, the engine cancels it
 * and steers its message into the target (**Read** at `db51b67`,
 * `Orchestrator.ts`, `queued-message.promote-to-steer`). If the target ends
 * first, it runs as the steer's follow-up turn.
 */
const isWaitingSteer = (mirror: Mirror, run: Run) => {
  if (run.steerWhenReadyRunId === undefined || hasStarted(run)) return false;
  const target = mirror.runs.get(run.steerWhenReadyRunId);
  return target !== undefined && !isEnded(target);
};

const causeOf = (mirror: Mirror, run: Run): TurnCause => {
  const continued =
    run.restartContinuationOfRunId ??
    run.usageLimitContinuationOfRunId ??
    run.manualContinuationOfRunId;
  if (continued !== undefined) return { _tag: "continuation", turnId: TurnId.make(continued) };
  const opening = openingMessageOf(mirror, run);
  const dispatch = opening === undefined ? Option.none() : dispatchOfMessage(opening);
  if (Option.isSome(dispatch)) return { _tag: "dispatch", key: dispatch.value.key };
  return { _tag: "background" };
};

const FAILURES: Record<OrchestrationV2ProviderFailureClass, FailureClass> = {
  usage_limit: "usage-limit",
  provider_error: "provider-error",
  transport_error: "provider-error",
  permission_error: "permission-error",
  validation_error: "provider-error",
  unknown: "unknown",
};

const parseInstant = (value: string | null | undefined) =>
  value === null || value === undefined ? null : Option.getOrNull(DateTime.make(value));

const lastErrorOf = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run)
    .filter((item): item is Extract<Item, { type: "error" }> => item.type === "error")
    .at(-1);

const outcomeOf = (mirror: Mirror, run: Run): TurnOutcome => {
  switch (run.status) {
    case "completed":
      return { _tag: "completed" };
    case "failed": {
      const error = lastErrorOf(mirror, run);
      return error === undefined
        ? { _tag: "failed", failure: "unknown", retryAt: null }
        : {
            _tag: "failed",
            failure: FAILURES[error.failure.class],
            retryAt: parseInstant(error.failure.resetAt),
          };
    }
    case "cancelled":
      // A queued turn cancelled before it began, or a running one an engine restart ended.
      return hasStarted(run) ? { _tag: "interrupted" } : { _tag: "cancelled" };
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

/**
 * The resume the engine will start on its own for an ended run, by its rule
 * for a usage limit (**Read** at `db51b67`, `UsageLimitRecoveryWorker.ts`,
 * `limitRecoveryCommand`): the thread's latest run failed at a usage limit
 * whose reset comes after the failure, nothing resumed it yet, the thread is
 * not archived, and the engine has not armed the recovery without an
 * automatic resume. J3 Bots provisions automatic resume on.
 */
const continuationOf = (mirror: Mirror, run: Run): PendingContinuation | null => {
  if (run.status !== "failed" || isRetired(mirror)) return null;
  if (runsInOrder(mirror).at(-1)?.id !== run.id) return null;
  const error = lastErrorOf(mirror, run);
  if (error === undefined || error.failure.class !== "usage_limit") return null;
  const resumesAt = parseInstant(error.failure.resetAt);
  if (resumesAt === null) return null;
  if (run.completedAt !== null && !DateTime.isGreaterThan(resumesAt, run.completedAt)) return null;
  const armed = mirror.thread?.limitRecovery;
  if (armed !== undefined && armed !== null && armed.runId === run.id && !armed.autoResume) {
    return null;
  }
  return { resumesAt };
};

/** Whether a continuation run for `run` exists: its pending continuation ran. */
const wasContinued = (mirror: Mirror, run: Run) =>
  [...mirror.runs.values()].some(
    (candidate) =>
      candidate.usageLimitContinuationOfRunId === run.id ||
      candidate.restartContinuationOfRunId === run.id ||
      candidate.manualContinuationOfRunId === run.id,
  );

// ---------------------------------------------------------------------------
// Steps, host speech and `j3` tool calls

const label = (text: string | null | undefined, fallback: string) => {
  const line =
    (text ?? "")
      .split("\n")
      .find((part) => part.trim().length > 0)
      ?.trim() ?? "";
  const chosen = line.length > 0 ? line : fallback;
  return chosen.length > 200 ? `${chosen.slice(0, 199)}…` : chosen;
};

type DynamicTool = Extract<Item, { type: "dynamic_tool" }>;

const SEND_TO_USER = /(^|__|\/|\.)send_to_user$/;

const isHostSpeech = (item: Item): item is DynamicTool =>
  item.type === "dynamic_tool" && item.toolName !== null && SEND_TO_USER.test(item.toolName);

/**
 * How each harness names a `j3` tool on the engine's item: `mcp__j3__say` on
 * Claude Code, `j3.say` on Codex and on ACP agents (**Read** at `db51b67`,
 * `ensureToolCallStarted`; the ACP form **Verified** on the engine's own MCP
 * server).
 */
const J3_TOOL = new RegExp(`^(?:mcp__${TOOL_SERVER}__|${TOOL_SERVER}[./])(.+)$`, "s");

/** The bare `j3` tool name an item calls, if it calls one. */
const j3ToolOf = (item: Item): string | undefined =>
  item.type === "dynamic_tool" && item.toolName !== null
    ? J3_TOOL.exec(item.toolName)?.[1]
    : undefined;

/** Takes the digest of every `j3` tool call input the mirror has not digested yet. */
export const digestToolCalls = (mirror: Mirror): Effect.Effect<void> =>
  Effect.forEach(
    [...mirror.items.values()].filter(
      (item): item is DynamicTool =>
        item.type === "dynamic_tool" &&
        j3ToolOf(item) !== undefined &&
        mirror.toolDigests.get(item.id)?.input !== item.input,
    ),
    (item) =>
      Effect.map(toolInputDigest(item.input), (digest) => {
        mirror.toolDigests.set(item.id, { input: item.input, digest });
      }),
    { discard: true },
  );

const toolCallOf = (mirror: Mirror, item: Item): ToolCall | undefined => {
  const tool = j3ToolOf(item);
  const digested = mirror.toolDigests.get(item.id);
  return tool === undefined || digested === undefined
    ? undefined
    : { callId: ToolCallId.make(localIdFor(item.id)), tool, inputDigest: digested.digest };
};

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
      // Host speech and `j3` calls are events of their own.
      return isHostSpeech(item) || j3ToolOf(item) !== undefined ? undefined : "tool";
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

const SpeechInput = Schema.Struct({ message: Schema.String });
const decodeSpeechInput = Schema.decodeUnknownOption(SpeechInput);

const speechOf = (item: Item): HostSpeech | undefined => {
  if (!isHostSpeech(item) || item.runId === null) return undefined;
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
type AnswerTarget =
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
    case "approval_request":
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
        resolution: runtimeResolution(mirror.requests.get(item.requestId), item),
      };
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

/**
 * A J3 Bots steer the engine holds, by its key, with the run it was sent to:
 * steered into that run (`item`), or kept aside until the run's provider turn
 * starts (`waiting`). Steers are known by their message id, which the engine
 * keeps through all of that.
 */
interface SteerRecord {
  readonly key: IdempotencyKey;
  readonly messageId: string;
  readonly target: string;
  readonly item: UserMessage | undefined;
  readonly waiting: Run | undefined;
}

const steersOf = (mirror: Mirror): ReadonlyArray<SteerRecord> => {
  const steers = new Map<string, SteerRecord>();
  const keyOf = (messageId: string) =>
    Option.flatMap(dispatchOfMessage(messageId), (dispatch) =>
      dispatch.delivery === "steer" ? Option.some(dispatch.key) : Option.none(),
    );
  // The engine's record of the steer in its run comes first: it names the run that has it.
  for (const item of mirror.items.values()) {
    if (!isSteerItem(item) || item.runId === null || steers.has(item.messageId)) continue;
    const key = keyOf(item.messageId);
    if (Option.isSome(key)) {
      steers.set(item.messageId, {
        key: key.value,
        messageId: item.messageId,
        target: item.runId,
        item,
        waiting: undefined,
      });
    }
  }
  for (const run of mirror.runs.values()) {
    if (run.steerWhenReadyRunId === undefined || steers.has(run.userMessageId)) continue;
    const key = keyOf(run.userMessageId);
    if (Option.isSome(key)) {
      steers.set(run.userMessageId, {
        key: key.value,
        messageId: run.userMessageId,
        target: run.steerWhenReadyRunId,
        item: undefined,
        waiting: run,
      });
    }
  }
  return [...steers.values()];
};

/** Whether Stop reached the run: the engine records its interrupt request in the run. */
const wasStopped = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).some((item) => item.type === "run_interrupt_request");

type Settlement =
  | { readonly _tag: "read" }
  | { readonly _tag: "dropped" }
  | { readonly _tag: "requeued"; readonly followUp: Run };

/**
 * How a steer settled, once its target run has ended and the engine has
 * decided. **Read** at `db51b67`, `Orchestrator.ts`, `requeueUnreadSteers`:
 * the run took the steer if its item completed; Stop marks an unread steer's
 * item cancelled; any other end queues the steer as a run of its own, opened
 * with the steer's message. A steer still kept aside when its target ends is
 * dropped by a Stop and otherwise runs as that follow-up itself.
 */
const settlementOf = (mirror: Mirror, steer: SteerRecord): Settlement | undefined => {
  const target = mirror.runs.get(steer.target);
  if (target === undefined || !isEnded(target)) return undefined;
  if (steer.item !== undefined) {
    if (steer.item.status === "completed") return { _tag: "read" };
    if (steer.item.status === "cancelled") return { _tag: "dropped" };
    const followUp = runsInOrder(mirror).find(
      (run) =>
        run.id !== target.id &&
        run.steerWhenReadyRunId === undefined &&
        openingMessageOf(mirror, run) === steer.messageId,
    );
    return followUp === undefined ? undefined : { _tag: "requeued", followUp };
  }
  if (steer.waiting === undefined) return undefined;
  if (
    wasStopped(mirror, target) ||
    (steer.waiting.status === "cancelled" && !hasStarted(steer.waiting))
  ) {
    return { _tag: "dropped" };
  }
  return { _tag: "requeued", followUp: steer.waiting };
};

const steerEventOf = (steer: SteerRecord, settled: Settlement): EventBody => {
  const turnId = TurnId.make(steer.target);
  switch (settled._tag) {
    case "read":
      return { _tag: "steered", key: steer.key, turnId };
    case "dropped":
      return { _tag: "steer-dropped", key: steer.key, turnId };
    case "requeued":
      return {
        _tag: "steer-requeued",
        key: steer.key,
        turnId,
        followUpTurnId: turnIdOf(settled.followUp),
      };
  }
};

/** Whether the engine has any record of the dispatch with this key. */
export const knowsDispatch = (mirror: Mirror, key: IdempotencyKey): boolean => {
  const messages = new Set([messageIdFor("start", key), messageIdFor("steer", key)]);
  for (const run of mirror.runs.values()) if (messages.has(run.userMessageId)) return true;
  for (const item of mirror.items.values()) {
    if (item.type === "user_message" && messages.has(item.messageId)) return true;
  }
  return false;
};

/**
 * How the engine accepted a dispatch it applied just now, read from its record
 * of the dispatch's message. `Option.none()` when it shows no record of it.
 */
export const dispositionOf = (
  mirror: Mirror,
  key: IdempotencyKey,
): Option.Option<DispatchDisposition> => {
  const start = messageIdFor("start", key);
  const steer = messageIdFor("steer", key);
  const steered = steersOf(mirror).find((record) => record.messageId === steer);
  // A steer the engine added to a run or keeps aside for one, read or not.
  if (steered !== undefined) {
    return Option.some({ _tag: "steered", turnId: TurnId.make(steered.target) });
  }
  for (const run of runsInOrder(mirror)) {
    const opening = openingMessageOf(mirror, run);
    if (opening === steer) return Option.some({ _tag: "new-turn", turnId: turnIdOf(run) });
    if (opening !== start) continue;
    const queued = userMessagesOf(mirror, run).some(
      (item) => item.messageId === start && item.inputIntent === "queued_turn",
    );
    return Option.some({ _tag: queued ? "queued" : "started", turnId: turnIdOf(run) });
  }
  return Option.none();
};

// ---------------------------------------------------------------------------
// Diffing a mirror against what the subscriber knows

interface TurnView {
  started: boolean;
  finished: boolean;
  /** Whether the subscriber was told of a continuation that has not run or been dropped. */
  continuation: boolean;
}

/** What the subscriber has been told. Copied, never shared, between cursors. */
export interface View {
  readonly turns: Map<string, TurnView>;
  readonly steps: Map<string, string>;
  readonly speech: Set<string>;
  readonly requests: Map<string, "open" | "closed">;
  readonly toolCalls: Map<string, "open" | "closed">;
  /** Steers whose settlement was reported, by message id. */
  readonly steers: Set<string>;
}

const emptyView = (): View => ({
  turns: new Map(),
  steps: new Map(),
  speech: new Set(),
  requests: new Map(),
  toolCalls: new Map(),
  steers: new Set(),
});

export const copyView = (view: View): View => ({
  turns: new Map([...view.turns].map(([id, turn]) => [id, { ...turn }])),
  steps: new Map(view.steps),
  speech: new Set(view.speech),
  requests: new Map(view.requests),
  toolCalls: new Map(view.toolCalls),
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
  const steers = steersOf(mirror);
  const runs = runsInOrder(mirror);

  // A newer run takes the place of a pending continuation before it starts.
  for (const run of runs) {
    const turn = view.turns.get(run.id);
    if (turn === undefined || !turn.continuation || continuationOf(mirror, run) !== null) continue;
    turn.continuation = false;
    if (!wasContinued(mirror, run)) {
      events.push({ _tag: "continuation-dropped", turnId: turnIdOf(run) });
    }
  }

  for (const run of runs) {
    const turnId = turnIdOf(run);
    const turn = view.turns.get(run.id) ?? { started: false, finished: false, continuation: false };
    view.turns.set(run.id, turn);
    if (isWaitingSteer(mirror, run)) continue;
    if (!turn.finished) {
      if (!turn.started && hasStarted(run)) {
        turn.started = true;
        events.push({ _tag: "turn-started", turnId, cause: causeOf(mirror, run) });
      }
      const ended = isEnded(run);
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
        const call = toolCallOf(mirror, item);
        if (call !== undefined) {
          const seen = view.toolCalls.get(call.callId);
          if (seen === undefined) {
            view.toolCalls.set(call.callId, "open");
            events.push({ _tag: "tool-call", turnId, call, state: "open" });
          }
          // The turn's end closes its calls without a `closed` for each.
          if (view.toolCalls.get(call.callId) === "open" && !LIVE_ITEM.has(item.status) && !ended) {
            view.toolCalls.set(call.callId, "closed");
            events.push({ _tag: "tool-call", turnId, call, state: "closed" });
          }
        }
      }
      for (const state of requestsOf(mirror, run)) {
        const resolution = state.resolution ?? (ended ? ("expired" as const) : undefined);
        if (resolution !== undefined && view.requests.get(state.requestId) === "open") {
          view.requests.set(state.requestId, "closed");
          events.push({ _tag: "request-closed", requestId: state.requestId, turnId, resolution });
        }
      }
      if (ended) {
        turn.finished = true;
        for (const item of itemsOf(mirror, run)) {
          const call = toolCallOf(mirror, item);
          if (call !== undefined) view.toolCalls.set(call.callId, "closed");
        }
        const continuation = continuationOf(mirror, run);
        turn.continuation = continuation !== null;
        events.push({
          _tag: "turn-finished",
          turnId,
          outcome: outcomeOf(mirror, run),
          backgroundWork: hasBackgroundWork(mirror, run),
          continuation,
        });
      }
    }
    // A steer settles only after its target's end, once the engine has decided.
    if (!turn.finished) continue;
    for (const steer of steers) {
      if (steer.target !== run.id || view.steers.has(steer.messageId)) continue;
      const settled = settlementOf(mirror, steer);
      if (settled === undefined) continue;
      view.steers.add(steer.messageId);
      events.push(steerEventOf(steer, settled));
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
  const steerSettlements: Array<SteerSettlement> = [];

  const steers = steersOf(mirror);
  for (const run of runsInOrder(mirror)) {
    const turnId = turnIdOf(run);
    const ended = isEnded(run);
    const listed =
      !ended ||
      (since !== null &&
        (run.completedAt === null || DateTime.isGreaterThanOrEqualTo(run.completedAt, since)));
    if (!listed || isWaitingSteer(mirror, run)) continue;
    if (!ended) {
      openTurns.push({
        turnId,
        cause: causeOf(mirror, run),
        startedAt: hasStarted(run) ? (run.startedAt ?? run.requestedAt) : null,
        steps: stepsOf(mirror, run),
        toolCalls: itemsOf(mirror, run).flatMap((item) => {
          const call = toolCallOf(mirror, item);
          return call !== undefined && LIVE_ITEM.has(item.status) ? [call] : [];
        }),
      });
    } else {
      endedTurns.push({
        turnId,
        cause: causeOf(mirror, run),
        startedAt: hasStarted(run) ? (run.startedAt ?? run.requestedAt) : null,
        finishedAt: run.completedAt ?? run.startedAt ?? run.requestedAt,
        outcome: outcomeOf(mirror, run),
        backgroundWork: hasBackgroundWork(mirror, run),
        continuation: continuationOf(mirror, run),
        steps: stepsOf(mirror, run),
      });
      // A requeued steer shows as its follow-up turn, whose cause is the dispatch.
      for (const steer of steers) {
        if (steer.target !== run.id) continue;
        const settled = settlementOf(mirror, steer);
        if (settled?._tag === "read" || settled?._tag === "dropped") {
          steerSettlements.push({ key: steer.key, turnId, settlement: settled._tag });
        }
      }
    }
    for (const state of requestsOf(mirror, run)) {
      const resolution = state.resolution ?? (ended ? ("expired" as const) : undefined);
      if (resolution === undefined) openRequests.push(openRequestOf(state));
      else if (since !== null) {
        closedRequests.push({ requestId: state.requestId, turnId, resolution });
      }
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
      steers: steerSettlements,
    },
    view,
  };
};

/** The turn running or waiting in the session, if any: for the best-effort busy check. */
export const activeTurn = (mirror: Mirror): Option.Option<TurnId> =>
  Option.map(Option.fromNullishOr(runsInOrder(mirror).find((run) => !isEnded(run))), turnIdOf);

/** Runs waiting in the engine's queue, steers kept aside included. */
export const queuedRuns = (mirror: Mirror) =>
  runsInOrder(mirror).filter((run) => run.status === "queued" || run.status === "preparing");

/** Whether the engine holds the session's queue: its waiting runs do not start on their own. */
export const isQueueHeld = (mirror: Mirror) =>
  queuedRuns(mirror).some((run) => run.queueHeld === true);

/**
 * Whether a Stop made the hold: the engine's stop holds the queue after the run
 * it reached, which carries the interrupt request (**Read** at `db51b67`,
 * `Orchestrator.ts`, `thread.stop`).
 */
export const isHeldByStop = (mirror: Mirror) => {
  const lastRan = runsInOrder(mirror)
    .filter((run) => hasStarted(run))
    .at(-1);
  return lastRan !== undefined && wasStopped(mirror, lastRan);
};
