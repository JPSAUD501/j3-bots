// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FailureClass, Question, QuestionAnswers, WorkStep } from "@j3-bots/contracts";
import { MAX_CARD_QUESTIONS, MAX_QUESTION_OPTIONS, WorkStepId } from "@j3-bots/contracts";
import {
  isOrchestrationV2WorkActive,
  isQueuedProviderThreadPlaceholder,
  OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { DispatchDisposition } from "../Engine.ts";
import {
  type BackgroundWork,
  type EndedTurn,
  type EngineRequest,
  type HostSpeech,
  type OpenRequest,
  type OpenTurn,
  type PendingContinuation,
  type RequestResolution,
  type SessionEvent,
  type SteerSettlement,
  type ToolCall,
  type TurnCause,
  type TurnOutcome,
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
import {
  approvalOf,
  fileChangeWithoutDiff,
  heldConnectorCall,
  type FileChangeItem,
  sameVersion,
} from "./approvalDetail.ts";
import { dispatchOfMessage, localIdFor, messageIdFor } from "./Keys.ts";
import { TOOL_SERVER } from "./Provision.ts";
import { isStepTool, toolStep } from "./toolNames.ts";
import { hasPersistentFlag, type ToolPersistence } from "./toolPersistence.ts";

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
type ProviderThread = OrchestrationV2ProviderThread;
type ProviderSession = OrchestrationV2ProviderSession;
type Message = OrchestrationV2ConversationMessage;

/** The engine's state of one thread, as far as J3 Bots reads it. */
export interface Mirror {
  /** `undefined` until the engine has sent it. */
  thread: Thread | undefined;
  readonly runs: Map<string, Run>;
  readonly items: Map<string, Item>;
  readonly requests: Map<string, RuntimeRequest>;
  /**
   * Read only for the background work they report (`backgroundWorkOf`,
   * `hasBackgroundWork`), each task attributed to its run (`attributeTasks`).
   */
  readonly providerThreads: Map<string, ProviderThread>;
  /**
   * The status of each provider session the engine has bound to the thread,
   * by id: one attached and not yet detached (`applyEvent`). Read only for
   * which provider threads' background work is still live
   * (`backgroundWorkOf`).
   */
  readonly providerSessions: Map<string, ProviderSession["status"]>;
  /**
   * The message each run opened with, by run id, as its first record carried
   * it: a steering restart moves the run's `userMessageId` to the steer, on
   * the same run (`openingMessageOf`).
   */
  readonly openings: Map<string, string>;
  /**
   * The run each run's opening message names as the one that delegated the
   * task whose completion it reports, or `null` for a message that names
   * none, by run id, once the mirror has the message: the origin of the
   * `background` turn the run is (`causeOf`).
   */
  readonly origins: Map<string, string | null>;
  /**
   * `toolInputDigest` of each `j3` tool call's input, by item id, with the
   * input it was taken of. Kept by `digestToolCalls`, which `diff` relies on.
   */
  readonly toolDigests: Map<string, { readonly input: unknown; readonly digest: ToolInputDigest }>;
  /**
   * File changes held by open approvals, fetched whole because the stream
   * sends them without their diff, by item id. Each is the version an open
   * approval holds: an entry goes when its approval closes or its item moves
   * on, so a fetched diff, up to the engine's limit, is kept only while a card
   * can show it. See `approvalDetail.ts`.
   */
  readonly fetched: Map<string, FileChangeItem>;
  /**
   * Whether each live dynamic tool whose input the stream summarized runs on
   * purpose, as the adapter's reads of it settled it, by item id. See
   * `toolWork`.
   */
  readonly toolPersistence: Map<string, ToolPersistence>;
}

export const emptyMirror = (): Mirror => ({
  thread: undefined,
  runs: new Map(),
  items: new Map(),
  requests: new Map(),
  providerThreads: new Map(),
  providerSessions: new Map(),
  openings: new Map(),
  origins: new Map(),
  toolDigests: new Map(),
  fetched: new Map(),
  toolPersistence: new Map(),
});

/** A copy of the mirror as it stands, for resuming from it later. Entities are never mutated, only replaced. */
export const copyMirror = (mirror: Mirror): Mirror => ({
  thread: mirror.thread,
  runs: new Map(mirror.runs),
  items: new Map(mirror.items),
  requests: new Map(mirror.requests),
  providerThreads: new Map(mirror.providerThreads),
  providerSessions: new Map(mirror.providerSessions),
  openings: new Map(mirror.openings),
  origins: new Map(mirror.origins),
  toolDigests: new Map(mirror.toolDigests),
  fetched: new Map(mirror.fetched),
  toolPersistence: new Map(mirror.toolPersistence),
});

/**
 * The mirror of a snapshot. File changes fetched before it still count for
 * the open approvals the snapshot has holding them at the same version, and
 * a tool's persistence for as long as the snapshot has its item.
 */
export const mirrorOf = (
  projection: OrchestrationV2ThreadProjection,
  before: Pick<Mirror, "fetched" | "toolPersistence"> = emptyMirror(),
): Mirror => {
  const items: Map<string, Item> = new Map(projection.turnItems.map((item) => [item.id, item]));
  const messages = new Map<string, Message>(
    projection.messages.map((message) => [message.id, message]),
  );
  const openings = new Map(
    projection.runs.flatMap((run) => {
      const opening = snapshotOpening(run, runItems(items.values(), run), projection.messages);
      return opening === undefined ? [] : [[run.id, opening]];
    }),
  );
  const mirror: Mirror = {
    thread: projection.thread,
    runs: new Map(projection.runs.map((run) => [run.id, run])),
    items,
    requests: new Map(projection.runtimeRequests.map((request) => [request.id, request])),
    providerThreads: new Map(projection.providerThreads.map((thread) => [thread.id, thread])),
    providerSessions: new Map(
      projection.providerSessions.map((session) => [session.id, session.status]),
    ),
    openings,
    origins: new Map(
      [...openings].map(([runId, messageId]) => [
        runId,
        delegatedOriginOf(messages.get(messageId)),
      ]),
    ),
    toolDigests: new Map(),
    fetched: new Map(before.fetched),
    toolPersistence: new Map([...before.toolPersistence].filter(([id]) => items.has(id))),
  };
  dropUnheld(mirror);
  return mirror;
};

const isThread = Schema.is(OrchestrationV2AppThread);

/** The run a delegated task's completion message names as the one that delegated it. */
const delegatedOriginOf = (message: Message | undefined): string | null =>
  message?.delegatedCompletion?.parentRunId ?? null;

/** Applies one engine event. Returns whether it touched what the session's events are made of. */
export const applyEvent = (mirror: Mirror, event: OrchestrationV2DomainEvent): boolean => {
  switch (event.type) {
    case "run.created":
    case "run.updated":
      // The first record of a run carries the message it opened with: the
      // engine creates it with that message (**Read** at `db51b67`,
      // `Orchestrator.ts`, L8019, L8458, L9270) and a steering restart moves
      // `userMessageId` to the steer later, on the same run (L6805-6815). A
      // run the mirror had from a snapshot already has its opening, if any.
      if (!mirror.runs.has(event.payload.id)) {
        mirror.openings.set(event.payload.id, event.payload.userMessageId);
      }
      mirror.runs.set(event.payload.id, event.payload);
      return true;
    case "turn-item.updated":
      mirror.items.set(event.payload.id, event.payload);
      dropUnheld(mirror);
      return true;
    case "runtime-request.updated":
      mirror.requests.set(event.payload.id, event.payload);
      dropUnheld(mirror);
      return true;
    case "provider-thread.updated":
      // No session event is made of it. A provider-thread task ending changes
      // only `backgroundWorkOf`, which the Stop runner reads afresh on
      // its periodic synchronize while a Stop waits on that work. A task
      // starting is read at its run's end (`hasBackgroundWork`).
      //
      // The provider thread the event reports becomes the thread's active
      // one, unless it only reserves a seat for a queued run, as the engine's
      // projection applies it (**Read** at `db51b67`, `ProjectionStore.ts`,
      // L1142-1150): a fresh-context start switches it so, with no thread
      // event, and the engine's stop fires only for the active one's tasks or
      // live items (`backgroundWorkOf`).
      if (
        mirror.thread !== undefined &&
        event.payload.appThreadId === mirror.thread.id &&
        !isQueuedProviderThreadPlaceholder(event.payload)
      ) {
        mirror.thread = { ...mirror.thread, activeProviderThreadId: event.payload.id };
      }
      mirror.providerThreads.set(
        event.payload.id,
        attributeTasks(event.payload, mirror.providerThreads.get(event.payload.id), event.runId),
      );
      return false;
    case "provider-session.attached":
    case "provider-session.updated":
      // As for a provider thread: only `backgroundWorkOf` reads it. The
      // engine's stored projection binds a session to the thread when it is
      // attached and unbinds it when it is detached; an update changes only
      // its status (**Read** at `db51b67`, `ProjectionStore.ts`, L2773-2826).
      // The engine reads a thread's sessions through those bindings: the
      // records a command such as the stop starts from, the snapshots
      // (`readCanonicalProjection`, L4312-4335) and recovery (L5705-5720).
      // Its in-memory projector upserts a session on an update too
      // (`applyToProjection`, L1129-1134), but it only folds a command's own
      // events onto the records that command read from the store, so the
      // bindings are what the next command sees, and the adapter follows
      // them: an update for a session not attached, such as a late one after
      // its detach, binds nothing.
      if (
        event.type === "provider-session.attached" ||
        mirror.providerSessions.has(event.payload.id)
      ) {
        mirror.providerSessions.set(event.payload.id, event.payload.status);
      }
      return false;
    case "provider-session.detached":
      mirror.providerSessions.delete(event.payload.providerSessionId);
      return false;
    case "message.updated": {
      // The engine records a run's opening message in the command that
      // creates the run, after `run.created` (**Read** at `db51b67`,
      // `Orchestrator.ts`: the queued run at L8128 and its message at L8184,
      // a start at L8617 and L8669, L9643 and L9691), so a turn's origin is
      // known before it can start, though not yet when the run is created
      // queued. Only the run's opening message counts: a delegated
      // completion steered into a running run is not that run's cause.
      const { id, runId } = event.payload;
      if (runId === null || mirror.openings.get(runId) !== id) return false;
      mirror.origins.set(runId, delegatedOriginOf(event.payload));
      return true;
    }
    default:
      // Every thread event carries the whole thread record.
      if (event.type.startsWith("thread.") && isThread(event.payload)) {
        mirror.thread = event.payload;
        return true;
      }
      return false;
  }
};

/**
 * The provider thread with each of its tasks attributed to the run it first
 * appeared under, as the engine's projection stamps it: an adapter resends its
 * whole roster without runs, so a task keeps the run it had, and a new one
 * takes the run of the event that reported it (**Read** at `db51b67`,
 * `ProjectionStore.ts`, `attributePendingBackgroundTasks`, L936-954, applied
 * at L1153-1159). The stream carries the event as the adapter reported it; a
 * snapshot carries the stamped thread.
 */
const attributeTasks = (
  next: ProviderThread,
  previous: ProviderThread | undefined,
  runId: Run["id"] | undefined,
): ProviderThread => {
  const tasks = next.pendingBackgroundTasks ?? [];
  if (tasks.every((task) => task.runId !== undefined)) return next;
  const known = new Map(
    (previous?.pendingBackgroundTasks ?? []).map((task) => [task.taskId, task.runId]),
  );
  return {
    ...next,
    pendingBackgroundTasks: tasks.map((task) => {
      const owner = task.runId ?? (known.has(task.taskId) ? known.get(task.taskId) : runId);
      return owner === undefined ? task : { ...task, runId: owner };
    }),
  };
};

/** Whether the session was retired: the engine archived its thread. */
export const isRetired = (mirror: Mirror) =>
  mirror.thread !== undefined && mirror.thread.archivedAt !== null;

/**
 * Whether the engine deleted the session's thread: the engine's word that the
 * session is gone, as `isMissingThread` is for a thread it has no record of.
 * A deletion keeps the thread's projection and only stamps `deletedAt` on it,
 * in the `thread.deleted` event too, so a read still succeeds (**Read** at
 * `db51b67`, `ThreadDeletion.ts`, L56-66).
 */
export const isDeleted = (mirror: Mirror) =>
  mirror.thread !== undefined && mirror.thread.deletedAt !== null;

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

/** When a run's provider turn started, as the engine recorded it. */
const startedAtOf = (run: Run) => run.startedAt ?? run.requestedAt;

/** When a run ended, as the engine recorded it. */
const finishedAtOf = (run: Run) => run.completedAt ?? run.startedAt ?? run.requestedAt;

const turnIdOf = (run: Run) => TurnId.make(run.id);

const runsInOrder = (mirror: Mirror) =>
  [...mirror.runs.values()].sort((a, b) => a.ordinal - b.ordinal);

const runItems = (items: Iterable<Item>, run: Run) =>
  [...items].filter((item) => item.runId === run.id).sort((a, b) => a.ordinal - b.ordinal);

const itemsOf = (mirror: Mirror, run: Run) => runItems(mirror.items.values(), run);

type UserMessage = Extract<Item, { type: "user_message" }>;

const STEER_INTENTS: ReadonlySet<UserMessage["inputIntent"]> = new Set([
  "steer",
  "promoted_queued_to_steer",
]);

const isSteerItem = (item: Item): item is UserMessage =>
  item.type === "user_message" && STEER_INTENTS.has(item.inputIntent);

const userMessagesIn = (items: ReadonlyArray<Item>) =>
  items.filter((item): item is UserMessage => item.type === "user_message");

const userMessagesOf = (mirror: Mirror, run: Run) => userMessagesIn(itemsOf(mirror, run));

/**
 * The message a run opened with, from its items: its first message item that
 * is not a steer, or `userMessageId` while it has no message item. A run that
 * opened with a notification, as a wake does, has only steer items once
 * steered, and the item tells nothing then.
 */
const openingFromItems = (items: ReadonlyArray<Item>, run: Run): string | undefined => {
  const messages = userMessagesIn(items);
  const opening = messages.find((item) => !STEER_INTENTS.has(item.inputIntent));
  if (opening !== undefined) return opening.messageId;
  return messages.length === 0 ? run.userMessageId : undefined;
};

/**
 * The message a run opened with, in a snapshot, where the run's first record
 * is not to be had: from its items, or else the user message the engine
 * records under the run that none of its message items carries, the one a
 * notification item stands for (**Read** at `db51b67`, `notification.ts`,
 * `notificationTurnItem`, L229-253).
 */
const snapshotOpening = (
  run: Run,
  items: ReadonlyArray<Item>,
  messages: ReadonlyArray<Message>,
): string | undefined => {
  const fromItems = openingFromItems(items, run);
  if (fromItems !== undefined) return fromItems;
  const carried = new Set(userMessagesIn(items).map((item) => item.messageId));
  return messages.find(
    (message) => message.runId === run.id && message.role === "user" && !carried.has(message.id),
  )?.id;
};

/**
 * The message a run was started for: what its first attempt ran. Not
 * `run.userMessageId`, which the engine moves to a steer it restarts the run
 * with (**Verified**), but the message its first record carried
 * (`Mirror.openings`), or, for a run the mirror had from a snapshot without
 * one, what its items tell.
 */
const openingMessageOf = (mirror: Mirror, run: Run): string | undefined =>
  mirror.openings.get(run.id) ?? openingFromItems(itemsOf(mirror, run), run);

/**
 * Whether the engine queued the run behind another turn rather than starting
 * it at once. It creates such a run `queued`, with no item for its message,
 * where a start it begins at once is `starting` from the outset; it records
 * the message, marked `queued_turn`, only as the run leaves the queue (**Read**
 * at `db51b67`, `Orchestrator.ts`: the queued run at L8012-8060, the start at
 * L8451-8461, the promotion at L3035-3097). A follow-up the engine queues for
 * an unread steer reuses the steer's item, marked `queued_turn` at once
 * (L8192-8215). A run cancelled while it waited keeps neither mark: the engine
 * clears its queue position (L1216-1231), and its message was never recorded,
 * which a start the engine begins at once always is, in the same command
 * (L8555-8690).
 */
const wasQueued = (mirror: Mirror, run: Run) => {
  if (run.status === "queued") return true;
  const messages = userMessagesOf(mirror, run);
  if (run.status === "cancelled" && !hasStarted(run) && messages.length === 0) return true;
  const opening = openingMessageOf(mirror, run);
  return messages.some((item) => item.messageId === opening && item.inputIntent === "queued_turn");
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

const dispatchOfRun = (mirror: Mirror, run: Run) => {
  const opening = openingMessageOf(mirror, run);
  return opening === undefined ? Option.none() : dispatchOfMessage(opening);
};

const continuedRunOf = (run: Run) =>
  run.restartContinuationOfRunId ??
  run.usageLimitContinuationOfRunId ??
  run.manualContinuationOfRunId;

/**
 * The run's cause, the same in each of its turn's events, also through a
 * steer that restarts it (`openingMessageOf`). The engine records a run's
 * opening message, which names a wake's origin, in the command that creates
 * the run, before the run can start or end (`applyEvent`): of the turn's
 * events only `turn-queued` can come before it, and waits for it
 * (`isCauseTold`).
 */
const causeOf = (mirror: Mirror, run: Run): TurnCause => {
  const continued = continuedRunOf(run);
  if (continued !== undefined) return { _tag: "continuation", turnId: TurnId.make(continued) };
  const dispatch = dispatchOfRun(mirror, run);
  if (Option.isSome(dispatch)) return { _tag: "dispatch", key: dispatch.value.key };
  const origin = mirror.origins.get(run.id) ?? null;
  return { _tag: "background", origin: origin === null ? null : TurnId.make(origin) };
};

/**
 * Whether the mirror can tell the run's cause: it can unless the engine
 * started the run on its own and the mirror has its first record but not yet
 * the message it opened with. A run the mirror had from a snapshot is told.
 */
const isCauseTold = (mirror: Mirror, run: Run) =>
  continuedRunOf(run) !== undefined ||
  Option.isSome(dispatchOfRun(mirror, run)) ||
  !mirror.openings.has(run.id) ||
  mirror.origins.has(run.id);

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

/**
 * Whether the engine ran the turn in a fresh provider conversation seeded with
 * its own summary of the old one: the run carries a `handoff` item. At
 * `db51b67` the engine records one when the provider fails to resume its
 * native session (`ProviderTurnStartService.ts`, "Recovered context"), and when
 * a thread moves to another provider or imports another thread's context
 * (`Orchestrator.ts`), which J3 Bots never asks for. **Read**.
 */
const hasRecoveredContext = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).some((item) => item.type === "handoff");

/**
 * A task the provider reports that holds the agent's completion: the agent
 * resumes when it ends. The engine's rule (**Read** at `db51b67`,
 * `orchestrationV2PendingBackgroundWork.ts`, `backgroundWorkHoldsCompletion`,
 * L102-121): one the agent marked awaited (`contracts/orchestrationV2.ts`,
 * L1107-1111), or a subagent or background task. A command or a monitor
 * holds only when awaited: it is as often a dev server or its watchdog as a
 * wait. Claude Code wakes the session when a background shell or a monitor
 * ends, awaited or not (**Read**, `ClaudeAdapterV2.ts`, L6207-6208; the
 * `claude_background_task_wake` and `claude_background_monitor_wake`
 * fixtures), so one not awaited may still bring a background turn.
 */
const holdsCompletion = (task: OrchestrationV2PendingBackgroundTask) =>
  task.awaited === true || task.kind === "subagent" || task.kind === "background_task";

/**
 * Whether work the turn started can still wake the session after it ends: a
 * live subagent, a command whose completion wakes it, or a task the provider
 * reports under the turn's run that holds the agent's completion.
 */
const hasBackgroundWork = (mirror: Mirror, run: Run) =>
  itemsOf(mirror, run).some(
    (item) =>
      LIVE_ITEM.has(item.status) &&
      ((item.type === "command_execution" && item.completionWake === "always") ||
        item.type === "subagent"),
  ) ||
  [...mirror.providerThreads.values()].some((thread) =>
    (thread.pendingBackgroundTasks ?? []).some(
      (task) => task.runId === run.id && holdsCompletion(task),
    ),
  );

const ACTIVE_RUN: ReadonlySet<Run["status"]> = new Set(["preparing", "starting", "running"]);
// Over the shell's statuses, a run's and `idle`, which is not among them: a
// shell left idle has not settled.
const SETTLED_FOR_BACKGROUND: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);
const BACKGROUND_ITEM: ReadonlySet<Item["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

/**
 * The stream's stand-in for a dynamic tool input above 16 KiB, which drops
 * the input's `persistent` flag. **Read** at `db51b67`, `WireProjection.ts`,
 * `summarizeDynamicValue` (L29, L69-107) as `projectTurnItemForWire` applies
 * it to a dynamic tool (L190-197).
 */
const isSummarizedInput = (input: unknown) =>
  Predicate.hasProperty(input, "summary") &&
  Predicate.hasProperty(input, "truncated") &&
  input.truncated === true;

/**
 * How a live dynamic tool counts in the engine's rule. One the agent keeps
 * running on purpose never counts (**Read** at `db51b67`,
 * `orchestrationV2PendingBackgroundWork.ts`, `pendingBackgroundTurnItems`,
 * L242-258). For an input the stream summarized, the adapter's read of the
 * item tells (`toolPersistence.ts`): until a read settles it, the tool is
 * pending, so a Stop waits on it and keeps sending fresh rounds while it does.
 * One no read of the item can decide is `undecided`: the engine's own
 * projection of its pending work, which reads the stored input, decides it
 * (`workInShell`).
 */
const toolWork = (mirror: Mirror, item: DynamicTool): "pending" | "undecided" | "none" => {
  if (!isSummarizedInput(item.input)) return hasPersistentFlag(item.input) ? "none" : "pending";
  switch (mirror.toolPersistence.get(item.id)) {
    case "persistent":
      return "none";
    case "undecidable":
      return "undecided";
    case "transient":
    case undefined:
      return "pending";
  }
};

/** Live dynamic tools whose input the stream summarized: those whose persistence a read tells. */
const summarizedTools = (mirror: Mirror): ReadonlyArray<string> =>
  [...mirror.items.values()].flatMap((item) =>
    item.type === "dynamic_tool" &&
    isOrchestrationV2WorkActive(item.status) &&
    isSummarizedInput(item.input)
      ? [item.id]
      : [],
  );

/**
 * Whether the mirror shows the item ended, or no longer a dynamic tool: what
 * was learned of its persistence is no longer needed. False for an item the
 * mirror does not have, which it may not have seen yet.
 */
export const isEndedTool = (mirror: Mirror, itemId: string): boolean => {
  const item = mirror.items.get(itemId);
  return (
    item !== undefined &&
    (item.type !== "dynamic_tool" || !isOrchestrationV2WorkActive(item.status))
  );
};

/**
 * Live dynamic tools whose input the stream summarized and whose persistence
 * no read of the item settled yet: a read that failed leaves one here, to be
 * read again once its backoff passed.
 */
export const toolsToResolve = (mirror: Mirror): ReadonlyArray<string> =>
  summarizedTools(mirror).filter((itemId) => !mirror.toolPersistence.has(itemId));

/** The session's latest run, as the engine's stop picks it: the last one that is not queued. */
const latestRun = (mirror: Mirror) =>
  runsInOrder(mirror)
    .filter((run) => run.status !== "queued")
    .at(-1);

/**
 * A live dynamic tool whose persistence no read of the item could decide
 * (`toolWork`): the engine's task id of it, and the turn that started it,
 * if any.
 */
export interface UndecidedTool {
  readonly taskId: string;
  readonly turnId: TurnId | null;
}

/**
 * The session's background work as the mirror shows it, by the turn that
 * started each piece: work pending, which says whether the engine's stop
 * counts any of it, and live dynamic tools whose persistence no read of the
 * item could decide, which the engine's own projection decides
 * (`workInShell`).
 */
export interface MirroredWork {
  readonly pending: BackgroundWork;
  readonly undecided: ReadonlyArray<UndecidedTool>;
}

/**
 * The engine's id of the pending task a live item is listed as (**Read** at
 * `db51b67`, `orchestrationV2PendingBackgroundWork.ts`,
 * `nativeTaskIdFromTurnItem`, L234-240): the provider's id of the item, or the
 * item's own.
 */
const taskIdOf = (item: Item) => item.nativeItemRef?.nativeId ?? item.id;

/**
 * Background work by the turn that started it, the turns in the order they
 * ran. A turn the mirror no longer has comes after those it has.
 */
const workBy = (
  mirror: Mirror,
  owners: ReadonlyArray<string | null>,
  stoppable: boolean,
): BackgroundWork => {
  const order = (runId: string) => mirror.runs.get(runId)?.ordinal ?? Number.POSITIVE_INFINITY;
  const turns = [...new Set(owners.filter((owner) => owner !== null))].sort(
    (a, b) => order(a) - order(b),
  );
  return {
    turns: turns.map((turn) => TurnId.make(turn)),
    unattributed: owners.includes(null),
    stoppable,
  };
};

const RELEASED_SESSION: ReadonlySet<ProviderSession["status"]> = new Set(["stopped", "error"]);

/**
 * The provider sessions bound to the thread whose process may still run: a
 * stopped or failed one starts again, with what its project allows then, at
 * the thread's next turn.
 */
export const liveProviderSessions = (mirror: Mirror): ReadonlyArray<string> =>
  [...mirror.providerSessions]
    .filter(([, status]) => !RELEASED_SESSION.has(status))
    .map(([id]) => id);

/**
 * Whether a provider thread other than the one the engine's stop interrupts
 * still runs its tasks: one from before a fresh-context start.
 *
 * A fresh-context start moves the thread to a new provider thread, and
 * releases the old one's provider session only when the provider hosts one
 * provider thread per session and the session has no background work: a
 * queued fresh start leaves a busy session running, as one a schedule sends
 * does, and any other start the engine would begin at once is refused
 * (**Read** at `db51b67`, `Orchestrator.ts`, `sessionsReleasedByFreshContext`,
 * L1520-1533, applied at L2765-2808 and L8325-8345; the testkit's "Fresh
 * context with an old session's background task"). The old provider thread
 * keeps reporting its tasks until they end, or until archiving the thread
 * detaches every session (L4713-4736). So its tasks count while it is one of
 * the thread's own conversations, not a subagent's, and its provider session
 * is one the engine keeps: bound to the thread, as a released one is
 * detached in the same command (L3285-3296, L8701-8712), and neither stopped
 * nor failed, as the engine judges a session it could still release.
 */
const isKeptProviderThread = (mirror: Mirror, thread: ProviderThread) => {
  const session =
    thread.providerSessionId === null
      ? undefined
      : mirror.providerSessions.get(thread.providerSessionId);
  return (
    thread.appThreadId === mirror.thread?.id &&
    thread.ownerNodeId === null &&
    session !== undefined &&
    !RELEASED_SESSION.has(session)
  );
};

/**
 * Where a pending task comes from: the provider thread the engine's stop
 * interrupts, a live item, or a kept provider thread (`isKeptProviderThread`),
 * which the stop does not reach.
 */
type Reach = "target" | "item" | "kept";

/** One pending task, as `backgroundWorkOf` lists it. */
interface PendingEntry {
  readonly runId: string | null;
  readonly reach: Reach;
}

/**
 * The session's background work: what the engine's stop interrupts, and what
 * a provider thread from before a fresh-context start still runs, which it
 * does not reach.
 *
 * The engine's stop, in a session whose latest run has ended, fires when its
 * own rule counts work: with no run active and the latest run settled, a task
 * the active provider thread reports, every provider thread's while it has
 * none, or a live command, dynamic tool or subagent item outside a
 * rolled-back run (**Read** at `db51b67`, `orchestrationV2PendingBackgroundWork.ts`,
 * `derivePendingBackgroundWork`, L261-330, and `pendingBackgroundTurnItems`,
 * L243-258). It then interrupts the latest run's provider thread, and another
 * provider thread only at the provider turn of a live item, an interrupt
 * that lands only after the stop answered (`Orchestrator.ts`,
 * `dispatchThreadStop`, L14141-14178; `dispatchRunInterrupt`, L13560-13692).
 * The work it ends is that thread's tasks and the live items, whichever run
 * started them; the active provider thread decides only whether it fires,
 * and a late report from an old provider thread can make that one active.
 *
 * Work is listed in the order the engine reads it, the latest run's provider
 * thread's tasks, then live items by ordinal (`ProjectionStore.ts`, L3911),
 * then the kept provider threads' tasks, one entry per task id. The engine's
 * rule then keeps one subagent per child thread, as follow-ups can share a
 * child thread and it counts agents (`orchestrationV2PendingBackgroundWork.ts`,
 * L318-326). That never empties a list, so
 * whether the stop fires is read before it, and the session's work keeps
 * every follow-up: it says which turns own pending work, not how many agents
 * run, and a follow-up from another turn is that turn's work too. Each piece
 * is attributed to the run the engine gives it: a task's `runId`, which the
 * projection stamps (`attributeTasks`), or an item's own.
 */
export const backgroundWorkOf = (mirror: Mirror): MirroredWork => {
  const none: MirroredWork = {
    pending: { turns: [], unattributed: false, stoppable: false },
    undecided: [],
  };
  if ([...mirror.runs.values()].some((run) => ACTIVE_RUN.has(run.status))) return none;
  const latest = latestRun(mirror);
  if (latest === undefined || !SETTLED_FOR_BACKGROUND.has(latest.status)) return none;
  const providerThreads = [...mirror.providerThreads.values()];
  const entries: Array<PendingEntry> = [];
  const listed = new Set<string>();
  const listTasks = (threads: ReadonlyArray<ProviderThread>, reach: Reach) => {
    for (const thread of threads) {
      for (const task of thread.pendingBackgroundTasks ?? []) {
        if (task.taskId.length === 0 || listed.has(task.taskId)) continue;
        listed.add(task.taskId);
        entries.push({ runId: task.runId ?? null, reach });
      }
    }
  };
  listTasks(
    providerThreads.filter((thread) => thread.id === latest.providerThreadId),
    "target",
  );
  const rolledBack = new Set(
    [...mirror.runs.values()].flatMap((run) => (run.status === "rolled_back" ? [run.id] : [])),
  );
  const undecided: Array<UndecidedTool> = [];
  const items = [...mirror.items.values()].sort(
    (a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const item of items) {
    const taskId = taskIdOf(item);
    if (
      !BACKGROUND_ITEM.has(item.type) ||
      !isOrchestrationV2WorkActive(item.status) ||
      (item.runId !== null && rolledBack.has(item.runId)) ||
      listed.has(taskId)
    ) {
      continue;
    }
    const work = item.type === "dynamic_tool" ? toolWork(mirror, item) : "pending";
    if (work === "none") continue;
    listed.add(taskId);
    if (work === "undecided") {
      undecided.push({ taskId, turnId: item.runId === null ? null : TurnId.make(item.runId) });
      continue;
    }
    entries.push({ runId: item.runId, reach: "item" });
  }
  listTasks(
    providerThreads.filter(
      (thread) => thread.id !== latest.providerThreadId && isKeptProviderThread(mirror, thread),
    ),
    "kept",
  );
  const active = mirror.thread?.activeProviderThreadId ?? null;
  const fires =
    entries.some((entry) => entry.reach === "item") ||
    providerThreads.some(
      (thread) =>
        (active === null || thread.id === active) &&
        (thread.pendingBackgroundTasks ?? []).some((task) => task.taskId.length > 0),
    );
  return {
    pending: workBy(
      mirror,
      entries.map((entry) => entry.runId),
      fires && entries.some((entry) => entry.reach !== "kept"),
    ),
    undecided,
  };
};

/**
 * The session's background work, with the tools the mirror could not decide
 * settled: `pendingTools` are those of them still pending.
 */
export const reportedWorkOf = (
  mirror: Mirror,
  work: MirroredWork,
  pendingTools: ReadonlyArray<UndecidedTool>,
): BackgroundWork =>
  workBy(
    mirror,
    [
      ...work.pending.turns,
      ...(work.pending.unattributed ? [null] : []),
      ...pendingTools.map((tool) => tool.turnId),
    ],
    work.pending.stoppable || pendingTools.length > 0,
  );

/**
 * Which tools the mirror could not decide (`MirroredWork`) are pending, by
 * the engine's own projection of the thread's pending work: the shell row
 * `getThreadFamily` returns, whose `pendingBackgroundTasks` the engine derives
 * by the same rule over the stored items, inputs whole (**Read** at
 * `db51b67`, `ProjectionStore.ts:9050-9064`, from
 * `selectShellPendingTurnItemRows` at `:8609-8623`;
 * `orchestrationV2PendingBackgroundWork.ts:243-258`). A tool it lists is
 * pending; one it does not list ended, or runs on purpose. The shell lists
 * nothing while its own run gate holds (`derivePendingBackgroundWork`,
 * L270-285): a run active, or a latest run, which it picks by its own rule
 * (`ProjectionStore.ts:8237-8264`), that has not settled. It cannot say then,
 * and neither can a shell that is missing: the tools count as pending, and a
 * Stop waits on them, sending fresh rounds, until a later read can say.
 */
export const workInShell = (
  shell:
    | Pick<OrchestrationV2ThreadShell, "activeRunId" | "status" | "pendingBackgroundTasks">
    | undefined,
  tools: ReadonlyArray<UndecidedTool>,
): ReadonlyArray<UndecidedTool> => {
  if (
    shell === undefined ||
    shell.activeRunId !== null ||
    !SETTLED_FOR_BACKGROUND.has(shell.status)
  ) {
    return tools;
  }
  const listed = new Set((shell.pendingBackgroundTasks ?? []).map((task) => task.taskId));
  return tools.filter((tool) => listed.has(tool.taskId));
};

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

const SEND_TO_USER = /(^|__|\/|\.)send_to_user$/;

/**
 * A call to the engine's own `send_to_user`. Never one on the `j3` server: a
 * connector's tool there may be named `<slug>__send_to_user` by its remote
 * server, and its input is not speech.
 */
const isHostSpeech = (item: Item): item is DynamicTool =>
  item.type === "dynamic_tool" &&
  item.toolName !== null &&
  SEND_TO_USER.test(item.toolName) &&
  j3ToolOf(item) === undefined;

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
    case "dynamic_tool": {
      // Host speech and J3 Bots' own tools are events of their own; a
      // connector's tool, and one that manages MCP servers or skills, is also
      // a step of the bot's work.
      const j3Tool = j3ToolOf(item);
      return isHostSpeech(item) || (j3Tool !== undefined && !isStepTool(j3Tool))
        ? undefined
        : dynamicToolStep(item).kind;
    }
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
      return label(dynamicToolStep(item).label, "Tool");
    default:
      return label(item.title, item.type);
  }
};

/**
 * A tool call in J3 Bots' words. A harness may give only a title, which then
 * carries the tool's name in the same forms.
 */
const dynamicToolStep = (item: DynamicTool) =>
  toolStep({
    name: item.toolName ?? item.title,
    title: item.toolName === null ? null : item.title,
    input: item.input,
    viewsImage: item.viewedImagePath !== undefined,
  });

const stepStatus = (item: Item): WorkStep["status"] =>
  LIVE_ITEM.has(item.status) ? "running" : item.status === "completed" ? "completed" : "failed";

const stepOf = (item: Item): WorkStep | undefined => {
  const kind = stepKind(item);
  if (kind === undefined) return undefined;
  return {
    id: WorkStepId.make(localIdFor(item.id)),
    kind,
    tool: item.type === "dynamic_tool" ? dynamicToolStep(item).tool : null,
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
  `${step.status}|${step.tool ?? ""}|${step.label}|${step.finishedAt === null ? "" : DateTime.formatIso(step.finishedAt)}`;

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
  /** The `j3` tool call it holds back (`OpenRequest.heldCall`). */
  readonly heldCall: ToolCallId | null;
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
      // The engine records the request beside the item, in either order. The request is what
      // takes the answer and tells which part of the item is asked about, so the approval opens
      // once both are here.
      const request = mirror.requests.get(item.requestId);
      if (request === undefined && LIVE_ITEM.has(item.status)) return undefined;
      const held = heldConnectorCall(item, request, mirror.items.values());
      return {
        requestId: RequestId.make(localIdFor(item.requestId)),
        answerTo: { _tag: "runtime-request", requestId: item.requestId },
        turnId,
        openedAt,
        request: approvalOf(item, request, mirror.items.values(), mirror.fetched),
        heldCall: held === undefined ? null : ToolCallId.make(localIdFor(held.itemId)),
        resolution: runtimeResolution(request, item),
      };
    }
    case "user_input_request": {
      const request = questionRequestOf(item);
      if (request === undefined) return undefined;
      return {
        requestId: RequestId.make(localIdFor(item.requestId)),
        answerTo: { _tag: "user-input", requestId: item.requestId, questions: item.questions },
        turnId,
        openedAt,
        request,
        heldCall: null,
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
        heldCall: null,
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

/**
 * The file changes approvals still open hold back without their diff, by item
 * id, each at the version its approval holds.
 */
const heldWithoutDiff = (mirror: Mirror): ReadonlyMap<string, FileChangeItem> => {
  const held = new Map<string, FileChangeItem>();
  for (const item of mirror.items.values()) {
    if (item.type !== "approval_request" || !LIVE_ITEM.has(item.status)) continue;
    const request = mirror.requests.get(item.requestId);
    if (request?.status !== "pending") continue;
    const change = fileChangeWithoutDiff(item, request, mirror.items.values());
    if (change !== undefined) held.set(change.id, change);
  }
  return held;
};

/** Drops each fetched file change no open approval holds at the version fetched. */
function dropUnheld(mirror: Mirror): void {
  if (mirror.fetched.size === 0) return;
  const held = heldWithoutDiff(mirror);
  for (const [id, whole] of mirror.fetched) {
    const change = held.get(id);
    if (change === undefined || !sameVersion(change, whole)) mirror.fetched.delete(id);
  }
}

/**
 * The file changes to fetch whole for approvals still open, each held back by
 * an approval and sent on the stream without its diff, and not yet fetched at
 * the version held.
 */
export const changesToFetch = (mirror: Mirror): ReadonlyArray<FileChangeItem> =>
  [...heldWithoutDiff(mirror).values()].filter((change) => {
    const whole = mirror.fetched.get(change.id);
    return whole === undefined || !sameVersion(change, whole);
  });

/**
 * Keeps a file change fetched whole for an approval's card, when an open
 * approval still holds it at the version fetched. Fetches can land out of
 * order and after their approval closed; one for any other version than the
 * held one, older or newer, is not kept, and the held version is fetched on
 * its own. Returns whether it was kept.
 */
export const keepFetched = (mirror: Mirror, item: FileChangeItem): boolean => {
  const change = heldWithoutDiff(mirror).get(item.id);
  if (change === undefined || !sameVersion(change, item)) return false;
  mirror.fetched.set(item.id, item);
  return true;
};

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
  heldCall: state.heldCall,
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
    return Option.some({
      _tag: wasQueued(mirror, run) ? "queued" : "started",
      turnId: turnIdOf(run),
    });
  }
  return Option.none();
};

// ---------------------------------------------------------------------------
// Diffing a mirror against what the subscriber knows

interface TurnView {
  /** Whether the subscriber was told the engine queued it, before it started. */
  queued: boolean;
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

/**
 * A request as the subscriber knows it: open, with the card it was last told
 * of as JSON, or closed.
 */
type OpenView = { readonly _tag: "open"; readonly shown: string };
type RequestView = OpenView | { readonly _tag: "closed" };

const shownOf = (state: RequestState): OpenView => ({
  _tag: "open",
  shown: JSON.stringify(state.request),
});

/** What the subscriber has been told. Copied, never shared, between cursors. */
export interface View {
  readonly turns: Map<string, TurnView>;
  readonly steps: Map<string, string>;
  readonly speech: Set<string>;
  readonly requests: Map<string, RequestView>;
  /** Each `j3` call told, open with the digest it was last told with, or closed. */
  readonly toolCalls: Map<
    string,
    { readonly _tag: "open"; readonly inputDigest: ToolInputDigest } | { readonly _tag: "closed" }
  >;
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
    const turn = view.turns.get(run.id) ?? {
      queued: false,
      started: false,
      finished: false,
      continuation: false,
    };
    view.turns.set(run.id, turn);
    if (isSteerCarrier(mirror, run)) continue;
    const cause = causeOf(mirror, run);
    if (!turn.finished) {
      const waiting = !turn.started && !hasStarted(run) && !isEnded(run);
      if (waiting && !turn.queued && wasQueued(mirror, run) && isCauseTold(mirror, run)) {
        turn.queued = true;
        events.push({ _tag: "turn-queued", turnId, cause });
      }
      if (!turn.started && hasStarted(run)) {
        turn.started = true;
        events.push({ _tag: "turn-started", turnId, cause, startedAt: startedAtOf(run) });
      }
      const ended = isEnded(run);
      for (const state of requestsOf(mirror, run)) {
        if (state.resolution !== undefined) continue;
        const seen = view.requests.get(state.requestId);
        const shown = shownOf(state);
        if (seen === undefined) {
          view.requests.set(state.requestId, shown);
          events.push({ _tag: "request-opened", open: openRequestOf(state) });
        } else if (seen._tag === "open" && seen.shown !== shown.shown && !ended) {
          // Only a request still waiting on the operator changes its card.
          view.requests.set(state.requestId, shown);
          events.push({
            _tag: "request-updated",
            requestId: state.requestId,
            turnId,
            request: state.request,
            heldCall: state.heldCall,
          });
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
          // A call the engine records again with other input while it is open
          // is told again: an ACP agent can report a call before its
          // arguments, and the call runs, and reaches the bridge, with them.
          if (
            seen === undefined ||
            (seen._tag === "open" &&
              seen.inputDigest !== call.inputDigest &&
              LIVE_ITEM.has(item.status) &&
              !ended)
          ) {
            view.toolCalls.set(call.callId, { _tag: "open", inputDigest: call.inputDigest });
            events.push({ _tag: "tool-call", turnId, call, state: "open" });
          }
          // The turn's end closes its calls without a `closed` for each.
          if (
            view.toolCalls.get(call.callId)?._tag === "open" &&
            !LIVE_ITEM.has(item.status) &&
            !ended
          ) {
            view.toolCalls.set(call.callId, { _tag: "closed" });
            events.push({ _tag: "tool-call", turnId, call, state: "closed" });
          }
        }
      }
      for (const state of requestsOf(mirror, run)) {
        const resolution = state.resolution ?? (ended ? ("expired" as const) : undefined);
        if (resolution !== undefined && view.requests.get(state.requestId)?._tag === "open") {
          view.requests.set(state.requestId, { _tag: "closed" });
          events.push({ _tag: "request-closed", requestId: state.requestId, turnId, resolution });
        }
      }
      if (ended) {
        turn.finished = true;
        for (const item of itemsOf(mirror, run)) {
          const call = toolCallOf(mirror, item);
          if (call !== undefined) view.toolCalls.set(call.callId, { _tag: "closed" });
        }
        const continuation = continuationOf(mirror, run, now);
        turn.continuation = continuation !== null;
        events.push({
          _tag: "turn-finished",
          turnId,
          finishedAt: finishedAtOf(run),
          cause,
          outcome: outcomeOf(mirror, run),
          backgroundWork: hasBackgroundWork(mirror, run),
          continuation,
          contextRecovered: hasRecoveredContext(mirror, run),
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
  /** Whether each turn handed off, as a stream told it at the turn's end (`Batches`). */
  toldHandoffs: ReadonlyMap<string, boolean> = new Map(),
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
    const cause = causeOf(mirror, run);
    if (!ended) {
      openTurns.push({
        turnId,
        cause,
        startedAt: hasStarted(run) ? startedAtOf(run) : null,
        steps: stepsOf(mirror, run),
        toolCalls: itemsOf(mirror, run).flatMap((item) => {
          const call = toolCallOf(mirror, item);
          return call !== undefined && LIVE_ITEM.has(item.status) ? [call] : [];
        }),
        closedToolCalls: itemsOf(mirror, run).flatMap((item) => {
          const call = toolCallOf(mirror, item);
          return call !== undefined && !LIVE_ITEM.has(item.status) ? [call] : [];
        }),
      });
    } else {
      endedTurns.push({
        turnId,
        cause,
        startedAt: hasStarted(run) ? startedAtOf(run) : null,
        finishedAt: finishedAtOf(run),
        outcome: outcomeOf(mirror, run),
        // As told at its end: the work may have woken the session and left
        // the roster since. Recomputed only for an end no stream told.
        backgroundWork: toldHandoffs.get(turnId) ?? hasBackgroundWork(mirror, run),
        continuation: continuationOf(mirror, run, now),
        steps: stepsOf(mirror, run),
        contextRecovered: hasRecoveredContext(mirror, run),
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

/**
 * The turn the engine is preparing, starting or running in the session, if
 * any; not one that waits in its queue.
 */
export const startedTurn = (mirror: Mirror): Option.Option<TurnId> =>
  Option.map(
    Option.fromNullishOr(runsInOrder(mirror).find((run) => ACTIVE_RUN.has(run.status))),
    turnIdOf,
  );

/** Runs waiting in the engine's queue, steers kept aside included. */
export const queuedRuns = (mirror: Mirror) =>
  runsInOrder(mirror).filter((run) => run.status === "queued" || run.status === "preparing");

/**
 * The session's runs the engine can still run: those waiting in its queue,
 * steers kept aside included, and those preparing, starting or running. These
 * are the runs a Stop ends: the engine's stop interrupts the latest one
 * preparing, starting or running and holds the queue (**Read** at `db51b67`,
 * `Orchestrator.ts`, `dispatchThreadStop`, L14165-14169, and
 * `holdStoppedThread`, L13115-13161), and the adapter cancels each waiting
 * one. A run the engine starts, or queues, on its own (a provider
 * notification, a background task's completion, a scheduled task) is among
 * them as soon as the engine created it, before any event tells of it as a
 * turn, and also when no event will.
 */
export const runnableTurns = (mirror: Mirror): ReadonlyArray<TurnId> =>
  runsInOrder(mirror)
    .filter((run) => run.status === "queued" || ACTIVE_RUN.has(run.status))
    .map(turnIdOf);

/**
 * No background work the engine's stop counts, nor any it may count, that
 * the adapter could not judge yet.
 */
const isNothingToStop = (work: MirroredWork) =>
  !work.pending.stoppable && work.undecided.length === 0;

/**
 * Whether nothing a Stop targets can still run in the session: no run that
 * has not ended, other than those waiting in the queue, which a Stop cancels
 * one by one; no background work the engine counts as pending, and none
 * it may count, a tool whose persistence no read of the item could decide;
 * no continuation the engine will start on its own. A refusal of a Stop's
 * command is moot only then.
 */
export const nothingToStop = (mirror: Mirror, now: DateTime.Utc): boolean => {
  const waiting = new Set(queuedRuns(mirror).map((run) => run.id));
  return (
    !runsInOrder(mirror).some(
      (run) =>
        (!isEnded(run) && !waiting.has(run.id)) ||
        (isEnded(run) && continuationOf(mirror, run, now) !== null),
    ) && isNothingToStop(backgroundWorkOf(mirror))
  );
};

/**
 * Whether the engine holds the session's queue: its waiting runs do not start
 * on their own. The engine marks each waiting run, not the thread (**Read** at
 * `db51b67`, `OrchestrationV2Run.queueHeld`).
 */
const isQueueHeld = (mirror: Mirror) => queuedRuns(mirror).some((run) => run.queueHeld === true);
