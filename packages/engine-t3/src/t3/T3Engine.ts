// SPDX-License-Identifier: AGPL-3.0-or-later
import { EngineStatus, type ModelChoice, type PermissionMode } from "@j3-bots/contracts";
import {
  AttachmentCreateUploadUrlInput,
  CommandId,
  MessageId,
  type OrchestrationV2DispatchCommandError,
  type ProjectMutationError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ProjectId,
  ProjectSnapshot,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadStreamItem,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { isInlineImage, normalizeAttachmentMetadata } from "../attachments.ts";
import {
  Engine,
  type DispatchInput,
  type EngineOptions,
  type ConnectionOutcome,
  type ProviderConnection,
  type ProviderInstance,
  type RequestResponse,
  type SecretAnswer,
} from "../Engine.ts";
import {
  BackgroundWorkRunning,
  DispatchRejected,
  EngineIncompatible,
  EngineIndeterminate,
  EngineUnavailable,
  ModelUnavailable,
  ProjectNotFound,
  RequestClosed,
  SessionBusy,
  SessionNotFound,
  StopRejected,
} from "../errors.ts";
import type { BackgroundWork, SessionEvent } from "../events.ts";
import {
  EngineAttachmentId,
  EngineProjectId,
  EventCursor,
  IdempotencyKey,
  type RequestId,
  SessionId,
  type SyncToken,
} from "../ids.ts";
import { boundedCommand } from "./Command.ts";
import { makeEngineRpc } from "./Connection.ts";
import {
  checkAccess,
  ensureCredential,
  issueCredential,
  renewalDue,
  type Credential,
} from "./Credential.ts";
import { EngineInstallFailed, ensureInstalled } from "./Install.ts";
import { commandIdFor, messageIdFor, projectIdFor, threadIdFor } from "./Keys.ts";
import { isMissingThread } from "./missingThread.ts";
import { ORCHESTRATION_PROTOCOL, pin } from "./Pin.ts";
import type { FileChangeItem } from "./approvalDetail.ts";
import { cursorFor, makeBatches, type BatchPlace } from "./Batches.ts";
import { makePrivateFiles } from "./PrivateFiles.ts";
import { providerStatuses, providersOfEvent } from "./Providers.ts";
import {
  activeConnection,
  instanceIdFor,
  provision,
  storeConnection,
  writeBasePrompt,
  type InstanceSpec,
} from "./Provision.ts";
import {
  baseUrl,
  stateChanges,
  supervise,
  type ProcessState,
  type Supervision,
} from "./Supervisor.ts";
import { upload } from "./upload.ts";
import {
  activeTurn,
  applyEvent,
  backgroundWorkOf,
  changesToFetch,
  copyMirror,
  copyView,
  diff,
  digestToolCalls,
  dispositionOf,
  emptyMirror,
  engineAnswersOf,
  findRequest,
  isDeleted,
  isEnded,
  isEndedTool,
  isRetired,
  keepFetched,
  knowsDispatch,
  mirrorOf,
  nothingToStop,
  queuedRuns,
  replacement,
  runnableTurns,
  startedTurn,
  toolsToResolve,
  workInShell,
  type EventBody,
  type Mirror,
  type View,
} from "./Translate.ts";
import {
  type ItemRead,
  makeToolReads,
  persistenceOfRead,
  type ToolPersistence,
} from "./toolPersistence.ts";

// The `Engine` service over a real T3 Code server. See `Engine.ts` for the
// contract; this file only says how each method meets it.

/** A command that has had no reply for this long counts as lost. */
const COMMAND_TIMEOUT = Duration.seconds(30);
/** How long `synchronize` waits for the engine's marker on each stream. */
const SYNC_TIMEOUT = Duration.seconds(30);
/** How long fetching an approval's file change may take; past it the card stays a summary. */
const FETCH_TIMEOUT = Duration.seconds(10);
/**
 * How long a `synchronized` waits on the engine's shell for undecidable tools
 * before it reports them pending. Well inside the server's ten-second deadline
 * for a whole `synchronize`, which also covers the wait for the marker, so the
 * `pending` it falls back to still reaches the server and is applied in time.
 */
const SHELL_READ_TIMEOUT = Duration.seconds(3);
/** Batches kept per session, for resuming an `events` stream by replay. */
const BATCHES_KEPT = 32;
/** How long a staged file stays usable: half the engine's 24-hour sweep. */
const STAGED_LIFETIME = Duration.hours(12);
/** How long a provider report subscription that ended waits before it opens again. */
const PROVIDER_RESUBSCRIBE = Duration.seconds(5);
/**
 * How long `connectProviders` waits for the engine to be back after its
 * restart. Most of it is the harnesses' own start-up; one taking longer still
 * gets the connection when it is up.
 */
const CONNECT_RESTART_WAIT = Duration.seconds(60);

/** Statuses that tell a client nothing new: two engine reports that differ only in what J3 Bots does not show. */
const sameStatus = Schema.toEquivalence(EngineStatus);

/** Retrying a failed install: from a minute, doubling up to half an hour. */
const INSTALL_RETRY = Schedule.min([
  Schedule.exponential(Duration.minutes(1)),
  Schedule.spaced(Duration.minutes(30)),
]);

const RUNTIME_MODES = {
  supervised: "approval-required",
  "auto-accept-edits": "auto-accept-edits",
  auto: "auto",
  "full-access": "full-access",
} as const satisfies Record<PermissionMode, string>;

const APPROVAL_DECISIONS = {
  "allow-once": "accept",
  "allow-session": "acceptForSession",
  deny: "decline",
} as const;

const decodeProjects = HttpClientResponse.schemaBodyJson(ProjectSnapshot);

const isEngineDown = Schema.is(Schema.Union([EngineUnavailable, EngineIncompatible]));

/**
 * The engine errors whose reply proves a dispatch was refused, applying
 * nothing: a rejected receipt found by a resend, and the two mode limits,
 * which the engine checks after the receipt lookup and records no receipt for.
 * The dispatch mode limit binds only the engine's agent and MCP callers, never
 * `/ws`; it is listed for the day it does. **Read** at `db51b67`,
 * `Orchestrator.ts`, `dispatchWithReceiptEffect`.
 */
const REJECTIONS: ReadonlySet<string> = new Set([
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorThreadAboveModeLimitError",
  "OrchestratorRuntimeModeAboveCeilingError",
]);
/**
 * Refused before the engine looks at the key: a staged file it cannot claim.
 * The server names only files staged and still usable, so this is its bug.
 * **Read** at `db51b67`, `ThreadMessageIntake.dispatchCommand`.
 */
const CLAIM_ERROR = "AttachmentClaimError";
/**
 * The text of the engine's refusal to change a session's model or permission
 * mode while the provider session the change replaces runs background work.
 * The reply carries it as its message, since no class name tells this refusal
 * from others. **Read** at `db51b67`: `Orchestrator.ts` L4744-4757 and
 * `ClaudeAdapterV2.ts` L831 word it, `ws.ts` (`userFacingDispatchErrorMessage`)
 * makes it the reply's message.
 */
const BACKGROUND_REFUSAL = "still running background agents or commands";
/**
 * A reply's cause keeps the engine error's class name and message, and nothing
 * else of it (**Read** at `db51b67`: `ws.ts`, the cause is a `Schema.Defect`).
 */
const decodeErrorName = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));
const decodeUploadInput = Schema.decodeUnknownEffect(AttachmentCreateUploadUrlInput);

const PairingResult = Schema.Struct({ pairUrl: Schema.String });
const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingResult));

