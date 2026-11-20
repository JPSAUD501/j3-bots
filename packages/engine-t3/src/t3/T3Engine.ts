// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ModelChoice, PermissionMode } from "@j3-bots/contracts";
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
  type ProviderInstance,
  type RequestResponse,
  type SecretAnswer,
} from "../Engine.ts";
import {
  DispatchRejected,
  EngineIncompatible,
  EngineIndeterminate,
  EngineUnavailable,
  ModelUnavailable,
  ProjectNotFound,
  RequestClosed,
  SessionBusy,
  SessionNotFound,
} from "../errors.ts";
import type { SessionEvent } from "../events.ts";
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
import { ORCHESTRATION_PROTOCOL, pin } from "./Pin.ts";
import type { FileChangeItem } from "./approvalDetail.ts";
import { cursorFor, makeBatches, type BatchPlace } from "./Batches.ts";
import { makePrivateFiles } from "./PrivateFiles.ts";
import { instanceIdFor, provision, type InstanceSpec } from "./Provision.ts";
import { baseUrl, stateChanges, supervise, type ProcessState } from "./Supervisor.ts";
import {
  activeTurn,
  applyEvent,
  changesToFetch,
  copyMirror,
  copyView,
  diff,
  digestToolCalls,
  dispositionOf,
  emptyMirror,
  engineAnswersOf,
  findRequest,
  isEnded,
  isRetired,
  keepFetched,
  knowsDispatch,
  mirrorOf,
  queuedRuns,
  replacement,
  type EventBody,
  type Mirror,
  type View,
} from "./Translate.ts";

// The `Engine` service over a real T3 Code server. See `Engine.ts` for the
// contract; this file only says how each method meets it.

