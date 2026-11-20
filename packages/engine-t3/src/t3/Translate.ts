// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FailureClass, Question, QuestionAnswers, WorkStep } from "@j3-bots/contracts";
import { MAX_CARD_QUESTIONS, MAX_QUESTION_OPTIONS, WorkStepId } from "@j3-bots/contracts";
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
import * as Duration from "effect/Duration";
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

/** A copy of the mirror as it stands, for resuming from it later. Entities are never mutated, only replaced. */
export const copyMirror = (mirror: Mirror): Mirror => ({
  thread: mirror.thread,
  runs: new Map(mirror.runs),
  items: new Map(mirror.items),
  requests: new Map(mirror.requests),
  toolDigests: new Map(mirror.toolDigests),
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
 * A run that carries a steer the engine keeps aside until its target run's
 * provider turn starts. When the target starts, the engine cancels the carrier
 * and steers its message into the target (**Read** at `db51b67`,
 * `Orchestrator.ts`, `queued-message.promote-to-steer`); when a Stop reaches
 * the target first, the steer is dropped. Either way the carrier is no turn,
 * and its cancellation is the steer's, reported as the steer's settlement. It
 * becomes a turn only as the steer's follow-up: when the target ended first,
 * any way but Stop.
 */
const isSteerCarrier = (mirror: Mirror, run: Run) => {
  if (run.steerWhenReadyRunId === undefined || hasStarted(run)) return false;
  const target = mirror.runs.get(run.steerWhenReadyRunId);
  if (target === undefined || !isEnded(target) || wasStopped(mirror, target)) return true;
  // Promoted: the engine steered the carrier's message into the target.
  return [...mirror.items.values()].some(
    (item) => isSteerItem(item) && item.messageId === run.userMessageId,
  );
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

type ErrorItem = Extract<Item, { type: "error" }>;

const errorsOf = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).filter((item): item is ErrorItem => item.type === "error");

/**
 * The failure the engine holds against the run: the latest failed error item
 * of its root node, by update time. **Read** at `db51b67`, `ProjectionStore.ts`
 * (`getLimitRecoveryCandidates`) and `Orchestrator.ts`
 * (`latestRootProviderFailure`).
 */
const rootFailureOf = (mirror: Mirror, run: Run): ErrorItem | undefined =>
  errorsOf(mirror, run)
    .filter((item) => item.status === "failed" && item.nodeId === run.rootNodeId)
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
        b.ordinal - a.ordinal ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    .at(0);

/** The run's failure: its root failure, or, if the engine recorded none, its last error. */
const failureOf = (mirror: Mirror, run: Run) =>
  rootFailureOf(mirror, run) ?? errorsOf(mirror, run).at(-1);

const outcomeOf = (mirror: Mirror, run: Run): TurnOutcome => {
  switch (run.status) {
    case "completed":
      return { _tag: "completed" };
    case "failed": {
      const error = failureOf(mirror, run);
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

/** A run that executed, as the engine counts it: neither queued nor cancelled before it started. */
const wasExecuted = (run: Run) =>
  run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null);

const completedMillis = (run: Run) =>
  run.completedAt === null ? Number.POSITIVE_INFINITY : DateTime.toEpochMillis(run.completedAt);

/**
 * The run the engine's usage-limit recovery looks at: of the runs that
 * executed, one that has not ended, else the one that ended last. **Read** at
 * `db51b67`, `ProjectionStore.ts`, `getLimitRecoveryCandidates`
 * (`latestExecutedRun`).
 */
const latestExecutedRun = (mirror: Mirror): Run | undefined =>
  [...mirror.runs.values()]
    .filter(wasExecuted)
    .sort(
      (a, b) =>
        completedMillis(b) - completedMillis(a) ||
        b.ordinal - a.ordinal ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    .at(0);

/** The engine arms no recovery for a reset more than a day past. **Read**, `MAX_OVERDUE_ARM_MS`. */
const MAX_OVERDUE_ARM = Duration.days(1);

/**
 * The resume the engine will start on its own for an ended run, by its rule
 * for a usage limit (**Read** at `db51b67`: `ProjectionStore.ts`,
 * `getLimitRecoveryCandidates`, and `UsageLimitRecoveryWorker.ts`,
 * `limitRecoveryCommand`): the run is the thread's latest executed run and
 * failed, its root failure is a usage limit whose reset comes after the run
 * ended, the thread is neither archived nor settled, and no runtime request
 * of the thread is pending.
 *
 * The engine arms the resume asynchronously, so the prediction is reconciled
 * with its record once it exists: an armed recovery for this run and reset
 * resumes only with `autoResume`, which Stop turns off. Before it is armed,
 * the engine arms it with automatic resume, which J3 Bots provisions on,
 * unless the reset is more than a day past `now`.
 */
const continuationOf = (
  mirror: Mirror,
  run: Run,
  now: DateTime.Utc,
): PendingContinuation | null => {
  const thread = mirror.thread;
  if (run.status !== "failed" || thread === undefined) return null;
  if (thread.archivedAt !== null || thread.settledOverride === "settled") return null;
  if (latestExecutedRun(mirror)?.id !== run.id) return null;
  const failure = rootFailureOf(mirror, run)?.failure;
  if (
    failure?.class !== "usage_limit" ||
    failure.resetAt === undefined ||
    failure.resetAt === null
  ) {
    return null;
  }
  const resumesAt = parseInstant(failure.resetAt);
  if (resumesAt === null) return null;
  if (!DateTime.isGreaterThan(resumesAt, run.completedAt ?? thread.updatedAt)) return null;
  for (const request of mirror.requests.values()) if (request.status === "pending") return null;
  const armed = thread.limitRecovery;
  if (
    armed !== undefined &&
    armed !== null &&
    armed.runId === run.id &&
    armed.resetAt === failure.resetAt
  ) {
    return armed.autoResume ? { resumesAt } : null;
  }
  if (DateTime.isGreaterThan(now, DateTime.addDuration(resumesAt, MAX_OVERDUE_ARM))) return null;
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

type UserInputRequest = Extract<Item, { type: "user_input_request" }>;
type EngineQuestion = UserInputRequest["questions"][number];

// A card names questions and options by position, in J3 Bots' own ids: the
// engine's keys and values are free text, which a card id cannot always hold
// whole. An answer is mapped back to the engine's own keys and values.
const QUESTION_ID = /^question-([1-9]\d*)$/;
const OPTION_ID = /^option-([1-9]\d*)$/;
const questionIdAt = (index: number) => `question-${index + 1}`;
const optionIdAt = (index: number) => `option-${index + 1}`;
const positionOf = (id: string, pattern: RegExp): number | undefined => {
  const digits = pattern.exec(id)?.[1];
  return digits === undefined ? undefined : Number(digits) - 1;
};

/**
 * What the engine takes for an option: its value, or its label when it has
 * none, exactly as the engine's own client sends it. **Read** at `db51b67`,
 * `packages/client-runtime/src/state/pendingUserInput.ts`
 * (`resolvePendingUserInputOptionValue`).
 */
const optionValueOf = (option: EngineQuestion["options"][number]) =>
  option.value ?? option.label.trim();

const questionOf = (question: EngineQuestion, index: number): Question => ({
  id: questionIdAt(index),
  prompt: question.question.length > 2000 ? question.question.slice(0, 2000) : question.question,
  options: question.options.map((option, optionIndex) => ({
    id: optionIdAt(optionIndex),
    label: label(option.label, "Option"),
    description: option.description.slice(0, 1000),
    style: "default" as const,
  })),
  // The engine's own client takes a typed answer unless the question refuses one.
  acceptsText: question.allowCustomAnswer !== false,
  multiple: question.multiSelect ?? false,
});

/**
 * The card for an engine question, or a notice when a card cannot hold it
 * whole: a question is never shown with parts left out.
 */
const questionRequestOf = (item: UserInputRequest): EngineRequest | undefined => {
  if (item.questions.length > MAX_CARD_QUESTIONS) {
    return {
      _tag: "unsupported-question",
      exceeds: "questions",
      count: item.questions.length,
      max: MAX_CARD_QUESTIONS,
    };
  }
  const widest = Math.max(0, ...item.questions.map((question) => question.options.length));
  if (widest > MAX_QUESTION_OPTIONS) {
    return {
      _tag: "unsupported-question",
      exceeds: "options",
      count: widest,
      max: MAX_QUESTION_OPTIONS,
    };
  }
  const [first, ...rest] = item.questions.map(questionOf);
  return first === undefined ? undefined : { _tag: "question", questions: [first, ...rest] };
};

/**
 * The engine's answers for a card's answers, keyed by the engine's own
 * question ids, or `undefined` when they do not fit the questions, which is
 * the caller's bug. A typed answer is sent alone, as the engine's own client
 * sends it; a question that takes several choices gets the list of their
 * values, one that takes one choice the value itself. A question with neither
 * is left unanswered. **Read** at `db51b67`, `pendingUserInput.ts`
 * (`resolvePendingUserInputAnswer`).
 */
export const engineAnswersOf = (
  questions: ReadonlyArray<EngineQuestion>,
  answers: QuestionAnswers,
): Record<string, string | ReadonlyArray<string>> | undefined => {
  const result: Record<string, string | ReadonlyArray<string>> = {};
  for (const [cardId, answer] of Object.entries(answers)) {
    const position = positionOf(cardId, QUESTION_ID);
    const question = position === undefined ? undefined : questions[position];
    if (question === undefined) return undefined;
    const typed = answer.text?.trim() ?? "";
    if (typed.length > 0) {
      if (question.allowCustomAnswer === false) return undefined;
      result[question.id] = typed;
      continue;
    }
    const values: Array<string> = [];
    for (const optionId of answer.optionIds) {
      const index = positionOf(optionId, OPTION_ID);
      const option = index === undefined ? undefined : question.options[index];
      if (option === undefined) return undefined;
      values.push(optionValueOf(option));
    }
    const [single, ...others] = values;
    if (single === undefined) continue;
    if (question.multiSelect === true) result[question.id] = values;
    else if (others.length === 0) result[question.id] = single;
    else return undefined;
  }
  return result;
};

/** Where the engine takes the answer to a request. */
type AnswerTarget =
  | { readonly _tag: "runtime-request"; readonly requestId: string }
  | {
      readonly _tag: "user-input";
      readonly requestId: string;
      readonly questions: ReadonlyArray<EngineQuestion>;
    }
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
      const request = questionRequestOf(item);
      if (request === undefined) return undefined;
      return {
        requestId: RequestId.make(localIdFor(item.requestId)),
        answerTo: { _tag: "user-input", requestId: item.requestId, questions: item.questions },
        turnId,
        openedAt,
        request,
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
 * How a steer settled, once its target run has ended, from the engine's own
 * record of it. **Read** at `db51b67`, `Orchestrator.ts`, `requeueUnreadSteers`:
 * once the run settles, the engine takes a steer whose item is still pending as
 * unread. It marks it cancelled if Stop reached the run, and otherwise queues
 * it as a run of its own, opened with the steer's message. Any other item
 * state is the engine's claim that the run took it: see `steered` in
 * `events.ts` for the provider paths that claim it without proof. A steer still
 * kept aside when its target ends is dropped by a Stop and otherwise runs as
 * that follow-up itself.
 */
const settlementOf = (mirror: Mirror, steer: SteerRecord): Settlement | undefined => {
  const target = mirror.runs.get(steer.target);
  if (target === undefined || !isEnded(target)) return undefined;
  if (steer.item !== undefined) {
    if (steer.item.status === "cancelled") return { _tag: "dropped" };
    const followUp = runsInOrder(mirror).find(
      (run) =>
        run.id !== target.id &&
        run.steerWhenReadyRunId === undefined &&
        openingMessageOf(mirror, run) === steer.messageId,
    );
    if (followUp !== undefined) return { _tag: "requeued", followUp };
    // Still unread: the engine has not decided yet.
    if (LIVE_ITEM.has(steer.item.status)) return undefined;
    return { _tag: "read" };
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

/**
 * The session's queue hold as the subscriber knows it.
 * - `none`: no hold, or no turn waiting.
 * - `reported`: held, and a `queue-held` said so.
 * - `released`: released after a report, with turns still waiting and none
 *   started or finished since.
 * - `unreported`: held again right after a release, with no turn started or
 *   finished in between: the engine's answer to a resume while a replaced
 *   provider session still runs background work. `background` is the
 *   background work live at that moment.
 */
type HoldView =
  | { readonly state: "none" | "reported" | "released" }
  | { readonly state: "unreported"; readonly background: ReadonlySet<string> };

/** What the subscriber has been told. Copied, never shared, between cursors. */
export interface View {
  readonly turns: Map<string, TurnView>;
  readonly steps: Map<string, string>;
  readonly speech: Set<string>;
  readonly requests: Map<string, "open" | "closed">;
  readonly toolCalls: Map<string, "open" | "closed">;
  /** Steers whose settlement was reported, by message id. */
  readonly steers: Set<string>;
  hold: HoldView;
}

const emptyView = (): View => ({
  turns: new Map(),
  steps: new Map(),
  speech: new Set(),
  requests: new Map(),
  toolCalls: new Map(),
  steers: new Set(),
  hold: { state: "none" },
});

export const copyView = (view: View): View => ({
  turns: new Map([...view.turns].map(([id, turn]) => [id, { ...turn }])),
  steps: new Map(view.steps),
  speech: new Set(view.speech),
  requests: new Map(view.requests),
  toolCalls: new Map(view.toolCalls),
  steers: new Set(view.steers),
  hold: view.hold,
});

/** Turn items of background work still running: what a replaced provider session may be busy with. */
const liveBackground = (mirror: Mirror): ReadonlySet<string> =>
  new Set(
    [...mirror.items.values()].flatMap((item) =>
      LIVE_ITEM.has(item.status) &&
      ((item.type === "command_execution" && item.completionWake === "always") ||
        item.type === "subagent")
        ? [item.id]
        : [],
    ),
  );

/**
 * One `queue-held` per hold, and the view moved on. The engine holds a queue
 * by marking each waiting run, so a hold begins when the first is marked.
 * `moved` says a turn started or finished in this batch.
 *
 * The engine answers a resume with a new hold, before any turn starts, while a
 * replaced provider session still runs background work (**Read** at `db51b67`,
 * `Orchestrator.ts`, `startNextQueuedRun`). The engine learns that from the
 * provider process (`sessionHasBackgroundWork`), which is not on the wire, so
 * such a hold is reported once some of the background work live when it began
 * has ended, or a turn starts or finishes, whichever comes first. A turn
 * starting while the queue stays held reports the hold again too: whatever the
 * server resumed did not release it.
 */
const holdEventsOf = (
  mirror: Mirror,
  view: View,
  moved: { readonly started: boolean; readonly finished: boolean },
): ReadonlyArray<EventBody> => {
  const held = isQueueHeld(mirror);
  const report = (): ReadonlyArray<EventBody> => {
    view.hold = { state: "reported" };
    return [{ _tag: "queue-held" }];
  };
  const anyMoved = moved.started || moved.finished;
  const hold = view.hold;
  switch (hold.state) {
    case "none":
      return held ? report() : [];
    case "reported":
      if (!held) view.hold = { state: queuedRuns(mirror).length > 0 ? "released" : "none" };
      return held && moved.started ? report() : [];
    case "released":
      if (!held) {
        if (anyMoved || queuedRuns(mirror).length === 0) view.hold = { state: "none" };
        return [];
      }
      if (anyMoved) return report();
      view.hold = { state: "unreported", background: liveBackground(mirror) };
      return [];
    case "unreported": {
      if (!held) {
        view.hold = { state: "none" };
        return [];
      }
      const live = liveBackground(mirror);
      const ended = [...hold.background].some((id) => !live.has(id));
      return anyMoved || ended ? report() : [];
    }
  }
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A session event before it gets its cursor and time. */
export type EventBody = DistributiveOmit<SessionEvent, "cursor" | "at">;

/**
 * The events that bring a subscriber from `view` to `mirror`, in order, and
 * `view` updated to match. Applying them to `view` again yields nothing.
 */
export const diff = (mirror: Mirror, view: View, now: DateTime.Utc): ReadonlyArray<EventBody> => {
  const events: Array<EventBody> = [];
  const steers = steersOf(mirror);
  const runs = runsInOrder(mirror);

  // A newer run takes the place of a pending continuation before it starts.
  for (const run of runs) {
    const turn = view.turns.get(run.id);
    if (turn === undefined || !turn.continuation || continuationOf(mirror, run, now) !== null) {
      continue;
    }
    turn.continuation = false;
    if (!wasContinued(mirror, run)) {
      events.push({ _tag: "continuation-dropped", turnId: turnIdOf(run) });
    }
  }

  for (const run of runs) {
    const turnId = turnIdOf(run);
    const turn = view.turns.get(run.id) ?? { started: false, finished: false, continuation: false };
    view.turns.set(run.id, turn);
    if (isSteerCarrier(mirror, run)) continue;
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
        const continuation = continuationOf(mirror, run, now);
        turn.continuation = continuation !== null;
        events.push({
          _tag: "turn-finished",
          turnId,
          cause: causeOf(mirror, run),
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
  events.push(
    ...holdEventsOf(mirror, view, {
      started: events.some((event) => event._tag === "turn-started"),
      finished: events.some((event) => event._tag === "turn-finished"),
    }),
  );
  return events;
};

/**
 * The `replaced` event for a subscriber that resumes without a view, and the
 * view that matches it. With `history`, it lists every ended turn of the
 * session, every use of host speech, every request resolution and every steer
 * settlement, whenever each happened: the engine keeps no sequence for a
 * turn's end or a settlement, and a steer or a request can settle after its
 * turn ended, so nothing narrower is safe. A session is rotated after a
 * bounded number of turns, which bounds the list. Without `history`, for a
 * subscriber with no cursor, it lists only what is open.
 */
export const replacement = (
  mirror: Mirror,
  history: boolean,
  now: DateTime.Utc,
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
    if ((ended && !history) || isSteerCarrier(mirror, run)) continue;
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
        continuation: continuationOf(mirror, run, now),
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
      else if (history) closedRequests.push({ requestId: state.requestId, turnId, resolution });
    }
    if (history) {
      for (const item of itemsOf(mirror, run)) {
        const speech = speechOf(item);
        if (speech !== undefined) hostSpeech.push(speech);
      }
    }
  }

  // The subscriber now knows everything in the mirror.
  const view = emptyView();
  diff(mirror, view, now);
  return {
    event: {
      _tag: "replaced",
      openTurns,
      openRequests,
      endedTurns,
      hostSpeech,
      closedRequests,
      steers: steerSettlements,
      // Stands for a hold the fresh view reports.
      queueHeld: view.hold.state === "reported",
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

/**
 * Whether the engine holds the session's queue: its waiting runs do not start
 * on their own. The engine marks each waiting run, not the thread (**Read** at
 * `db51b67`, `OrchestrationV2Run.queueHeld`).
 */
const isQueueHeld = (mirror: Mirror) => queuedRuns(mirror).some((run) => run.queueHeld === true);