const instanceSpecOf = (provider: ProviderInstance): InstanceSpec => {
  const common = {
    instanceId: instanceIdFor(provider.id),
    name: provider.name,
    environment: provider.environment,
  };
  switch (provider.harness) {
    case "claude-code":
      return { ...common, kind: "claude-code", home: provider.home };
    case "codex":
      return { ...common, kind: "codex", home: provider.home };
    case "acp-command":
      return { ...common, kind: "acp-local", command: provider.command, args: provider.args };
  }
};

/** Input to one session's event loop: an engine stream item, a lost stream, or a synchronize call. */
type LoopInput =
  | { readonly _tag: "item"; readonly item: OrchestrationV2ThreadStreamItem }
  /** A file change an open approval holds, fetched whole. */
  | { readonly _tag: "fetched"; readonly item: FileChangeItem }
  /**
   * The persistence of a dynamic tool whose input the stream summarized, from
   * its item fetched again, by the read `ask` names.
   */
  | {
      readonly _tag: "tool";
      readonly itemId: string;
      readonly ask: number;
      readonly persistence: ToolPersistence;
    }
  /** The stream ended or a read failed: it is opened again once the engine is ready. */
  | { readonly _tag: "lost" }
  /** The engine has no record of the session's thread. */
  | { readonly _tag: "missing" }
  | {
      readonly _tag: "sync";
      readonly token: SyncToken;
      /** Settled once the marker went out, or the catch-up failed. */
      readonly done: Deferred.Deferred<void, EngineUnavailable | SessionNotFound>;
      /**
       * Completed when the caller gave up on it: a catch-up still queued is
       * skipped, and one running is cancelled, so abandoned ones never pile
       * up in the session's loop.
       */
      readonly abandoned: Deferred.Deferred<void>;
    };

/** One open `events` stream, as `synchronize` reaches it. */
interface SyncTarget {
  readonly inputs: Queue.Queue<LoopInput>;
  /** Completed when the stream closes: no marker is owed to it any more. */
  readonly closed: Deferred.Deferred<void>;
}