/** A command that has had no reply for this long counts as lost. */
const COMMAND_TIMEOUT = Duration.seconds(30);
/** How long `synchronize` waits for the engine's marker on each stream. */
const SYNC_TIMEOUT = Duration.seconds(30);
/** How long fetching an approval's file change may take; past it the card stays a summary. */
const FETCH_TIMEOUT = Duration.seconds(10);
/** Batches kept per session, for resuming an `events` stream by replay. */
const BATCHES_KEPT = 32;
/** How long a staged file stays usable: half the engine's 24-hour sweep. */
const STAGED_LIFETIME = Duration.hours(12);
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
  | { readonly _tag: "lost" }
  | { readonly _tag: "missing" }
  | {
      readonly _tag: "sync";
      readonly token: SyncToken;
      /** Settled once the marker went out, or the catch-up failed. */
      readonly done: Deferred.Deferred<void, EngineUnavailable | SessionNotFound>;
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
  const provisionEngine = provision({
    home: options.home,
    files,
    instances: options.providers.map(instanceSpecOf),
    toolBridge: options.toolBridge,
    systemPromptFile: options.systemPromptFile,
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));

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
      yield* supervise({
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
    }),
  );

  const rpc = yield* makeEngineRpc({ port: options.port, token: currentToken });

  /** The batches every session's streams emitted, for resuming one by replay. */
  const batches = makeBatches(BATCHES_KEPT);

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
            OrchestrationV2GetThreadProjectionError: () =>
              Effect.fail(new SessionNotFound({ sessionId })),
          }),
        ),
      ),
      Effect.map((projection) => mirrorOf(projection)),
    );

  /** The state of a session that is still in use: a retired one is `SessionNotFound`. */
  const liveProjection = (sessionId: SessionId) =>
    projection(sessionId).pipe(
      Effect.filterOrFail(
        (mirror) => !isRetired(mirror),
        () => new SessionNotFound({ sessionId }),
      ),
    );

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

  const configureSession = Effect.fn("Engine.configureSession")(function* (input: {
    readonly sessionId: SessionId;
    readonly model?: ModelChoice;
    readonly permissionMode?: PermissionMode;
  }) {
    yield* liveProjection(input.sessionId);
    const threadId = ThreadId.make(input.sessionId);
    const selection = input.model === undefined ? undefined : yield* modelSelection(input.model);
    if (selection !== undefined) {
      yield* sendSessionCommand(input.sessionId, {
        type: "thread.model-selection.set",
        commandId: commandId("model", `${input.sessionId}:${yield* uniqueKey}`),
        threadId,
        modelSelection: selection,
      });
    }
    if (input.permissionMode !== undefined) {
      const send = sendSessionCommand(input.sessionId, {
        type: "thread.runtime-mode.set",
        commandId: commandId("mode", `${input.sessionId}:${yield* uniqueKey}`),
        threadId,
        runtimeMode: RUNTIME_MODES[input.permissionMode],
      });
      yield* selection === undefined ? send : afterSending(send);
    }
  });

  // ---------------------------------------------------------------------------
  // Stop

  /**
   * Sends one command of a Stop. The engine refuses a step that has become moot
   * (the run it cancels already ended), which counts as done.
   */
  const sendStopStep = (
    sessionId: SessionId,
    input: OrchestrationV2Command,
    isMoot: (mirror: Mirror) => boolean,
  ) =>
    command(input).pipe(
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        OrchestrationV2DispatchCommandError: (error) =>
          afterSending(projection(sessionId)).pipe(
            Effect.flatMap((mirror) => (isMoot(mirror) ? Effect.void : refused(error))),
          ),
      }),
      Effect.asVoid,
    );

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
      input.sessionId,
      {
        type: "thread.stop",
        commandId: commandId("stop", input.key),
        threadId,
        stopDelegatedTasks: true,
      },
      (mirror) => Option.isNone(activeTurn(mirror)),
    );
    // J3 Bots' Stop also ends every turn that waits.
    yield* afterSending(
      Effect.gen(function* () {
        const held = yield* projection(input.sessionId);
        for (const run of queuedRuns(held)) {
          yield* sendStopStep(
            input.sessionId,
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
    const retire = stop({ key: IdempotencyKey.make(`retire:${sessionId}`), sessionId }).pipe(
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
  });

  // ---------------------------------------------------------------------------
  // Dispatch

  /** The class name an error reply keeps of the engine's error, if it kept one. */
  const causeName = (error: OrchestrationV2DispatchCommandError) =>
    Option.map(decodeErrorName(error.cause), ({ name }) => name);

  /**
   * Sends a dispatch, and once more on an error reply that proves nothing, so
   * every answer comes from the key's receipt: the engine can answer with an
   * error after it applied a command, and answers its first submission of a
   * command it refused while planning with the same kind of error as any
   * other. A resend answers `{sequence}` if the key was applied, and
   * `OrchestratorCommandPreviouslyRejectedError` if it was refused. **Read**
   * at `db51b67`, `dispatchWithReceiptEffect`, `replayCommandReceipt`.
   */
  const sendDispatch = Effect.fnUntraced(function* (input: DispatchInput) {
    const kind = input.delivery._tag;
    const attachments: Array<ChatAttachment> = input.attachments.map((attachment) => ({
      type: isInlineImage(attachment.mediaType) ? "image" : "file",
      id: attachment.stagedId,
      name: attachment.name,
      mimeType: attachment.mediaType,
      sizeBytes: attachment.size,
    }));
    const send = command({
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
    }).pipe(
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
      if (Option.isNone(refusal)) return;
      if (REJECTIONS.has(refusal.value)) return yield* new DispatchRejected({ key: input.key });
      if (refusal.value === CLAIM_ERROR) {
        return yield* Effect.die(new Error(`A staged file the engine cannot claim: ${input.key}`));
      }
    }
    // Twice an error that proves nothing either way.
    return yield* new EngineIndeterminate();
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
    const upload = yield* rpc["attachments.createUploadUrl"](request).pipe(
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
    yield* http
      .execute(
        HttpClientRequest.post(`${baseUrl(options.port)}${upload.relativeUrl}`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyUint8Array(bytes, metadata.mediaType),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(() => new EngineIndeterminate()),
      );
    const now = yield* DateTime.now;
    return {
      id: EngineAttachmentId.make(upload.attachmentId),
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
          const replaced = replacement(mirror, history, now);
          view = replaced.view;
          yield* emit([replaced.event]);
        });

        /** Applies one engine stream item to the mirror and tells what changed. */
        const handle = Effect.fnUntraced(function* (item: OrchestrationV2ThreadStreamItem) {
          switch (item.kind) {
            case "snapshot": {
              if (item.snapshotSequence <= sequence && view !== undefined) return;
              mirror = mirrorOf(item.projection, mirror.fetched);
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
         * Fetches, off the loop, each file change an open approval holds back
         * without its diff, once per version of the item. Only a fetched item
         * comes back to the loop: a fetch that fails or takes longer than
         * `FETCH_TIMEOUT` leaves the card a summary, and is not tried again.
         */
        const fetchChanges = Effect.fnUntraced(function* () {
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
                OrchestrationV2GetThreadProjectionError: () =>
                  Effect.succeed<LoopInput>({ _tag: "missing" }),
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
                : handle(item),
            ),
            Effect.timeoutOption(SYNC_TIMEOUT),
            Effect.map((caught) => (Option.isSome(caught) && marked ? "marked" : "late")),
            Effect.catchTag("OrchestrationV2GetThreadProjectionError", () =>
              Effect.succeed("missing" as const),
            ),
            Effect.orElseSucceed(() => "lost" as const),
          );
          if (outcome === "missing") {
            return yield* new SessionNotFound({ sessionId: input.sessionId });
          }
          if (outcome !== "marked" || lastCursor === null) return yield* new EngineUnavailable();
          yield* Queue.offer(output, {
            _tag: "synchronized",
            token,
            cursor: lastCursor,
            at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          });
        });

        while (true) {
          const next = yield* Queue.take(inputs);
          switch (next._tag) {
            case "missing":
              batches.forget(input.sessionId);
              return yield* Queue.fail(output, new SessionNotFound({ sessionId: input.sessionId }));
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
              yield* fetchChanges();
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
              yield* catchUp(next.token).pipe(
                Effect.matchEffect({
                  onFailure: (error) => Deferred.fail(next.done, error),
                  onSuccess: () => Deferred.succeed(next.done, undefined),
                }),
              );
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
          yield* Queue.offer(target.inputs, { _tag: "sync", token: input.token, done });
          // A stream that closes owes no marker any more.
          yield* Effect.raceFirst(Deferred.await(done), Deferred.await(target.closed));
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

  const providers: EngineStatus["providers"] = options.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    harness: provider.harness === "acp-command" ? "other" : provider.harness,
    status: { _tag: "ready" },
    models: [],
    usage: [],
  }));

  const status = stateChanges(state).pipe(
    Stream.map((current): EngineStatus => {
      switch (current._tag) {
        case "ready":
          return { state: { _tag: "ready" }, pinnedVersion: pin.version, providers };
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
    }),
  );

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