const make = Effect.fn("engine.make")(function* (options: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;

  const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
  /** The engine executable, once installed. */
  const installed = yield* Deferred.make<string>();
  /** The credential, once minted; read on every dial and request. */
  const credential = yield* Ref.make(Option.none<Credential>());
  const minted = yield* Deferred.make<void>();
  const currentToken = Deferred.await(minted).pipe(
    Effect.andThen(Ref.get(credential)),
    Effect.flatMap((current) =>
      Option.match(current, {
        onNone: () => Effect.die(new Error("The engine credential vanished")),
        onSome: (value) => Effect.succeed(value.token),
      }),
    ),
  );
  const storeCredential = (fresh: Credential) =>
    Ref.set(credential, Option.some(fresh)).pipe(
      Effect.andThen(Deferred.succeed(minted, undefined)),
    );

  const files = yield* makePrivateFiles(options.isPrivate).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  const providerIds = new Set(options.providers.map((provider) => provider.id));
  const instances = options.providers.map(instanceSpecOf);
  /** The base prompt as last rendered, which each provisioning writes for Codex. */
  const basePrompt = yield* Ref.make(
    Option.getOrElse(yield* Stream.runHead(options.basePrompt), () => ""),
  );
  /** One writer of the engine's settings, the connection and the harness homes at a time. */
  const provisioning = yield* Semaphore.make(1);
  /** Run before each start of the engine, while it is stopped (`Supervisor.beforeStart`). */
  const provisionEngine = Effect.gen(function* () {
    yield* provision({
      home: options.home,
      files,
      instances,
      toolBridge: options.toolBridge,
      systemPromptFile: options.systemPromptFile,
      basePrompt: yield* Ref.get(basePrompt),
    });
  }).pipe(
    provisioning.withPermits(1),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  // A new base prompt reaches Codex through its instances' configuration,
  // which Codex reads for each thread it starts or resumes. Only that key is
  // written.
  yield* options.basePrompt.pipe(
    Stream.runForEach((text) =>
      Effect.gen(function* () {
        if (text === (yield* Ref.get(basePrompt))) return;
        yield* Ref.set(basePrompt, text);
        yield* writeBasePrompt({ files, instances, basePrompt: text }).pipe(
          provisioning.withPermits(1),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catch((error) =>
            Effect.logWarning("The new base prompt was not written for Codex", error),
          ),
        );
      }),
    ),
    Effect.forkScoped,
  );

  const connectedNow = activeConnection(options.home).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  /** The supervision loop, once the engine is installed and supervised. */
  const supervision = yield* Ref.make(Option.none<Supervision>());
  /**
   * One connection change at a time, through the restart that applies it, so
   * an engine that came back answers only for the connection it started with.
   */
  const connecting = yield* Semaphore.make(1);

  /**
   * Stores the connection, then restarts the engine, whose next start
   * provisions it (`provision`). Answers once the engine is back, or after
   * `CONNECT_RESTART_WAIT` without it, or at once when nothing will start
   * the engine again: it then gets the connection whenever it next starts.
   */
  const connectProviders = Effect.fn("Engine.connectProviders")(function* (
    connection: ProviderConnection,
  ) {
    const committed = yield* storeConnection({ home: options.home, files, connection }).pipe(
      provisioning.withPermits(1),
      Effect.provideService(Path.Path, path),
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("The provider connection was not stored", error).pipe(Effect.as(false)),
      ),
    );
    if (!committed) {
      return { _tag: "refused", active: yield* connectedNow } satisfies ConnectionOutcome;
    }
    const stored = { _tag: "stored", baseUrl: connection.baseUrl } satisfies ConnectionOutcome;
    const running = yield* Ref.get(supervision);
    // Still installing: the engine's first start provisions it.
    if (Option.isNone(running)) return stored;
    yield* Effect.logInfo("Restarting the engine for a new provider connection");
    if (!(yield* running.value.restart)) return stored;
    const back = yield* stateChanges(state).pipe(
      Stream.filter((current) => current._tag === "ready"),
      Stream.runHead,
      Effect.timeoutOption(CONNECT_RESTART_WAIT),
      Effect.map(Option.flatten),
    );
    return Option.isSome(back)
      ? ({ _tag: "applied", baseUrl: connection.baseUrl } satisfies ConnectionOutcome)
      : stored;
  }, connecting.withPermits(1));

  const platformServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HttpClient.HttpClient, http),
    );

  /**
   * Installs the pinned engine, unless overridden. A failed install is a
   * state, never a crash: the engine is `unavailable` with the reason while
   * the install is retried.
   */
  const install = Option.isSome(options.binaryOverride)
    ? Effect.succeed(options.binaryOverride.value)
    : files.folder(options.home).pipe(
        Effect.mapError(() => new EngineInstallFailed({ reason: "storage", version: pin.version })),
        Effect.andThen(
          ensureInstalled({
            home: options.home,
            platform: process.platform,
            arch: process.arch,
            files,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Installing the engine failed", error).pipe(
            Effect.andThen(
              SubscriptionRef.set(state, { _tag: "unavailable", reason: "install-failed" }),
            ),
          ),
        ),
        Effect.retry(INSTALL_RETRY),
        platformServices,
      );

  // Everything that needs the executable starts once it is installed.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const executable = yield* install;
      yield* Deferred.succeed(installed, executable);
      const ensure = platformServices(ensureCredential({ executable, home: options.home, files }));
      const reissue = platformServices(
        issueCredential({ executable, home: options.home, files }),
      ).pipe(
        Effect.flatMap(storeCredential),
        Effect.catch((error) => Effect.logWarning("Minting a fresh engine token failed", error)),
      );
      // Renew ahead of expiry, for as long as the engine lives.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Deferred.await(minted);
            const current = yield* Ref.get(credential);
            const due = Option.match(current, {
              onNone: () => DateTime.makeUnsafe(0),
              onSome: renewalDue,
            });
            const now = yield* DateTime.now;
            yield* Effect.sleep(
              Duration.millis(
                Math.max(60_000, DateTime.toEpochMillis(due) - DateTime.toEpochMillis(now)),
              ),
            );
            yield* reissue;
          }),
        ),
      );
      const supervised = yield* supervise({
        executable,
        home: options.home,
        port: options.port,
        state,
        beforeStart: provisionEngine.pipe(Effect.andThen(ensure), Effect.flatMap(storeCredential)),
        checkAccess: currentToken.pipe(
          Effect.flatMap((token) => checkAccess({ baseUrl: baseUrl(options.port), token })),
          platformServices,
        ),
        reissueCredential: reissue,
        files,
      }).pipe(platformServices);
      yield* Ref.set(supervision, Option.some(supervised));
    }),
  );

  const rpc = yield* makeEngineRpc({ port: options.port, token: currentToken });

  /** What every session's streams emitted, for resuming one by replay or by replacement. */
  const batches = makeBatches(BATCHES_KEPT);
  const toolReads = makeToolReads();

  // ---------------------------------------------------------------------------
  // Sending

  /** Fails without sending when the engine cannot take commands. */
  const ready = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (current._tag === "incompatible") {
      return yield* new EngineIncompatible({
        runningVersion: current.runningVersion,
        pinnedVersion: pin.version,
      });
    }
    if (current._tag !== "ready") return yield* new EngineUnavailable();
  });

  /**
   * After a command has gone out, nothing that follows proves it was not
   * applied: an engine that becomes unreachable or incompatible, or refuses
   * the credential, before the next step says nothing about the step already
   * sent. Such a failure is indeterminate.
   */
  const afterSending = <A, E, R>(
    effect: Effect.Effect<A, E | EngineUnavailable | EngineIncompatible, R>,
  ): Effect.Effect<
    A,
    Exclude<E, EngineUnavailable | EngineIncompatible> | EngineIndeterminate,
    R
  > =>
    effect.pipe(
      Effect.catchIf<
        E | EngineUnavailable | EngineIncompatible,
        EngineUnavailable | EngineIncompatible,
        never,
        EngineIndeterminate,
        never
      >(isEngineDown, () => Effect.fail(new EngineIndeterminate())),
    );

  /** A command that changes state: a lost reply is indeterminate. */
  const command = (input: OrchestrationV2Command) =>
    ready.pipe(
      Effect.andThen(
        rpc["orchestration.dispatchCommand"](input).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT,
            orElse: () => Effect.fail(new EngineIndeterminate()),
          }),
          Effect.catchTag("RpcClientError", () => Effect.fail(new EngineIndeterminate())),
        ),
      ),
    );

  /** The session's current state. Reads change nothing, so a lost reply is only unavailability. */
  const projection = (sessionId: SessionId) =>
    ready.pipe(
      Effect.andThen(
        rpc["orchestration.getThreadProjection"]({ threadId: ThreadId.make(sessionId) }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT,
            orElse: () => Effect.fail(new EngineUnavailable()),
          }),
          Effect.catchTags({
            RpcClientError: () => Effect.fail(new EngineUnavailable()),
            EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
            // Only a thread the engine has no record of is lost; a read that failed may succeed again.
            OrchestrationV2GetThreadProjectionError: (error) =>
              Effect.fail(
                isMissingThread(error)
                  ? new SessionNotFound({ sessionId })
                  : new EngineUnavailable(),
              ),
          }),
        ),
      ),
      Effect.map((projection) => mirrorOf(projection)),
      // A thread the engine deleted keeps its projection: the session is gone all the same.
      Effect.filterOrFail(
        (mirror) => !isDeleted(mirror),
        () => new SessionNotFound({ sessionId }),
      ),
    );

  /**
   * The persistence of a dynamic tool whose input the stream summarized, from
   * the item, which the engine cuts at 256 KiB (`persistenceOfRead`). Through
   * `toolReads`, shared by every reader of the session: none while a read
   * runs, or while a failed read's backoff runs, and undecidable once too many
   * failed in a row.
   */
  const toolPersistence = (sessionId: SessionId, itemId: string) =>
    toolReads.resolve(
      sessionId,
      itemId,
      rpc["orchestration.getTurnItem"]({
        threadId: ThreadId.make(sessionId),
        itemId: TurnItemId.make(itemId),
      }).pipe(
        Effect.timeout(FETCH_TIMEOUT),
        Effect.map(({ item }): ItemRead =>
          item?.type === "dynamic_tool"
            ? { _tag: "tool", input: item.input }
            : { _tag: "not-a-tool" },
        ),
        Effect.map(persistenceOfRead),
      ),
    );

  /**
   * The session's background work for a `synchronized` event: the mirror's,
   * and for tools no read of the item could decide, the engine's own
   * projection of the thread's pending work (`workInShell`), read with
   * `getThreadFamily`, bounded at `SHELL_READ_TIMEOUT`. A read that fails or
   * runs out cannot say, so they count as pending: a Stop waits and
   * synchronizes again.
   */
  const reportedWork = (sessionId: SessionId, mirror: Mirror) => {
    const work = backgroundWorkOf(mirror);
    if (work._tag !== "undecided") return Effect.succeed<BackgroundWork>(work._tag);
    const threadId = ThreadId.make(sessionId);
    return rpc["orchestration.getThreadFamily"]({ threadId }).pipe(
      Effect.timeout(SHELL_READ_TIMEOUT),
      Effect.map(({ threads }) =>
        workInShell(
          threads.find((thread) => thread.id === threadId),
          work.taskIds,
        ),
      ),
      Effect.orElseSucceed((): BackgroundWork => "pending"),
    );
  };

  /**
   * Settles in `mirror` the persistence of each tool whose input the stream
   * summarized, as far as it can be read now. Only a stream prunes what was
   * learned (`toolReads.prune`): it has every event in order, where this
   * mirror is a read of its own.
   */
  const resolveTools = (sessionId: SessionId, mirror: Mirror) =>
    Effect.forEach(
      toolsToResolve(mirror),
      (itemId) =>
        Effect.map(
          toolPersistence(sessionId, itemId),
          Option.map((persistence) => {
            mirror.toolPersistence.set(itemId, persistence);
          }),
        ),
      { discard: true },
    );

  /** The state of a session that is still in use: a retired one is `SessionNotFound`. */
  const liveProjection = (sessionId: SessionId) =>
    projection(sessionId).pipe(
      Effect.filterOrFail(
        (mirror) => !isRetired(mirror),
        () => new SessionNotFound({ sessionId }),
      ),
    );

  /** The class name an error reply keeps of the engine's error, if it kept one. */
  const causeName = (error: OrchestrationV2DispatchCommandError) =>
    Option.map(decodeErrorName(error.cause), ({ name }) => name);

  /**
   * Sends a keyed command, and once more on an error reply that proves
   * nothing, so every answer comes from the key's receipt: the engine can
   * answer with an error after it applied a command, and answers its first
   * submission of a command it refused while planning with the same kind of
   * error as any other. A resend answers `{sequence}` if the key was applied,
   * and `OrchestratorCommandPreviouslyRejectedError` if it was refused.
   * **Read** at `db51b67`, `dispatchWithReceiptEffect`, `replayCommandReceipt`.
   * A reply lost on the way is `EngineIndeterminate`, resolved by sending the
   * same key again.
   */
  const sendByReceipt = Effect.fnUntraced(function* (input: OrchestrationV2Command) {
    const send = command(input).pipe(
      Effect.as(Option.none<string>()),
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        OrchestrationV2DispatchCommandError: (error) =>
          Effect.succeedSome(Option.getOrElse(causeName(error), () => "")),
      }),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      // Once the first send went out, no failure but a named refusal proves
      // that nothing was applied: the engine may have taken the first one.
      const refusal = yield* attempt === 0 ? send : afterSending(send);
      if (Option.isNone(refusal)) return "applied" as const;
      if (REJECTIONS.has(refusal.value)) return "rejected" as const;
      if (refusal.value === CLAIM_ERROR) {
        return yield* Effect.die(
          new Error(`A staged file the engine cannot claim: ${input.commandId}`),
        );
      }
    }
    // Twice an error that proves nothing either way.
    return yield* new EngineIndeterminate();
  });

  /** An engine refusal the interface has no error for: a bug or a broken setup, not a state. */
  const refused = (error: { readonly message: string }) =>
    Effect.die(new Error(`The engine refused a command: ${error.message}`));

  const modelSelection = (model: ModelChoice) =>
    providerIds.has(model.providerId)
      ? Effect.succeed({
          instanceId: ProviderInstanceId.make(instanceIdFor(model.providerId)),
          model: model.modelId,
        })
      : Effect.fail(new ModelUnavailable({ providerId: model.providerId, modelId: model.modelId }));

  const commandId = (purpose: string, key: string) => CommandId.make(commandIdFor(purpose, key));
  // Commands that are idempotent by nature still need distinct ids, or the engine
  // would answer a later one with an earlier one's result.
  let issued = 0;
  const uniqueKey = Effect.map(Clock.currentTimeMillis, (now) => `${now}-${issued++}`);

  // ---------------------------------------------------------------------------
  // Projects and sessions

  const ensureProject = Effect.fn("Engine.ensureProject")(function* (input: {
    readonly workspacePath: string;
    readonly title: string;
  }) {
    yield* ready;
    // The engine allows one live project per folder, whoever made it.
    const token = yield* currentToken;
    const snapshot = yield* http
      .execute(
        HttpClientRequest.get(`${baseUrl(options.port)}/api/projects`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeader(
            ORCHESTRATION_PROTOCOL_HEADER,
            String(ORCHESTRATION_PROTOCOL),
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeProjects),
        Effect.timeout(COMMAND_TIMEOUT),
        Effect.mapError(() => new EngineUnavailable()),
      );
    const owner = snapshot.projects.find(
      (project) =>
        project.deletedAt === null &&
        path.resolve(project.workspaceRoot) === path.resolve(input.workspacePath),
    );
    if (owner !== undefined) return EngineProjectId.make(owner.id);
    const projectId = projectIdFor(input.workspacePath);
    const created = yield* rpc["projects.mutate"]({
      type: "project.create",
      commandId: commandId("project", projectId),
      projectId: ProjectId.make(projectId),
      title: input.title,
      workspaceRoot: input.workspacePath,
      createWorkspaceRootIfMissing: true,
    }).pipe(
      Effect.timeoutOrElse({
        duration: COMMAND_TIMEOUT,
        orElse: () => Effect.fail(new EngineIndeterminate()),
      }),
      Effect.as(Option.none<ProjectMutationError>()),
      Effect.catchTags({
        RpcClientError: () => Effect.fail(new EngineIndeterminate()),
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        ProjectMutationError: (error) => Effect.succeedSome(error),
      }),
    );
    if (Option.isSome(created)) return yield* refused(created.value);
    return EngineProjectId.make(projectId);
  });

  const removeProject = Effect.fn("Engine.removeProject")(function* (projectId: EngineProjectId) {
    yield* ready;
    yield* rpc["projects.mutate"]({
      type: "project.delete",
      commandId: commandId("project-delete", `${projectId}:${yield* uniqueKey}`),
      projectId: ProjectId.make(projectId),
      force: true,
    }).pipe(
      Effect.timeoutOrElse({
        duration: COMMAND_TIMEOUT,
        orElse: () => Effect.fail(new EngineIndeterminate()),
      }),
      Effect.catchTags({
        RpcClientError: () => Effect.fail(new EngineIndeterminate()),
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        // Already gone.
        ProjectMutationError: () => Effect.void,
      }),
    );
  });

  const openSession = Effect.fn("Engine.openSession")(function* (input: {
    readonly key: IdempotencyKey;
    readonly projectId: EngineProjectId;
    readonly title: string;
    readonly model: ModelChoice;
    readonly permissionMode: PermissionMode;
  }) {
    const sessionId = SessionId.make(threadIdFor(input.key));
    const selection = yield* modelSelection(input.model);
    const result = yield* command({
      type: "thread.create",
      commandId: commandId("session", input.key),
      threadId: ThreadId.make(sessionId),
      projectId: ProjectId.make(input.projectId),
      title: input.title,
      modelSelection: selection,
      runtimeMode: RUNTIME_MODES[input.permissionMode],
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    }).pipe(
      Effect.as(Option.none<OrchestrationV2DispatchCommandError>()),
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        OrchestrationV2DispatchCommandError: (error) => Effect.succeedSome(error),
      }),
    );
    if (Option.isSome(result)) {
      const message = result.value.message;
      if (/project/i.test(message) && /not|missing|unknown/i.test(message)) {
        return yield* new ProjectNotFound({ projectId: input.projectId });
      }
      return yield* refused(result.value);
    }
    return sessionId;
  });

  const sendSessionCommand = (sessionId: SessionId, input: OrchestrationV2Command) =>
    command(input).pipe(
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        // A refusal for a missing thread is `SessionNotFound`; anything else is a bug.
        OrchestrationV2DispatchCommandError: (error) =>
          afterSending(projection(sessionId)).pipe(Effect.andThen(refused(error))),
      }),
      Effect.asVoid,
    );

  /**
   * Sends a change of a session's settings. The engine's refusal to end
   * background work the change would end is `BackgroundWorkRunning`; any other
   * refusal is handled as `sendSessionCommand` handles it.
   */
  const sendSettingsCommand = (sessionId: SessionId, input: OrchestrationV2Command) =>
    command(input).pipe(
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        OrchestrationV2DispatchCommandError: (error) =>
          afterSending(projection(sessionId)).pipe(
            Effect.andThen(
              error.message.includes(BACKGROUND_REFUSAL)
                ? Effect.fail(new BackgroundWorkRunning({ sessionId }))
                : refused(error),
            ),
          ),
      }),
      Effect.asVoid,
    );

  const configureSession = Effect.fn("Engine.configureSession")(function* (input: {
    readonly sessionId: SessionId;
    readonly model?: ModelChoice;
    readonly permissionMode?: PermissionMode;
  }) {
    // Only what differs from what the thread runs is sent: a session opened
    // again under its key is the one the engine opened first, as it was
    // opened then, and is set to the caller's settings this way.
    const mirror = yield* liveProjection(input.sessionId);
    const thread = mirror.thread;
    const threadId = ThreadId.make(input.sessionId);
    const wanted = input.model === undefined ? undefined : yield* modelSelection(input.model);
    const selection =
      wanted !== undefined &&
      (thread === undefined ||
        thread.modelSelection.instanceId !== wanted.instanceId ||
        thread.modelSelection.model !== wanted.model)
        ? wanted
        : undefined;
    const mode =
      input.permissionMode !== undefined &&
      (thread === undefined || thread.runtimeMode !== RUNTIME_MODES[input.permissionMode])
        ? input.permissionMode
        : undefined;
    if (selection === undefined && mode === undefined) return;
    // A change may replace the provider session, which ends a turn running in
    // it: none is sent while one runs.
    const running = startedTurn(mirror);
    if (Option.isSome(running)) {
      return yield* new SessionBusy({ sessionId: input.sessionId, turnId: running.value });
    }
    if (selection !== undefined) {
      yield* sendSettingsCommand(input.sessionId, {
        type: "thread.model-selection.set",
        commandId: commandId("model", `${input.sessionId}:${yield* uniqueKey}`),
        threadId,
        modelSelection: selection,
      });
    }
    if (mode !== undefined) {
      const send = sendSettingsCommand(input.sessionId, {
        type: "thread.runtime-mode.set",
        commandId: commandId("mode", `${input.sessionId}:${yield* uniqueKey}`),
        threadId,
        runtimeMode: RUNTIME_MODES[mode],
      });
      yield* selection === undefined ? send : afterSending(send);
    }
  });

  // ---------------------------------------------------------------------------
  // Stop

  /**
   * Sends one command of a round of a Stop, resolved by its receipt as a
   * dispatch is (`sendByReceipt`). A refusal of a step that has become moot
   * (the run it cancels already ended, nothing the engine's stop targets can
   * still run, nor may) counts as done; any other is `StopRejected`, keyed by
   * the round, whose key it spends. A refused stop interrupted nothing, so a
   * live tool whose persistence no read of the item could decide keeps it
   * from being moot (`nothingToStop`), and the server sends a fresh round.
   */
  const sendStopStep = Effect.fnUntraced(function* (
    round: { readonly key: IdempotencyKey; readonly sessionId: SessionId },
    input: OrchestrationV2Command,
    isMoot: (mirror: Mirror, now: DateTime.Utc) => boolean,
  ) {
    if ((yield* sendByReceipt(input)) === "applied") return;
    const mirror = yield* afterSending(projection(round.sessionId));
    yield* resolveTools(round.sessionId, mirror);
    if (!isMoot(mirror, yield* DateTime.now)) return yield* new StopRejected({ key: round.key });
  });

  /**
   * The engine's stop, then a cancel per waiting run. Each command is answered
   * once the engine recorded it: the provider's interrupt runs after (**Read**
   * at `db51b67`, `dispatchThreadStop`), and the events say when it took.
   *
   * The engine's stop is sent whatever the session looks like: the server
   * stops every session it recorded as a target, and the engine's stop
   * reaches what the adapter cannot see whole. With no turn running, it
   * interrupts the latest run while that run's background work is pending,
   * stops the thread's delegated tasks, disarms a pending usage-limit
   * continuation and holds the queue (**Read**, `dispatchThreadStop`,
   * `derivePendingBackgroundWork`, `holdStoppedThread`).
   */
  const stop = Effect.fn("Engine.stop")(function* (input: {
    readonly key: IdempotencyKey;
    readonly sessionId: SessionId;
  }) {
    yield* liveProjection(input.sessionId);
    const threadId = ThreadId.make(input.sessionId);
    // The engine's stop ends the running turn and only holds the queue.
    yield* sendStopStep(
      input,
      {
        type: "thread.stop",
        commandId: commandId("stop", input.key),
        threadId,
        stopDelegatedTasks: true,
      },
      nothingToStop,
    );
    // J3 Bots' Stop also ends every turn that waits.
    yield* afterSending(
      Effect.gen(function* () {
        const held = yield* projection(input.sessionId);
        for (const run of queuedRuns(held)) {
          yield* sendStopStep(
            input,
            {
              type: "queued-run.cancel",
              commandId: commandId(`cancel-${run.id}`, input.key),
              threadId,
              runId: RunId.make(run.id),
            },
            (mirror) => {
              const now = mirror.runs.get(run.id);
              return now === undefined || isEnded(now) || now.status === "running";
            },
          );
        }
      }),
    );
  });

  /**
   * Releases a held queue, keyed by the hold it answers. The engine refuses a
   * resume while the session waits on a usage limit, whose continuation runs
   * first; that counts as done, since the hold is reported again when a turn
   * starts while it lasts. **Read** at `db51b67`, `Orchestrator.ts`,
   * `queue.resume`.
   */
  const resumeQueue = Effect.fn("Engine.resumeQueue")(function* (input: {
    readonly sessionId: SessionId;
    readonly hold: EventCursor;
  }) {
    yield* command({
      type: "queue.resume",
      commandId: commandId("resume", `${input.sessionId}:${input.hold}`),
      threadId: ThreadId.make(input.sessionId),
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        OrchestrationV2DispatchCommandError: () => afterSending(liveProjection(input.sessionId)),
      }),
      Effect.asVoid,
    );
  });

  const retireSession = Effect.fn("Engine.retireSession")(function* (sessionId: SessionId) {
    // A fresh key on every call: a Stop the engine refused spends its key.
    const key = IdempotencyKey.make(`retire:${sessionId}:${yield* uniqueKey}`);
    const retire = stop({ key, sessionId }).pipe(
      Effect.catchTag("StopRejected", () => Effect.fail(new EngineIndeterminate())),
      Effect.andThen(
        afterSending(
          sendSessionCommand(sessionId, {
            type: "thread.archive",
            commandId: commandId("archive", sessionId),
            threadId: ThreadId.make(sessionId),
          }),
        ),
      ),
    );
    // Already gone counts as retired.
    yield* retire.pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
    // A retired session's streams end, and nothing resumes them.
    batches.forget(sessionId);
    yield* toolReads.forget(sessionId);
  });

  // ---------------------------------------------------------------------------
  // Dispatch

  const sendDispatch = Effect.fnUntraced(function* (input: DispatchInput) {
    const kind = input.delivery._tag;
    const attachments: Array<ChatAttachment> = input.attachments.map((attachment) => ({
      type: isInlineImage(attachment.mediaType) ? "image" : "file",
      id: attachment.stagedId,
      name: attachment.name,
      mimeType: attachment.mediaType,
      sizeBytes: attachment.size,
    }));
    const sent = yield* sendByReceipt({
      type: "message.dispatch",
      commandId: commandId("dispatch", input.key),
      threadId: ThreadId.make(input.sessionId),
      messageId: MessageId.make(messageIdFor(kind, input.key)),
      text: input.text,
      attachments,
      // A server message never releases a queue the engine holds, as an operator's would.
      createdBy: "system",
      creationSource: "server",
      ...(input.delivery._tag === "start"
        ? {
            dispatchMode: { type: "start_immediately" as const },
            ...(input.delivery.freshContext ? { freshContext: true } : {}),
          }
        : {
            dispatchMode: {
              type: "steer_active" as const,
              targetRunId: RunId.make(input.delivery.turnId),
            },
          }),
    });
    if (sent === "rejected") return yield* new DispatchRejected({ key: input.key });
  });

  const dispatch = Effect.fn("Engine.dispatch")(function* (input: DispatchInput) {
    const before = yield* liveProjection(input.sessionId);
    if (knowsDispatch(before, input.key)) {
      return yield* Effect.die(new Error(`A first dispatch of a key already sent: ${input.key}`));
    }
    if (input.delivery._tag === "start") {
      const busy = activeTurn(before);
      if (Option.isSome(busy)) {
        return yield* new SessionBusy({ sessionId: input.sessionId, turnId: busy.value });
      }
    }
    yield* sendDispatch(input);
    const after = yield* projection(input.sessionId).pipe(
      Effect.mapError(() => new EngineIndeterminate()),
    );
    const disposition = dispositionOf(after, input.key);
    // Accepted, yet not in the engine's record: nothing more can be said.
    if (Option.isNone(disposition)) return yield* new EngineIndeterminate();
    return disposition.value;
  });

  /** No local check: the busy session may be this key's own turn. */
  const redispatch = Effect.fn("Engine.redispatch")(function* (input: DispatchInput) {
    yield* sendDispatch(input);
  });

  // ---------------------------------------------------------------------------
  // Attachments

  const stageAttachment = Effect.fn("Engine.stageAttachment")(function* (input: {
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly path: string;
  }) {
    yield* ready;
    // The server stages only metadata it normalized: anything else is its bug.
    const metadata = normalizeAttachmentMetadata(input);
    if (
      metadata === undefined ||
      metadata.name !== input.name ||
      metadata.mediaType !== input.mediaType
    ) {
      return yield* Effect.die(
        new Error(`Attachment metadata the engine would refuse: ${input.name}`),
      );
    }
    const request = yield* decodeUploadInput({
      type: isInlineImage(metadata.mediaType) ? "image" : "file",
      name: metadata.name,
      mimeType: metadata.mediaType,
      sizeBytes: input.size,
    }).pipe(Effect.orDie);
    const signed = yield* rpc["attachments.createUploadUrl"](request).pipe(
      Effect.timeoutOrElse({
        duration: COMMAND_TIMEOUT,
        orElse: () => Effect.fail(new EngineIndeterminate()),
      }),
      Effect.catchTags({
        RpcClientError: () => Effect.fail(new EngineIndeterminate()),
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        AttachmentUploadSigningKeyError: () => Effect.fail(new EngineUnavailable()),
      }),
    );
    const bytes = yield* fs.readFile(input.path).pipe(Effect.orDie);
    const token = yield* currentToken;
    yield* upload(
      http,
      HttpClientRequest.post(`${baseUrl(options.port)}${signed.relativeUrl}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.bodyUint8Array(bytes, metadata.mediaType),
      ),
      { size: bytes.byteLength, commandTimeout: COMMAND_TIMEOUT },
    );
    const now = yield* DateTime.now;
    return {
      id: EngineAttachmentId.make(signed.attachmentId),
      usableUntil: DateTime.addDuration(now, STAGED_LIFETIME),
    };
  });

  // ---------------------------------------------------------------------------
  // Requests

  /** The request an answer is for, open or not, or `RequestClosed` if the engine has none. */
  const knownRequest = Effect.fnUntraced(function* (sessionId: SessionId, requestId: RequestId) {
    const found = findRequest(yield* liveProjection(sessionId), requestId);
    if (Option.isNone(found)) return yield* new RequestClosed({ requestId });
    return found.value;
  });

  /**
   * Sends an answer to an approval or a question. The engine replays a command
   * id it already applied (**Read**, `db51b67`, `Orchestrator.ts`), so a retry
   * with the same key succeeds even after the answer closed the request. It
   * refuses any other answer to a request that is no longer pending, which is
   * `RequestClosed`.
   */
  const sendAnswer = (sessionId: SessionId, requestId: RequestId, input: OrchestrationV2Command) =>
    command(input).pipe(
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        OrchestrationV2DispatchCommandError: (error) =>
          afterSending(projection(sessionId)).pipe(
            Effect.flatMap((mirror) => {
              const now = findRequest(mirror, requestId);
              return Option.isSome(now) && now.value.resolution === undefined
                ? refused(error)
                : Effect.fail(new RequestClosed({ requestId }));
            }),
          ),
      }),
      Effect.asVoid,
    );

  const respond = Effect.fn("Engine.respond")(function* (input: {
    readonly key: IdempotencyKey;
    readonly sessionId: SessionId;
    readonly requestId: RequestId;
    readonly response: RequestResponse;
  }) {
    const { answerTo, request } = yield* knownRequest(input.sessionId, input.requestId);
    const response = input.response;
    // The caller's bug, not the engine's.
    const misuse = () =>
      Effect.die(new Error(`A ${response._tag} response cannot answer request ${input.requestId}`));
    const threadId = ThreadId.make(input.sessionId);
    const commandIdOf = commandId("respond", input.key);
    switch (response._tag) {
      case "approval":
        if (answerTo._tag !== "runtime-request" || request._tag !== "approval")
          return yield* misuse();
        return yield* sendAnswer(input.sessionId, input.requestId, {
          type: "runtime-request.respond",
          commandId: commandIdOf,
          threadId,
          requestId: RuntimeRequestId.make(answerTo.requestId),
          decision: APPROVAL_DECISIONS[response.decision],
        });
      case "question": {
        if (answerTo._tag !== "user-input" || request._tag !== "question") return yield* misuse();
        const answers = engineAnswersOf(answerTo.questions, response.answers);
        if (answers === undefined) return yield* misuse();
        return yield* sendAnswer(input.sessionId, input.requestId, {
          type: "runtime-request.respond",
          commandId: commandIdOf,
          threadId,
          requestId: RuntimeRequestId.make(answerTo.requestId),
          answers,
        });
      }
      case "dismiss":
        if (answerTo._tag !== "user-input") return yield* misuse();
        return yield* sendAnswer(input.sessionId, input.requestId, {
          type: "thread.user-input.dismiss",
          commandId: commandIdOf,
          threadId,
          requestId: RuntimeRequestId.make(answerTo.requestId),
        });
    }
  });

  /**
   * One secret submission per request at a time. The engine does not order
   * two answers to one request: both can pass its pending check, and the
   * second then finds the first's value stored and reports success too
   * (**Read** at `db51b67`, `SecretRequests.answer`: the store ignores an
   * existing value, and both record the same command id). J3 Bots is the only
   * client of its engine, so serializing here makes a second submission see
   * the request closed.
   */
  const secretLocks = new Map<string, { readonly lock: Semaphore.Semaphore; holders: number }>();
  const withSecretLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const existing = secretLocks.get(key);
        if (existing !== undefined) {
          existing.holders += 1;
          return existing;
        }
        const created = { lock: yield* Semaphore.make(1), holders: 1 };
        secretLocks.set(key, created);
        return created;
      }),
      (entry) => entry.lock.withPermit(effect),
      (entry) =>
        Effect.sync(() => {
          entry.holders -= 1;
          if (entry.holders === 0) secretLocks.delete(key);
        }),
    );

  const respondSecret = Effect.fn("Engine.respondSecret")(function* (input: {
    readonly sessionId: SessionId;
    readonly requestId: RequestId;
    readonly answer: SecretAnswer;
  }) {
    yield* withSecretLock(
      `${input.sessionId}:${input.requestId}`,
      Effect.gen(function* () {
        const found = yield* knownRequest(input.sessionId, input.requestId);
        // Answered once by nature: an answered request, or one that is no secret, is closed to it.
        if (found.answerTo._tag !== "secret" || found.resolution !== undefined) {
          return yield* new RequestClosed({ requestId: input.requestId });
        }
        yield* rpc["secrets.answerRequest"]({
          threadId: ThreadId.make(input.sessionId),
          turnItemId: TurnItemId.make(found.answerTo.turnItemId),
          answer:
            input.answer._tag === "provide"
              ? { type: "save", secret: Redacted.value(input.answer.value) }
              : { type: "decline" },
        }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT,
            orElse: () => Effect.fail(new EngineIndeterminate()),
          }),
          Effect.catchTags({
            RpcClientError: () => Effect.fail(new EngineIndeterminate()),
            EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
            SecretRequestError: (error) =>
              error.reason === "already_answered" ||
              error.reason === "not_found" ||
              error.reason === "agent_stopped"
                ? Effect.fail(new RequestClosed({ requestId: input.requestId }))
                : refused(error),
          }),
        );
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Events

  /** Open `events` streams per session, for `synchronize`. */
  const syncTargets = new Map<string, Set<SyncTarget>>();

  const events = (input: { readonly sessionId: SessionId; readonly after: EventCursor | null }) =>
    Stream.callback<SessionEvent, SessionNotFound | EngineIncompatible>((output) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(input.sessionId);
        const stream = (yield* Random.nextIntBetween(0, 2 ** 31 - 1)).toString(36);
        const target: SyncTarget = {
          inputs: yield* Queue.unbounded<LoopInput>(),
          closed: yield* Deferred.make<void>(),
        };
        const inputs = target.inputs;
        const targets = syncTargets.get(input.sessionId) ?? new Set<SyncTarget>();
        targets.add(target);
        syncTargets.set(input.sessionId, targets);
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(target.closed, undefined).pipe(
            Effect.andThen(Effect.sync(() => targets.delete(target))),
          ),
        );

        batches.open(input.sessionId);
        const resumed = batches.resume(input.sessionId, input.after);
        let mirror = resumed?.mirror ?? emptyMirror();
        /** What this stream has told; undefined until its first state went out. */
        let view: View | undefined = resumed?.view;
        /** The engine sequence the mirror is at. */
        let sequence = resumed?.sequence ?? -1;
        let lastCursor: EventCursor | null = resumed?.lastCursor ?? null;
        /** Where the last batch this stream emitted stands. */
        let lastPlace: BatchPlace | undefined;

        const emit = Effect.fnUntraced(function* (bodies: ReadonlyArray<EventBody>) {
          if (bodies.length === 0 || view === undefined) return;
          const at = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
          const position = Math.max(sequence, 0);
          const place: BatchPlace = {
            sequence: position,
            part: lastPlace?.sequence === position ? lastPlace.part + 1 : 0,
          };
          lastPlace = place;
          const emitted = bodies.map((body, index): SessionEvent => ({
            ...body,
            cursor: cursorFor(place, index, bodies.length, stream),
            at,
          }));
          batches.keep(input.sessionId, stream, place, {
            mirror: copyMirror(mirror),
            view: copyView(view),
            events: emitted,
          });
          for (const event of emitted) {
            lastCursor = event.cursor;
            yield* Queue.offer(output, event);
          }
        });

        /**
         * A whole state in one `replaced`. The first of a stream that cannot
         * replay carries history when the caller had a cursor; any later one,
         * a reconnect the engine answered with a snapshot, always does: the
         * caller cannot tell what the gap held.
         */
        const replace = Effect.fnUntraced(function* (history: boolean) {
          const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
          const replaced = replacement(mirror, history, now, batches.toldHandoffs(input.sessionId));
          view = replaced.view;
          yield* emit([replaced.event]);
        });

        /** Applies one engine stream item to the mirror and tells what changed. */
        const handle = Effect.fnUntraced(function* (item: OrchestrationV2ThreadStreamItem) {
          switch (item.kind) {
            case "snapshot": {
              if (item.snapshotSequence <= sequence && view !== undefined) return;
              mirror = mirrorOf(item.projection, mirror);
              sequence = item.snapshotSequence;
              yield* digestToolCalls(mirror);
              yield* replace(view !== undefined || input.after !== null);
              return;
            }
            case "event": {
              if (item.sequence <= sequence) return;
              sequence = item.sequence;
              if (!applyEvent(mirror, item.event) || view === undefined) return;
              yield* digestToolCalls(mirror);
              yield* emit(diff(mirror, view, DateTime.makeUnsafe(yield* Clock.currentTimeMillis)));
              return;
            }
            default:
              return;
          }
        });

        /** Held file changes asked for, by item id and version: each version is asked for once. */
        const asked = new Set<string>();
        /**
         * The read of each live tool's persistence this stream asked for, by
         * item id, while the item stays live: a tool is asked for once at a
         * time, and only the latest read's answer counts.
         */
        const toolAsks = new Map<string, number>();
        let lastAsk = 0;

        /**
         * Fetches, off the loop, each file change an open approval holds back
         * without its diff, once per version of the item. Only a fetched item
         * comes back to the loop: a fetch that fails or takes longer than
         * `FETCH_TIMEOUT` leaves the card a summary, and is not tried again.
         * Each live dynamic tool whose input the stream summarized is read
         * too, for its persistence: one whose read failed is asked for again
         * on a pass here, which every event and every catch-up runs, once its
         * backoff passed, and until one succeeds or the reads give up the
         * tool counts as pending. The stream, which has every event in order,
         * is what prunes the session's reads, by what its mirror shows ended.
         * A tool that ended, or left the mirror, loses what this stream
         * learned of it and its read: should it be reopened, it is read again,
         * and the answer of a read asked for before counts for nothing.
         */
        const fetchChanges = Effect.fnUntraced(function* () {
          yield* toolReads.prune(input.sessionId, sequence, (itemId) =>
            isEndedTool(mirror, itemId),
          );
          const gone = (itemId: string) => !mirror.items.has(itemId) || isEndedTool(mirror, itemId);
          for (const itemId of toolAsks.keys()) if (gone(itemId)) toolAsks.delete(itemId);
          for (const itemId of mirror.toolPersistence.keys()) {
            if (gone(itemId)) mirror.toolPersistence.delete(itemId);
          }
          for (const itemId of toolsToResolve(mirror)) {
            if (toolAsks.has(itemId)) continue;
            const ask = ++lastAsk;
            toolAsks.set(itemId, ask);
            yield* toolPersistence(input.sessionId, itemId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.sync(() => {
                      if (toolAsks.get(itemId) === ask) toolAsks.delete(itemId);
                    }),
                  onSome: (persistence) =>
                    Queue.offer(inputs, { _tag: "tool", itemId, ask, persistence }),
                }),
              ),
              Effect.forkScoped,
            );
          }
          for (const change of changesToFetch(mirror)) {
            const key = `${change.id}@${DateTime.toEpochMillis(change.updatedAt)}`;
            if (asked.has(key)) continue;
            asked.add(key);
            yield* rpc["orchestration.getTurnItem"]({ threadId, itemId: change.id }).pipe(
              Effect.timeoutOption(FETCH_TIMEOUT),
              Effect.flatMap((fetched) => {
                const item = Option.getOrUndefined(fetched)?.item;
                return item?.type === "file_change"
                  ? Queue.offer(inputs, { _tag: "fetched", item })
                  : Effect.void;
              }),
              Effect.ignore,
              Effect.forkScoped,
            );
          }
        });

        const subscribe = (marker: boolean) =>
          rpc["orchestration.subscribeThread"]({
            threadId,
            ...(sequence < 0 ? {} : { afterSequence: sequence }),
            ...(marker ? { requestCompletionMarker: true } : {}),
          });

        /** Feeds the main engine subscription into the loop, resubscribing after a loss. */
        const pump = Effect.gen(function* () {
          while (true) {
            const lost = yield* subscribe(false).pipe(
              Stream.runForEach((item) => Queue.offer(inputs, { _tag: "item", item })),
              Effect.as<LoopInput>({ _tag: "lost" }),
              Effect.catchTags({
                OrchestrationV2GetThreadProjectionError: (error) =>
                  Effect.succeed<LoopInput>({ _tag: isMissingThread(error) ? "missing" : "lost" }),
              }),
              Effect.orElseSucceed((): LoopInput => ({ _tag: "lost" })),
            );
            yield* Queue.offer(inputs, lost);
            if (lost._tag === "missing") return;
            // Wait for the engine before asking again; the socket reconnects on its own.
            yield* Effect.sleep(Duration.millis(500));
            yield* stateChanges(state).pipe(
              Stream.filter(
                (current) => current._tag === "ready" || current._tag === "incompatible",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          }
        });

        // A resume from a kept batch tells first what the stream emitted after the cursor at its
        // engine sequence. An approval still open may have been told only as a summary: its
        // change is fetched now, since the engine has nothing new to send for it.
        if (resumed !== undefined) {
          for (const event of resumed.replay) yield* Queue.offer(output, event);
          yield* fetchChanges();
        }
        yield* Effect.forkScoped(pump);

        /**
         * Catches up to the engine's completion marker on a second
         * subscription. Without the marker in time, the catch-up failed: no
         * `synchronized` goes out.
         */
        const catchUp = Effect.fnUntraced(function* (token: SyncToken) {
          let marked = false;
          const outcome = yield* subscribe(true).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runForEach((item) =>
              item.kind === "synchronized"
                ? Effect.sync(() => {
                    marked = true;
                  })
                : // Whole or not at all: a cancelled catch-up never leaves
                  // the mirror ahead of what this stream emitted.
                  Effect.uninterruptible(handle(item)),
            ),
            Effect.timeoutOption(SYNC_TIMEOUT),
            Effect.map((caught) => (Option.isSome(caught) && marked ? "marked" : "late")),
            Effect.catchTag("OrchestrationV2GetThreadProjectionError", (error) =>
              Effect.succeed(isMissingThread(error) ? ("missing" as const) : ("lost" as const)),
            ),
            Effect.orElseSucceed(() => "lost" as const),
          );
          if (outcome === "missing" || isDeleted(mirror)) {
            return yield* new SessionNotFound({ sessionId: input.sessionId });
          }
          if (outcome !== "marked" || lastCursor === null) return yield* new EngineUnavailable();
          yield* Queue.offer(output, {
            _tag: "synchronized",
            token,
            backgroundWork: yield* reportedWork(input.sessionId, mirror),
            runnableTurns: runnableTurns(mirror),
            cursor: lastCursor,
            at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          });
        });

        /** The engine has no record of the session's thread, or deleted it. */
        const gone = Effect.suspend(() => {
          batches.forget(input.sessionId);
          return toolReads
            .forget(input.sessionId)
            .pipe(
              Effect.andThen(
                Queue.fail(output, new SessionNotFound({ sessionId: input.sessionId })),
              ),
            );
        });

        while (true) {
          const next = yield* Queue.take(inputs);
          switch (next._tag) {
            case "missing":
              return yield* gone;
            case "lost": {
              const current = yield* SubscriptionRef.get(state);
              if (current._tag === "incompatible") {
                return yield* Queue.fail(
                  output,
                  new EngineIncompatible({
                    runningVersion: current.runningVersion,
                    pinnedVersion: pin.version,
                  }),
                );
              }
              break;
            }
            case "item":
              yield* handle(next.item);
              if (isDeleted(mirror)) return yield* gone;
              yield* fetchChanges();
              break;
            case "tool":
              // Asked for before the tool ended, or before a later read: it
              // says nothing of the tool as it is now.
              if (toolAsks.get(next.itemId) !== next.ask) break;
              // No session event is made of it: only `backgroundWorkOf` reads it.
              mirror.toolPersistence.set(next.itemId, next.persistence);
              break;
            case "fetched":
              // The approval may have closed, or its item moved on, since it was asked for: the
              // card changes only while the approval is open and holds the item at that version.
              if (keepFetched(mirror, next.item) && view !== undefined) {
                yield* emit(
                  diff(mirror, view, DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
                );
              }
              break;
            case "sync":
              if (yield* Deferred.isDone(next.abandoned)) break;
              yield* catchUp(next.token).pipe(
                Effect.matchEffect({
                  onFailure: (error) => Deferred.fail(next.done, error),
                  onSuccess: () => Deferred.succeed(next.done, undefined),
                }),
                Effect.raceFirst(Deferred.await(next.abandoned)),
              );
              if (isDeleted(mirror)) return yield* gone;
              yield* fetchChanges();
              break;
          }
        }
      }),
    );

  const synchronize = Effect.fn("Engine.synchronize")(function* (input: {
    readonly sessionId: SessionId;
    readonly token: SyncToken;
  }) {
    yield* liveProjection(input.sessionId);
    yield* Effect.forEach(
      [...(syncTargets.get(input.sessionId) ?? [])],
      (target) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<void, EngineUnavailable | SessionNotFound>();
          const abandoned = yield* Deferred.make<void>();
          yield* Queue.offer(target.inputs, { _tag: "sync", token: input.token, done, abandoned });
          // A stream that closes owes no marker any more.
          yield* Effect.raceFirst(Deferred.await(done), Deferred.await(target.closed)).pipe(
            // Given up on, by the caller or the timeout: the loop drops it.
            Effect.onInterrupt(() => Deferred.succeed(abandoned, undefined)),
          );
        }),
      { concurrency: "unbounded", discard: true },
    ).pipe(
      // Past its own catch-up, a stream may be behind on what it emits.
      Effect.timeoutOrElse({
        duration: Duration.sum(SYNC_TIMEOUT, SYNC_TIMEOUT),
        orElse: () => Effect.fail(new EngineUnavailable()),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Status and console

  /** The engine's own report of its provider instances, kept while it is ready. */
  const reported = yield* SubscriptionRef.make<ReadonlyArray<ServerProvider>>([]);
  /**
   * Every report the engine sends, from a subscription opened again a few
   * seconds after it ends or fails, for as long as the engine is ready.
   */
  const reports = Stream.suspend(() =>
    rpc["subscribeServerConfig"]({ workspaceSnapshotsOnDemand: true }),
  ).pipe(
    Stream.map(providersOfEvent),
    Stream.filter((providers) => providers !== undefined),
    Stream.catchCause(() => Stream.empty),
    Stream.repeat(Schedule.spaced(PROVIDER_RESUBSCRIBE)),
  );
  yield* stateChanges(state).pipe(
    // An engine that is not ready reports nothing: a report from before it
    // left is not kept for when it is back.
    Stream.switchMap((current) =>
      current._tag === "ready" ? reports : Stream.succeed<ReadonlyArray<ServerProvider>>([]),
    ),
    Stream.runForEach((providers) => SubscriptionRef.set(reported, providers)),
    Effect.forkScoped,
  );

  const status = Stream.zipLatestWith(
    stateChanges(state),
    SubscriptionRef.changes(reported),
    (current, engineProviders): EngineStatus => {
      switch (current._tag) {
        case "ready":
          return {
            state: { _tag: "ready" },
            pinnedVersion: pin.version,
            providers: providerStatuses(options.providers, engineProviders),
          };
        case "starting":
          return { state: { _tag: "starting" }, pinnedVersion: pin.version, providers: [] };
        case "incompatible":
          return {
            state: { _tag: "incompatible", runningVersion: current.runningVersion },
            pinnedVersion: pin.version,
            providers: [],
          };
        case "unavailable":
          return {
            state: { _tag: "unavailable", reason: current.reason },
            pinnedVersion: pin.version,
            providers: [],
          };
      }
    },
  ).pipe(Stream.changesWith(sameStatus));

  const consoleLink = Effect.gen(function* () {
    yield* ready;
    const executable = yield* Deferred.await(installed);
    const output = yield* spawner
      .string(
        boundedCommand(executable, [
          "auth",
          "pairing",
          "create",
          "--base-dir",
          options.home,
          "--base-url",
          baseUrl(options.port),
          "--ttl",
          "5m",
          "--json",
        ]),
      )
      .pipe(Effect.mapError(() => new EngineUnavailable()));
    return (yield* decodePairing(output).pipe(Effect.mapError(() => new EngineUnavailable())))
      .pairUrl;
  }).pipe(Effect.withSpan("Engine.consoleLink"));

  return Engine.of({
    status,
    connectProviders,
    consoleLink,
    ensureProject,
    removeProject,
    openSession,
    configureSession,
    retireSession,
    dispatch,
    redispatch,
    stageAttachment,
    stop,
    resumeQueue,
    respond,
    respondSecret,
    events,
    synchronize,
  });
});

/**
 * The engine, installed, provisioned, supervised and connected for as long as
 * the layer lives. Closing it stops the engine.
 */
export const layer = (options: EngineOptions) => Layer.effect(Engine, make(options));
