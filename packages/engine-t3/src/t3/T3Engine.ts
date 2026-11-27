// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserHostStatus,
  type EffortLevel,
  EngineStatus,
  type ModelChoice,
  ModelId,
  PermissionMode,
  type ProviderId,
} from "@j3-bots/contracts";
import {
  AttachmentCreateUploadUrlInput,
  CommandId,
  MessageId,
  type OrchestrationV2DispatchCommandError,
  type ProjectMutationError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ProjectId,
  ProjectSnapshot,
  DEFAULT_BROWSER_PROFILE_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
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
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
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
  type ModelSetting,
  type EngineOptions,
  type ConnectionOutcome,
  type ProviderConnection,
  type ProviderInstance,
  type RequestResponse,
  type SecretAnswer,
  type SessionSuggestedReply,
  type ToolBridge,
} from "../Engine.ts";
import { BrowserBridge } from "../Browser.ts";
import {
  AnswerRejected,
  BackgroundWorkRunning,
  DispatchRejected,
  EngineIncompatible,
  EngineIndeterminate,
  EngineUnavailable,
  ModelUnavailable,
  OpenRejected,
  PermissionModeRefused,
  RequestClosed,
  RetireRejected,
  SecretAnswerMismatch,
  SessionBusy,
  SessionNotFound,
  StopRejected,
} from "../errors.ts";
import { type BackgroundWork, isBackgroundWorkPending, type SessionEvent } from "../events.ts";
import {
  EngineAttachmentId,
  EngineInstanceId,
  EngineProjectId,
  EventCursor,
  IdempotencyKey,
  type RequestId,
  SessionId,
  type SyncToken,
  TurnId,
} from "../ids.ts";
import { type ProjectOverrides, withBrowserAccess } from "./BrowserAccess.ts";
import { type BrowserHostNeeds, inspectBrowserHost } from "./BrowserHost.ts";
import { boundedCommand } from "./Command.ts";
import { makeBrowserBridge } from "./BrowserBridge.ts";
import { makeEngineRpc } from "./Connection.ts";
import { secretAnswerFor } from "./secretAnswer.ts";
import {
  checkAccess,
  ensureCredential,
  issueCredential,
  renewalDue,
  type Credential,
} from "./Credential.ts";
import { installForThisMachine, installTracked } from "./Install.ts";
import { commandIdFor, messageIdFor, projectIdFor, threadIdFor } from "./Keys.ts";
import { isMissingThread } from "./missingThread.ts";
import { isBackgroundWorkRefusal } from "./backgroundRefusal.ts";
import { ORCHESTRATION_PROTOCOL, pin } from "./Pin.ts";
import type { FileChangeItem } from "./approvalDetail.ts";
import { cursorFor, makeBatches, type BatchPlace } from "./Batches.ts";
import { PERMISSION_MODES, RUNTIME_MODES } from "./Policy.ts";
import { recheckWhileTimedOut } from "./Rechecks.ts";
import { makePrivateFiles } from "./PrivateFiles.ts";
import {
  FIRST_CHECK_BUDGET,
  providerProblems,
  checkTimedOut,
  providerStatuses,
  redact,
  type UpdateRequest,
  withoutSecrets,
  providersOfEvent,
  type ReportedProvider,
  versionNumberIn,
  withFirstCheckBudget,
} from "./Providers.ts";
import { effortOptions, sameOptions } from "./Effort.ts";
import {
  activeConnection,
  driverOf,
  instanceEntry,
  instanceIdFor,
  provision,
  storeConnection,
  TOOL_BRIDGE_VARIABLE,
  linkHomeSkills,
  linkProjectSkills,
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
  liveProviderSessions,
  findRequest,
  isEnded,
  isEndedTool,
  isOver,
  isRetired,
  keepFetched,
  knowsDispatch,
  mirrorOf,
  type Providers,
  nothingToStop,
  queuedRuns,
  replacement,
  reportedWorkOf,
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

/**
 * How long the engine may take to answer a request to check a provider
 * again, which it answers once the check ends: up to 45 seconds for one
 * that ends (`FIRST_CHECK_BUDGET` says why), after reading Windows' PATH
 * again, with the room the first check's budget leaves.
 */
const RECHECK_TIMEOUT = Duration.seconds(90);
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

const APPROVAL_DECISIONS = {
  "allow-once": "accept",
  "allow-session": "acceptForSession",
  deny: "decline",
} as const;

const decodeProjects = HttpClientResponse.schemaBodyJson(ProjectSnapshot);

/** A thread of the engine's shell, as far as J3 Bots reads it: which project it is in. */
const ShellThread = Schema.Struct({ id: ThreadId, projectId: ProjectId });

/**
 * The engine's shell, live and archived threads alike, with every subagent:
 * a thread archived or idle can still hold a provider session (**Read** at
 * `bc0f04d`, `environmentHttp.ts`, `shellSnapshot`).
 */
const decodeShellThreads = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ threads: Schema.Array(ShellThread), archivedThreads: Schema.Array(ShellThread) }),
);

const isEngineDown = Schema.is(Schema.Union([EngineUnavailable, EngineIncompatible]));

/**
 * The engine error whose reply proves a command was refused, applying
 * nothing, and that the engine keeps the refusal for its key: a rejected
 * receipt found by a resend. **Read** at `bc0f04d`, `Orchestrator.ts`,
 * `dispatchWithReceiptEffect`, `replayCommandReceipt`.
 */
const PREVIOUSLY_REJECTED = "OrchestratorCommandPreviouslyRejectedError";
/**
 * The engine errors whose reply proves a command was refused for the mode it
 * would run in, applying nothing, and that the engine kept no receipt for:
 * "Refusals depend on modes the user can change; a recorded rejection would
 * block the retry". The runtime-mode ceiling of an administrator's policy
 * refuses a thread created in, or switched to, a mode above it, and a turn
 * that would run in one. The dispatch mode limit binds only the engine's
 * agent and MCP callers, never `/ws`; it is listed for the day it does.
 * **Read** at `bc0f04d`, `Orchestrator.ts`, `dispatchWithReceiptEffect`,
 * `refuseAboveRuntimeModeCeiling`, and `DispatchModeLimit.ts`.
 */
const MODE_LIMITS: ReadonlySet<string> = new Set([
  "OrchestratorThreadAboveModeLimitError",
  "OrchestratorRuntimeModeAboveCeilingError",
]);
/**
 * Refused before the engine looks at the key: a staged file it cannot claim.
 * The server names only files staged and still usable, so this is its bug.
 * **Read** at `bc0f04d`, `ThreadMessageIntake.dispatchCommand`.
 */
const CLAIM_ERROR = "AttachmentClaimError";
/**
 * A reply's cause keeps the engine error's class name and message, and nothing
 * else of it (**Read** at `bc0f04d`: `ws.ts`, the cause is a `Schema.Defect`).
 */
const decodeErrorName = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));
const decodeUploadInput = Schema.decodeUnknownEffect(AttachmentCreateUploadUrlInput);

const PairingResult = Schema.Struct({ pairUrl: Schema.String });
const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingResult));
/** A model slug the engine names, in J3 Bots' terms; one it does not accept names none. */
const decodeModelId = Schema.decodeUnknownOption(ModelId);

const instanceSpecOf =
  (toolBridge: ToolBridge) =>
  (provider: ProviderInstance): InstanceSpec => {
    const common = {
      instanceId: instanceIdFor(provider.id),
      name: provider.name,
      environment: provider.environment,
    };
    switch (provider.harness) {
      case "claude-code":
      case "codex":
        return {
          ...common,
          kind: provider.harness,
          home: provider.home,
          executable: provider.executable,
        };
      case "acp-command":
        return {
          ...common,
          // The agent starts the bridge itself, which inherits its environment.
          environment: [
            ...provider.environment,
            {
              name: TOOL_BRIDGE_VARIABLE,
              value: Redacted.make(JSON.stringify([toolBridge.command, ...toolBridge.args])),
            },
            ...toolBridge.environment,
          ],
          kind: "acp-local",
          command: provider.command,
          args: provider.args,
        };
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

/** What the engine's browser needs from this host, as the engine status says it. */
const browserHostStatus = (needs: BrowserHostNeeds): BrowserHostStatus => {
  const missing = [
    ...(needs.sandbox === "none" ? [] : (["sandbox"] as const)),
    ...(needs.missingLibraries.length > 0 ? (["libraries"] as const) : []),
    ...(needs.noFonts ? (["fonts"] as const) : []),
  ];
  return missing.length === 0 ? { _tag: "ready" } : { _tag: "setup-required", needs: missing };
};

const make = Effect.fn("engine.make")(function* (options: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;

  const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
  /** The engine's starts (`SupervisorInput.starts`): the one answering now, or that last did. */
  const starts = yield* Ref.make(0);
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
  const providerOfInstance = new Map(
    options.providers.map((provider) => [instanceIdFor(provider.id), provider.id]),
  );
  const echoingInstances = new Set(
    options.providers.flatMap((provider) =>
      provider.harness === "claude-code" ? [instanceIdFor(provider.id)] : [],
    ),
  );
  /** What the adapter reads of the providers that is the same for the engine's life. */
  const providerFacts: Omit<Providers, "redact"> = {
    modelOf: (selection) => {
      const providerId = providerOfInstance.get(selection.instanceId);
      if (providerId === undefined) return null;
      return Option.getOrNull(
        Option.map(decodeModelId(selection.model), (modelId) => ({ providerId, modelId })),
      );
    },
    echoesSteers: (instanceId) => echoingInstances.has(instanceId),
  };
  /**
   * The providers as each provisioning writes them, with the executable
   * each runs now (`setHarnessExecutable`).
   */
  const providers = yield* Ref.make(options.providers);
  /** The engine's own report of its provider instances, kept while it is ready. */
  const reported = yield* SubscriptionRef.make<ReadonlyArray<ReportedProvider>>([]);
  /**
   * The providers whose instance the engine may run with another executable
   * than `providers` names: an upsert whose outcome is not known, or one the
   * engine took without showing it runs the new executable. Each provisioning
   * writes every instance again, which settles them all.
   */
  const unsettled = yield* Ref.make<ReadonlySet<ProviderId>>(new Set());
  const instancesNow = Effect.map(Ref.get(providers), (current) =>
    current.map(instanceSpecOf(options.toolBridge)),
  );
  const instances = options.providers.map(instanceSpecOf(options.toolBridge));
  /** What the last provisioning found: whether a connection is stored, and which instances it turned off. */
  const provisioned = yield* Ref.make<{
    readonly connected: boolean;
    readonly disabled: ReadonlySet<string>;
  }>({ connected: false, disabled: new Set() });
  /** The base prompt as last rendered, which each provisioning writes for Codex. */
  const basePrompt = yield* Ref.make(
    Option.getOrElse(yield* Stream.runHead(options.basePrompt), () => ""),
  );
  /** Whether the harnesses guess the operator's next message, as last given, which each provisioning writes. */
  const suggestReplies = yield* Ref.make(
    Option.getOrElse(yield* Stream.runHead(options.suggestReplies), () => false),
  );
  /** One writer of the engine's settings, the connection and the harness homes at a time. */
  const provisioning = yield* Semaphore.make(1);
  /** The home folder the engine is given (`engineEnvironment`), which a Codex bot's commands get. */
  const userHome = yield* Config.option(Config.String("HOME")).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  /** The connection's key the engine was last started with, which its words must not carry. */
  const givenKey = yield* Ref.make<Redacted.Redacted<string> | null>(null);
  /**
   * The secrets the engine's words are cleared of (`withoutSecrets`), as the
   * engine was given them, read each time it becomes ready, and as
   * each batch of a session's events is told: a new connection restarts it.
   */
  const secrets = Effect.gen(function* () {
    const key = yield* Ref.get(givenKey);
    return [
      ...(key === null ? [] : [Redacted.value(key)]),
      ...options.providers.flatMap((provider) =>
        provider.environment.map((variable) => Redacted.value(variable.value)),
      ),
      ...options.toolBridge.environment.map((variable) => Redacted.value(variable.value)),
    ];
  });
  /** What the adapter reads of the providers now, with the secrets it is given. */
  const providerReads = Effect.map(secrets, (known): Providers => ({
    ...providerFacts,
    redact: (text) => redact(text, known),
  }));
  /** Run before each start of the engine, while it is stopped (`Supervisor.beforeStart`). */
  const provisionInput = Effect.gen(function* () {
    return {
      home: options.home,
      files,
      instances: yield* instancesNow,
      toolBridge: options.toolBridge,
      systemPromptFile: options.systemPromptFile,
      basePrompt: yield* Ref.get(basePrompt),
      sharedSkills: options.sharedSkills,
      suggestReplies: yield* Ref.get(suggestReplies),
      userHome,
    };
  });
  const provisionEngine = Effect.gen(function* () {
    const { key, disabled } = yield* provision(yield* provisionInput);
    yield* Ref.set(unsettled, new Set());
    yield* Ref.set(givenKey, key);
    yield* Ref.set(provisioned, { connected: key !== null, disabled });
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

  const linkSharedSkillsNow = linkHomeSkills({
    home: options.home,
    files,
    instances,
    sharedSkills: options.sharedSkills,
  }).pipe(
    provisioning.withPermits(1),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.withSpan("Engine.linkSharedSkills"),
  );

  const linkBotSkills = (workspacePath: string) =>
    linkProjectSkills({
      home: options.home,
      files,
      workspace: workspacePath,
      skills: options.botSkills,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.withSpan("Engine.linkBotSkills"),
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
   * Installs the pinned engine, unless overridden, with its download in the
   * state (`installTracked`). A failed install is a state, never a crash: the
   * engine is `unavailable` with the reason while the install is retried.
   */
  const install = Option.isSome(options.binaryOverride)
    ? Effect.succeed(options.binaryOverride.value)
    : installTracked({
        state,
        install: (onDownload) => installForThisMachine(options.home, files, onDownload),
        retry: INSTALL_RETRY,
      }).pipe(platformServices);

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
        starts,
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
  /**
   * Whether the engine found the browser's sandbox blocked when it last
   * started the browser for a viewer, until a viewer sees it start: what the
   * host check cannot see without root (`SandboxBlock`).
   */
  const sandboxRefused = yield* Ref.make(false);
  /** Asks for the host check (`checkBrowserHost`) to run again. */
  const browserHostChecks = yield* Queue.sliding<void>(1);
  const recheckBrowserHost = Queue.offer(browserHostChecks, undefined).pipe(Effect.asVoid);
  const browser = makeBrowserBridge({
    rpc,
    state,
    port: options.port,
    token: currentToken,
    http,
    reportStart: (start) =>
      start._tag === "started"
        ? Ref.getAndSet(sandboxRefused, false).pipe(
            Effect.flatMap((refused) => (refused ? recheckBrowserHost : Effect.void)),
          )
        : Effect.andThen(
            start.need === "sandbox" ? Ref.set(sandboxRefused, true) : Effect.void,
            recheckBrowserHost,
          ),
  });

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
   * The engine that is ready, by the environment id its descriptor answers
   * with: a fresh data directory comes up with another one (**Verified**,
   * docs/architecture/engine.md, Isolation).
   */
  const instance = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (current._tag !== "ready") return yield* new EngineUnavailable();
    return EngineInstanceId.make(current.environmentId);
  }).pipe(Effect.withSpan("Engine.instance"));

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
  const reportedWork = (sessionId: SessionId, mirror: Mirror): Effect.Effect<BackgroundWork> => {
    const work = backgroundWorkOf(mirror);
    if (work.undecided.length === 0) return Effect.succeed(work.pending);
    const threadId = ThreadId.make(sessionId);
    return rpc["orchestration.getThreadFamily"]({ threadId }).pipe(
      Effect.timeout(SHELL_READ_TIMEOUT),
      Effect.map(({ threads }) =>
        workInShell(
          threads.find((thread) => thread.id === threadId),
          work.undecided,
        ),
      ),
      Effect.orElseSucceed(() => work.undecided),
      Effect.map((pendingTools) => reportedWorkOf(mirror, work, pendingTools)),
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
   * **Read** at `bc0f04d`, `dispatchWithReceiptEffect`, `replayCommandReceipt`.
   * A refusal for the mode the command would run in (`MODE_LIMITS`) leaves no
   * receipt and is answered as it is, so it is `mode-refused` at once. A reply
   * lost on the way is `EngineIndeterminate`, resolved by sending the same key
   * again.
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
    const refusals: Array<string> = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      // Once the first send went out, no failure but a named refusal proves
      // that nothing was applied: the engine may have taken the first one.
      const refusal = yield* attempt === 0 ? send : afterSending(send);
      if (Option.isNone(refusal)) return "applied" as const;
      if (refusal.value === PREVIOUSLY_REJECTED) return "rejected" as const;
      if (MODE_LIMITS.has(refusal.value)) return "mode-refused" as const;
      if (refusal.value === CLAIM_ERROR) {
        return yield* Effect.die(
          new Error(`A staged file the engine cannot claim: ${input.commandId}`),
        );
      }
      refusals.push(refusal.value === "" ? "unnamed" : refusal.value);
    }
    // Twice an error that proves nothing either way: sent again as a lost
    // reply is, so the caller's retry is not silent.
    yield* Effect.logWarning(
      "The engine answered a command with an error twice, with no rejected receipt; it is sent again later",
    ).pipe(Effect.annotateLogs({ command: input.type, commandId: input.commandId, refusals }));
    return yield* new EngineIndeterminate();
  });

  /**
   * The engine's refusal of `permissionMode` for the mode it would run in,
   * naming the highest mode the engine's policy allows. A reply keeps only
   * the error's name and message, so the ceiling is read from the engine's
   * config: `null` when that read fails in any way, a mode this adapter does
   * not know included, or its ceiling is not below the mode and so cannot be
   * what refused it. The refusal stands either way. `engineStart` is the
   * engine start read before the command was sent: the engine may start
   * again while it is on its way, so the start named is never newer than the
   * one that refused, only, rarely, older, which costs the server one more
   * ask (`Engine.starts`).
   */
  const permissionModeRefused = Effect.fnUntraced(function* (
    permissionMode: PermissionMode,
    engineStart: number,
  ) {
    const config = yield* rpc["server.getConfig"]({}).pipe(
      Effect.timeout(COMMAND_TIMEOUT),
      Effect.exit,
    );
    const ceiling = Exit.isSuccess(config)
      ? config.value.managedPolicy?.limits?.maxRuntimeMode
      : undefined;
    const allowed = ceiling === undefined ? null : PERMISSION_MODES[ceiling];
    const rank = (mode: PermissionMode) => PermissionMode.literals.indexOf(mode);
    return yield* new PermissionModeRefused({
      permissionMode,
      allowed: allowed !== null && rank(allowed) < rank(permissionMode) ? allowed : null,
      engineStart,
    });
  });

  /** An engine refusal the interface has no error for: a bug or a broken setup, not a state. */
  const refused = (error: { readonly message: string }) =>
    Effect.die(new Error(`The engine refused a command: ${error.message}`));

  /**
   * The engine's selection of `model`, asking it for `effort` while the engine
   * reports that level for the model (`effortOptions`).
   */
  const modelSelection = (model: ModelChoice, effort: EffortLevel | null) => {
    if (!providerIds.has(model.providerId)) {
      return Effect.fail(
        new ModelUnavailable({ providerId: model.providerId, modelId: model.modelId }),
      );
    }
    const instanceId = ProviderInstanceId.make(instanceIdFor(model.providerId));
    return Effect.map(SubscriptionRef.get(reported), (providers) => {
      const options = effortOptions(
        providers
          .find((provider) => provider.instanceId === instanceId)
          ?.models.find((candidate) => candidate.slug === model.modelId),
        effort,
      );
      return {
        instanceId,
        model: model.modelId,
        ...(options === undefined ? {} : { options }),
      };
    });
  };

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

  // ---------------------------------------------------------------------------
  // Browser access

  /**
   * Reads and writes of the projects' overrides take turns: each writes back
   * a project's whole set, as it read it, with one key changed.
   */
  const overridesLock = yield* Semaphore.make(1);

  /** The projects' overrides in the engine's settings. Nothing was sent, so any failure is unavailability. */
  const projectOverrides = ready.pipe(
    Effect.andThen(
      rpc["server.getSettings"]({}).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT,
          orElse: () => Effect.fail(new EngineUnavailable()),
        }),
        Effect.map((settings) => settings.projectSettingsOverrides),
        Effect.catchTags({
          RpcClientError: () => Effect.fail(new EngineUnavailable()),
          EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
          ServerSettingsError: () => Effect.fail(new EngineUnavailable()),
        }),
      ),
    ),
  );

  /**
   * Replaces the project's set of overrides, or removes it with `null`. The
   * engine refuses a settings file it cannot write (`ServerSettingsError`);
   * that and a lost reply are indeterminate, and writing the same set again
   * is harmless.
   */
  const writeOverrides = (projectId: EngineProjectId, overrides: ProjectOverrides | null) =>
    ready.pipe(
      Effect.andThen(
        rpc["server.updateSettings"]({
          patch: { projectSettingsOverrides: { [projectId]: overrides } },
        }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT,
            orElse: () => Effect.fail(new EngineIndeterminate()),
          }),
          Effect.catchTags({
            RpcClientError: () => Effect.fail(new EngineIndeterminate()),
            EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
            ServerSettingsError: () => Effect.fail(new EngineIndeterminate()),
          }),
          Effect.asVoid,
        ),
      ),
    );

  /**
   * Whether the engine's browser can run on this host, checked each time the
   * engine becomes ready and each time a bot is given the browser: an
   * administrator may have set the host up, or the engine downloaded the
   * browser, since. Checked again each time a viewer finds the browser could
   * not start for what the host lacks, which also counts a sandbox the files
   * here do not show blocked, and once one sees it start after that. Nothing
   * to check off Linux, where it needs no setup.
   */
  const browserHost = yield* SubscriptionRef.make(Option.none<BrowserHostStatus>());
  const checkBrowserHost = Effect.gen(function* () {
    if (process.platform !== "linux") {
      return yield* SubscriptionRef.set(browserHost, Option.some({ _tag: "ready" }));
    }
    const needs = yield* platformServices(
      inspectBrowserHost({ home: options.home, sandboxRefused: yield* Ref.get(sandboxRefused) }),
    );
    yield* SubscriptionRef.set(browserHost, Option.some(browserHostStatus(needs)));
  });
  yield* Stream.merge(
    stateChanges(state).pipe(Stream.filter((current) => current._tag === "ready")),
    Stream.fromQueue(browserHostChecks),
  ).pipe(
    Stream.runForEach(() => checkBrowserHost),
    Effect.forkScoped,
  );

  /**
   * Writes the operator's switch for suggested replies into the running
   * engine's settings, which it reads live (**Read** at `bc0f04d`,
   * `ProviderSessionManager.ts`, `promptSuggestionsEnabled`). Provisioning
   * writes it before each start; it is written again each time the engine
   * becomes ready, since a change made while the engine was starting reaches
   * neither. A lost reply is tried again; an engine that is not ready waits
   * for its next start, and a newer value replaces one still being written.
   */
  const writeSuggestReplies = (enabled: boolean) =>
    ready.pipe(
      Effect.andThen(
        rpc["server.updateSettings"]({ patch: { promptSuggestionsEnabled: enabled } }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT,
            orElse: () => Effect.fail(new EngineIndeterminate()),
          }),
          Effect.catchTags({
            RpcClientError: () => Effect.fail(new EngineIndeterminate()),
            EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
            ServerSettingsError: () => Effect.fail(new EngineIndeterminate()),
          }),
        ),
      ),
      Effect.retry({
        while: (error) => error._tag === "EngineIndeterminate",
        schedule: Schedule.exponential(Duration.seconds(1)),
        times: 4,
      }),
      Effect.catch((error) =>
        error._tag === "EngineIndeterminate"
          ? Effect.logWarning("The switch for suggested replies did not reach the engine", error)
          : Effect.void,
      ),
    );
  yield* Stream.merge(
    options.suggestReplies.pipe(Stream.tap((enabled) => Ref.set(suggestReplies, enabled))),
    stateChanges(state).pipe(
      Stream.filter((current) => current._tag === "ready"),
      Stream.mapEffect(() => Ref.get(suggestReplies)),
    ),
  ).pipe(
    Stream.switchMap((enabled) => Stream.fromEffect(writeSuggestReplies(enabled))),
    Stream.runDrain,
    Effect.forkScoped,
  );

  const setBrowserAccess = Effect.fn("Engine.setBrowserAccess")(function* (input: {
    readonly projectId: EngineProjectId;
    readonly enabled: boolean;
  }) {
    const current = (yield* projectOverrides)[input.projectId];
    const next = withBrowserAccess(current, input.enabled);
    if (next !== null) yield* writeOverrides(input.projectId, next);
    if (input.enabled) yield* recheckBrowserHost;
  }, overridesLock.withPermits(1));

  /** Every thread of the project the engine has, archived ones and other agents' children included. */
  const projectThreads = Effect.fn("Engine.projectThreads")(function* (projectId: EngineProjectId) {
    yield* ready;
    const token = yield* currentToken;
    const shell = yield* http
      .execute(
        HttpClientRequest.get(`${baseUrl(options.port)}/api/orchestration/shell`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeader(
            ORCHESTRATION_PROTOCOL_HEADER,
            String(ORCHESTRATION_PROTOCOL),
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeShellThreads),
        Effect.timeout(COMMAND_TIMEOUT),
        Effect.mapError(() => new EngineUnavailable()),
      );
    return [...shell.threads, ...shell.archivedThreads]
      .filter((thread) => thread.projectId === ProjectId.make(projectId))
      .map((thread) => SessionId.make(thread.id));
  });

  /**
   * Sends one step of a withdrawal, under a key of its own. A refusal counts
   * as done once a read of the thread shows the step moot (`isMoot`); a
   * thread gone is moot too. Anything else leaves the withdrawal to be tried
   * again.
   */
  const sendWithdrawalStep = Effect.fnUntraced(function* (
    threadId: SessionId,
    input: OrchestrationV2Command,
    isMoot: (mirror: Mirror) => boolean,
  ) {
    yield* command(input).pipe(
      Effect.catchTags({
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        OrchestrationV2DispatchCommandError: () =>
          afterSending(projection(threadId)).pipe(
            Effect.catchTag("SessionNotFound", () => Effect.succeed(null)),
            Effect.flatMap((mirror) =>
              mirror === null || isMoot(mirror)
                ? Effect.void
                : Effect.fail(new EngineIndeterminate()),
            ),
          ),
      }),
    );
  });

  const withdrawBrowserAccess = Effect.fn("Engine.withdrawBrowserAccess")(function* (
    projectId: EngineProjectId,
  ) {
    // First, so a provider session started from here on has no browser.
    yield* setBrowserAccess({ projectId, enabled: false });
    for (const threadId of yield* projectThreads(projectId)) {
      const mirror = yield* projection(threadId).pipe(
        Effect.asSome,
        Effect.catchTag("SessionNotFound", () => Effect.succeedNone),
      );
      if (Option.isNone(mirror)) continue;
      const thread = ThreadId.make(threadId);
      // The engine's stop holds the thread's queue, so no turn waiting in it
      // starts in the provider session about to be released, and stops the
      // thread's delegated tasks.
      if (Option.isSome(startedTurn(mirror.value))) {
        yield* sendWithdrawalStep(
          threadId,
          {
            type: "thread.stop",
            commandId: commandId("browser-stop", `${threadId}:${yield* uniqueKey}`),
            threadId: thread,
            stopDelegatedTasks: true,
          },
          (now) => Option.isNone(startedTurn(now)),
        );
      }
      for (const providerSessionId of liveProviderSessions(mirror.value)) {
        yield* sendWithdrawalStep(
          threadId,
          {
            type: "provider-session.detach",
            commandId: commandId("browser-detach", `${threadId}:${yield* uniqueKey}`),
            threadId: thread,
            providerSessionId: ProviderSessionId.make(providerSessionId),
            reason: "Browser access withdrawn.",
          },
          (now) => !liveProviderSessions(now).includes(providerSessionId),
        );
      }
    }
  });

  /**
   * The engine closes the profile's browser context, which closes its tabs,
   * and deletes its folder (**Read** at `bc0f04d`, `ServerBrowserContexts.ts`,
   * `clearProfile`). A deletion that failed may have deleted part of it:
   * indeterminate, and clearing again finishes it.
   */
  const clearBrowserProfile = ready.pipe(
    Effect.andThen(
      rpc["preview.clearProfile"]({ profileId: DEFAULT_BROWSER_PROFILE_ID }).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT,
          orElse: () => Effect.fail(new EngineIndeterminate()),
        }),
        Effect.catchTags({
          RpcClientError: () => Effect.fail(new EngineIndeterminate()),
          EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
          PreviewClearProfileError: () => Effect.fail(new EngineIndeterminate()),
        }),
      ),
    ),
    Effect.withSpan("Engine.clearBrowserProfile"),
  );

  const openSession = Effect.fn("Engine.openSession")(function* (input: {
    readonly key: IdempotencyKey;
    readonly projectId: EngineProjectId;
    readonly title: string;
    readonly model: ModelChoice;
    readonly effort: EffortLevel | null;
    readonly permissionMode: PermissionMode;
  }) {
    const sessionId = SessionId.make(threadIdFor(input.key));
    const selection = yield* modelSelection(input.model, input.effort);
    const sentTo = yield* Ref.get(starts);
    // Settled by the key's receipt, as a dispatch is: the engine keeps a
    // refusal for the key, so a refused opening is never sent again.
    const sent = yield* sendByReceipt({
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
    });
    if (sent === "rejected") return yield* new OpenRejected({ key: input.key });
    if (sent === "mode-refused") return yield* permissionModeRefused(input.permissionMode, sentTo);
    return sessionId;
  });

  /**
   * What an error reply to a settings command of the session names, once a
   * read of the session says whether it is still there. `permissionMode` is
   * the mode the command asked for, if it asked for one, and `sentTo` the
   * engine start read before it was sent (`permissionModeRefused`).
   */
  const settingsRefusal = Effect.fnUntraced(function* (
    sessionId: SessionId,
    error: OrchestrationV2DispatchCommandError,
    permissionMode: PermissionMode | undefined,
    sentTo: number,
  ) {
    yield* afterSending(projection(sessionId));
    const name = causeName(error);
    if (permissionMode !== undefined && Option.isSome(name) && MODE_LIMITS.has(name.value)) {
      return yield* permissionModeRefused(permissionMode, sentTo);
    }
    if (isBackgroundWorkRefusal(error)) return yield* new BackgroundWorkRunning({ sessionId });
    return yield* refused(error);
  });

  /**
   * Sends a change of a session's settings, under a key of its own: a refusal
   * is never sent again, and the next alignment sends what still differs. The
   * engine's refusal of the permission mode is `PermissionModeRefused`, its
   * refusal to end background work the change would end
   * `BackgroundWorkRunning`, a refusal for a missing thread `SessionNotFound`,
   * and any other a bug.
   */
  const sendSettingsCommand = (
    sessionId: SessionId,
    input: OrchestrationV2Command,
    permissionMode: PermissionMode | undefined,
  ) =>
    Effect.flatMap(Ref.get(starts), (sentTo) =>
      command(input).pipe(
        Effect.catchTags({
          EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
          OrchestrationV2DispatchCommandError: (error) =>
            settingsRefusal(sessionId, error, permissionMode, sentTo),
        }),
        Effect.asVoid,
      ),
    );

  const configureSession = Effect.fn("Engine.configureSession")(function* (
    input: {
      readonly sessionId: SessionId;
      readonly permissionMode?: PermissionMode;
      readonly reloadTools?: boolean;
    } & ModelSetting,
  ) {
    // Only what differs from what the thread runs is sent: a session opened
    // again under its key is the one the engine opened first, as it was
    // opened then, and is set to the caller's settings this way.
    const mirror = yield* liveProjection(input.sessionId);
    const thread = mirror.thread;
    const threadId = ThreadId.make(input.sessionId);
    const wanted =
      input.model === undefined ? undefined : yield* modelSelection(input.model, input.effort);
    const selection =
      wanted !== undefined &&
      (thread === undefined ||
        thread.modelSelection.instanceId !== wanted.instanceId ||
        thread.modelSelection.model !== wanted.model ||
        !sameOptions(thread.modelSelection.options, wanted.options))
        ? wanted
        : undefined;
    const mode =
      input.permissionMode !== undefined &&
      (thread === undefined || thread.runtimeMode !== RUNTIME_MODES[input.permissionMode])
        ? input.permissionMode
        : undefined;
    // The tools are reloaded by replacing the provider sessions that still
    // run, as the engine does itself on a change of runtime mode: the next
    // turn starts a new one, whose tool credential the engine issues with
    // what the project allows then, and resumes the conversation natively
    // (**Read** at `bc0f04d`, `prepareMcpSession`; `provider-session.detach`
    // is **Verified**, below). One that has stopped starts again anyway.
    const reload = input.reloadTools === true && liveProviderSessions(mirror).length > 0;
    if (selection === undefined && mode === undefined && !reload) return;
    // A change may replace the provider session, which ends a turn running in
    // it: none is sent while one runs.
    const running = startedTurn(mirror);
    if (Option.isSome(running)) {
      return yield* new SessionBusy({ sessionId: input.sessionId, turnId: running.value });
    }
    // The engine checks this for a change of model or runtime mode, and not
    // for a detach, which would end the work: checked here first, so nothing
    // is sent.
    if (reload && isBackgroundWorkPending(yield* reportedWork(input.sessionId, mirror))) {
      return yield* new BackgroundWorkRunning({ sessionId: input.sessionId });
    }
    if (selection !== undefined) {
      yield* sendSettingsCommand(
        input.sessionId,
        {
          type: "thread.model-selection.set",
          commandId: commandId("model", `${input.sessionId}:${yield* uniqueKey}`),
          threadId,
          modelSelection: selection,
        },
        undefined,
      );
    }
    if (mode !== undefined) {
      const send = sendSettingsCommand(
        input.sessionId,
        {
          type: "thread.runtime-mode.set",
          commandId: commandId("mode", `${input.sessionId}:${yield* uniqueKey}`),
          threadId,
          runtimeMode: RUNTIME_MODES[mode],
        },
        mode,
      );
      yield* selection === undefined ? send : afterSending(send);
    }
    if (reload) {
      const sent = selection !== undefined || mode !== undefined;
      // A change of model or mode may have replaced them already.
      const current = sent ? yield* afterSending(liveProjection(input.sessionId)) : mirror;
      for (const [index, providerSessionId] of liveProviderSessions(current).entries()) {
        const detach = sendSettingsCommand(
          input.sessionId,
          {
            type: "provider-session.detach",
            commandId: commandId("tools", `${input.sessionId}:${yield* uniqueKey}`),
            threadId,
            providerSessionId: ProviderSessionId.make(providerSessionId),
            reason: "Browser access changed.",
          },
          undefined,
        );
        yield* sent || index > 0 ? afterSending(detach) : detach;
      }
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
   * at `bc0f04d`, `dispatchThreadStop`), and the events say when it took.
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

  /** Force stop of the turn whose stop its provider ignores (`Engine.forceStop`). */
  const forceStop = Effect.fn("Engine.forceStop")(function* (input: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
  }) {
    yield* liveProjection(input.sessionId);
    yield* ready;
    yield* rpc["orchestration.forceStopThread"]({
      threadId: ThreadId.make(input.sessionId),
      runId: RunId.make(input.turnId),
    }).pipe(
      Effect.timeoutOrElse({
        duration: COMMAND_TIMEOUT,
        orElse: () => Effect.fail(new EngineIndeterminate()),
      }),
      Effect.catchTags({
        RpcClientError: () => Effect.fail(new EngineIndeterminate()),
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        // A newer turn started: nothing ignores the stop the operator saw.
        OrchestrationV2ForceStopThreadError: (error) =>
          error.reason === "superseded" ? Effect.void : Effect.fail(new EngineUnavailable()),
      }),
      Effect.asVoid,
    );
  });

  /**
   * Releases a held queue, keyed by the hold it answers. The engine refuses a
   * resume while the session waits on a usage limit, whose continuation runs
   * first; that counts as done, since the hold is reported again when a turn
   * starts while it lasts. **Read** at `bc0f04d`, `Orchestrator.ts`,
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

  /**
   * Archives the session's thread, settled by its key's receipt. A refusal is
   * done when the thread is archived by now, as by an earlier archive whose
   * reply was lost; `SessionNotFound` when it is gone; and `RetireRejected`
   * otherwise: the engine refuses an archive while delegated tasks run there,
   * which the Stop before it only queued to end.
   */
  const archive = Effect.fnUntraced(function* (key: IdempotencyKey, sessionId: SessionId) {
    const sent = yield* sendByReceipt({
      type: "thread.archive",
      commandId: commandId("archive", key),
      threadId: ThreadId.make(sessionId),
    });
    if (sent === "applied") return;
    if (isRetired(yield* projection(sessionId))) return;
    return yield* new RetireRejected({ sessionId });
  });

  const retireSession = Effect.fn("Engine.retireSession")(function* (sessionId: SessionId) {
    // Fresh keys on every call: the engine keeps a refusal for its key, and a
    // refused Stop or archive may pass later.
    const key = IdempotencyKey.make(`retire:${sessionId}:${yield* uniqueKey}`);
    const retire = stop({ key, sessionId }).pipe(
      Effect.catchTag("StopRejected", () => Effect.fail(new RetireRejected({ sessionId }))),
      Effect.andThen(afterSending(archive(key, sessionId))),
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
    const sentTo = yield* Ref.get(starts);
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
    if (sent === "mode-refused") {
      // Refused for the mode its turn would run in: its session's. A session
      // that cannot be read now leaves the refusal unnamed, for the recovery.
      const { thread } = yield* projection(input.sessionId).pipe(
        Effect.mapError(() => new EngineIndeterminate()),
      );
      if (thread === undefined) return yield* new EngineIndeterminate();
      return yield* permissionModeRefused(PERMISSION_MODES[thread.runtimeMode], sentTo);
    }
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
   * Sends an answer to an approval or a question, settled by its key's receipt
   * as a dispatch is (`sendByReceipt`). The engine replays a command id it
   * already applied (**Read**, `bc0f04d`, `Orchestrator.ts`), so a retry with
   * the same key succeeds even after the answer closed the request. A refusal
   * is final for the key, since the engine keeps its rejected receipt:
   * `RequestClosed` when the request is no longer pending, `AnswerRejected`
   * when it still is.
   */
  const sendAnswer = Effect.fnUntraced(function* (
    key: IdempotencyKey,
    sessionId: SessionId,
    requestId: RequestId,
    input: OrchestrationV2Command,
  ) {
    if ((yield* sendByReceipt(input)) === "applied") return;
    const now = findRequest(yield* afterSending(projection(sessionId)), requestId);
    return yield* Option.isSome(now) && now.value.closed === undefined
      ? new AnswerRejected({ key, requestId })
      : new RequestClosed({ requestId });
  });

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
        return yield* sendAnswer(input.key, input.sessionId, input.requestId, {
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
        return yield* sendAnswer(input.key, input.sessionId, input.requestId, {
          type: "runtime-request.respond",
          commandId: commandIdOf,
          threadId,
          requestId: RuntimeRequestId.make(answerTo.requestId),
          answers,
        });
      }
    }
  });

  /**
   * One secret submission per request at a time, so a second submission sees
   * the request closed. The engine also takes one answer at a time, across
   * every request, and a later answer to the same request finds it answered
   * (**Read** at `bc0f04d`, `SecretRequests.answer`, `answerLock`).
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
        if (found.answerTo._tag !== "secret" || found.closed !== undefined) {
          return yield* new RequestClosed({ requestId: input.requestId });
        }
        const answer = secretAnswerFor(found.answerTo.fieldNames, input.answer);
        if (answer === undefined) {
          return yield* new SecretAnswerMismatch({ requestId: input.requestId });
        }
        yield* rpc["secrets.answerRequest"]({
          threadId: ThreadId.make(input.sessionId),
          turnItemId: TurnItemId.make(found.answerTo.turnItemId),
          answer,
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
          const replaced = replacement(
            mirror,
            history,
            now,
            batches.toldHandoffs(input.sessionId),
            yield* providerReads,
          );
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
              yield* emit(
                diff(
                  mirror,
                  view,
                  DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
                  yield* providerReads,
                ),
              );
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
          if (outcome === "missing" || isOver(mirror)) {
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

        /** The engine has no record of the session's thread, or deleted or archived it. */
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
              if (isOver(mirror)) return yield* gone;
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
                  diff(
                    mirror,
                    view,
                    DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
                    yield* providerReads,
                  ),
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
              if (isOver(mirror)) return yield* gone;
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

  /**
   * The providers whose instance the engine replaced recently, for
   * `setHarnessExecutable`: each reads as within its first check, as after
   * the engine became ready, until `FIRST_CHECK_BUDGET` has passed since.
   */
  const replaced = yield* SubscriptionRef.make<ReadonlySet<ProviderId>>(new Set());
  const lifetime = yield* Effect.scope;
  const markReplaced = Effect.fn("Engine.markReplaced")(function* (providerId: ProviderId) {
    yield* SubscriptionRef.update(replaced, (current) => new Set([...current, providerId]));
    yield* Effect.sleep(FIRST_CHECK_BUDGET).pipe(
      Effect.andThen(
        SubscriptionRef.update(
          replaced,
          (current) => new Set([...current].filter((each) => each !== providerId)),
        ),
      ),
      Effect.forkIn(lifetime),
    );
  });

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
  // Why a ready engine cannot run a provider goes to J3 Bots' log, in the
  // engine's words, once each time it changes and again after each start:
  // the server's log is where the operator reads what the clients word as
  // "found, but it failed to start", and the engine's console is not kept.
  const logged = yield* Ref.make<ReadonlyMap<ProviderId, string>>(new Map());
  /** The updates asked of the engine since it last became ready (`UpdateRequest`). */
  const updates = yield* SubscriptionRef.make<ReadonlyMap<ProviderId, UpdateRequest>>(new Map());
  const setUpdate = (providerId: ProviderId, request: UpdateRequest | undefined) =>
    SubscriptionRef.update(updates, (current) => {
      const next = new Map(current);
      if (request === undefined) next.delete(providerId);
      else next.set(providerId, request);
      return next;
    });
  const logProblems = Effect.fn("Engine.logProviderProblems")(function* (
    providers: ReadonlyArray<ReportedProvider>,
  ) {
    const now = providerProblems(options.providers, providers);
    const before = yield* Ref.getAndSet(logged, now);
    for (const [id, line] of now) {
      if (before.get(id) !== line) {
        yield* Effect.logWarning(`The engine cannot run a provider: ${line}`);
      }
    }
  });
  yield* stateChanges(state).pipe(
    // An engine that is not ready reports nothing: a report from before it
    // left is not kept for when it is back.
    Stream.switchMap((current) =>
      current._tag === "ready"
        ? Stream.unwrap(
            Effect.map(secrets, (known) =>
              reports.pipe(
                Stream.map((providers) => withoutSecrets(providers, known)),
                Stream.tap(logProblems),
              ),
            ),
          )
        : Stream.fromEffect(
            Effect.as(
              Effect.andThen(Ref.set(logged, new Map()), SubscriptionRef.set(updates, new Map())),
              [] as ReadonlyArray<ReportedProvider>,
            ),
          ),
    ),
    Stream.runForEach((providers) => SubscriptionRef.set(reported, providers)),
    Effect.forkScoped,
  );

  /** When each provider whose check timed out is checked again next (`recheckWhileTimedOut`). */
  const rechecks = yield* SubscriptionRef.make<ReadonlyMap<ProviderId, DateTime.Utc>>(new Map());
  const engineStatus = Stream.zipLatestAll(
    withFirstCheckBudget(stateChanges(state)),
    SubscriptionRef.changes(reported),
    SubscriptionRef.changes(updates),
    SubscriptionRef.changes(replaced),
    SubscriptionRef.changes(rechecks),
  ).pipe(
    Stream.map(
      ([
        { state: current, firstCheck },
        engineProviders,
        requests,
        rebuilt,
        nextChecks,
      ]): EngineStatus => {
        switch (current._tag) {
          case "ready":
            return {
              state: { _tag: "ready" },
              pinnedVersion: pin.version,
              providers: providerStatuses(
                options.providers,
                engineProviders,
                (providerId) => firstCheck || rebuilt.has(providerId),
                requests,
                nextChecks,
              ),
            };
          case "starting":
            return {
              state:
                current.install === undefined
                  ? { _tag: "starting" }
                  : { _tag: "starting", install: current.install },
              pinnedVersion: pin.version,
              providers: [],
            };
          case "incompatible":
            return {
              state: { _tag: "incompatible", runningVersion: current.runningVersion },
              pinnedVersion: pin.version,
              providers: [],
            };
          case "unavailable":
            return {
              state:
                current.installFailure === undefined
                  ? { _tag: "unavailable", reason: current.reason }
                  : {
                      _tag: "unavailable",
                      reason: current.reason,
                      installFailure: current.installFailure,
                    },
              pinnedVersion: pin.version,
              providers: [],
            };
        }
      },
    ),
  );
  const status = Stream.zipLatestWith(
    engineStatus,
    SubscriptionRef.changes(browserHost),
    (current, browser): EngineStatus =>
      current.state._tag === "ready" && Option.isSome(browser)
        ? { ...current, browser: browser.value }
        : current,
  ).pipe(Stream.changesWith(sameStatus));

  /**
   * The engine's own refresh of one instance, bypassing what it cached, as
   * its web interface's Refresh does (**Read** at `bc0f04d`,
   * `server.refreshProviders` in `contracts/src/rpc.ts`). Its answer is not
   * read: what the check finds arrives on the config stream like any other.
   */
  const recheckProvider = Effect.fn("Engine.recheckProvider")(function* (providerId: ProviderId) {
    yield* ready;
    yield* rpc["server.refreshProviders"]({
      instanceId: ProviderInstanceId.make(instanceIdFor(providerId)),
      fresh: true,
    }).pipe(
      Effect.timeoutOrElse({
        duration: RECHECK_TIMEOUT,
        orElse: () => Effect.fail(new EngineUnavailable()),
      }),
      Effect.catchTags({
        RpcClientError: () => Effect.fail(new EngineUnavailable()),
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        ProviderSetupError: (error) =>
          Effect.logWarning("The engine refused to check a provider again", error).pipe(
            Effect.annotateLogs({ providerId }),
          ),
      }),
    );
  });

  // A provider whose check timed out, as one run while the machine was busy
  // starting, is checked again on its own, without restarting the engine
  // (`RECHECK_DELAYS`), until a check does not time out or the engine stops
  // being ready, which starts a first check of its own when it is back.
  yield* Effect.forEach(
    options.providers,
    (provider) =>
      recheckWhileTimedOut(
        Stream.zipLatestAll(
          withFirstCheckBudget(stateChanges(state)),
          SubscriptionRef.changes(reported),
          SubscriptionRef.changes(replaced),
        ).pipe(
          Stream.map(
            ([{ state: current, firstCheck }, engineProviders, rebuilt]) =>
              current._tag === "ready" &&
              checkTimedOut(
                provider,
                engineProviders.find(
                  (candidate) => candidate.instanceId === instanceIdFor(provider.id),
                ),
                firstCheck || rebuilt.has(provider.id),
              ),
          ),
        ),
        recheckProvider(provider.id),
        (at) =>
          SubscriptionRef.update(rechecks, (current) => {
            const next = new Map(current);
            if (at === null) next.delete(provider.id);
            else next.set(provider.id, at);
            return next;
          }),
      ),
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.forkScoped);

  /** Where an update runs once asked for: the engine's, so it ends with it. */
  const engineScope = yield* Effect.scope;

  /**
   * The engine's own update of a harness (**Read** at `bc0f04d`,
   * `server.updateProvider`, `ProviderMaintenanceRunner.updateProvider`): it
   * waits for the sessions of that harness that are opening, keeps new ones
   * waiting, runs the maker's update command (`claude update`, `codex
   * update`, or npm for a harness npm installed) and checks the harness
   * again, reporting each step as the instance's `updateState`. It answers
   * only once all that ends, which can take minutes, so it runs on its own
   * and this answers once it is asked. The request has no deadline of its
   * own, and neither has the engine's update: an installer stopped mid-install
   * leaves the harness half replaced, so the engine runs the update in its own
   * scope, with no timeout, and only its shutdown stops it; a dropped request
   * does not (**Read** at `bc0f04d`, `providerMaintenanceRunner.ts`, the
   * update forked into the service's scope and its `Effect.onInterrupt`). The
   * request ends with the connection. A refusal to start, and a request lost
   * on the way, for which the engine reports no state, are kept as the
   * adapter's (`UpdateRequest`).
   */
  const updateProvider = Effect.fn("Engine.updateProvider")(function* (providerId: ProviderId) {
    yield* ready;
    const provider = options.providers.find((candidate) => candidate.id === providerId);
    // Only Claude Code and Codex have versions (`versionOf`); the server asks for nothing else.
    if (provider === undefined || provider.harness === "acp-command") return;
    const askedAt = yield* Clock.currentTimeMillis;
    yield* setUpdate(providerId, { _tag: "asked", askedAt });
    yield* rpc["server.updateProvider"]({
      provider: ProviderDriverKind.make(driverOf(provider.harness)),
      instanceId: ProviderInstanceId.make(instanceIdFor(providerId)),
    }).pipe(
      Effect.andThen(setUpdate(providerId, undefined)),
      Effect.catchTags({
        ServerProviderUpdateError: (error) =>
          Effect.flatMap(secrets, (known) => {
            const detail = redact(error.reason, known);
            return Effect.logWarning("The engine refused to update a provider", detail).pipe(
              Effect.andThen(setUpdate(providerId, { _tag: "refused", askedAt, detail })),
            );
          }),
        RpcClientError: () =>
          Effect.logWarning("An update's request to the engine, or its answer, was lost").pipe(
            Effect.andThen(setUpdate(providerId, { _tag: "refused", askedAt, detail: null })),
          ),
        EnvironmentAuthorizationError: () =>
          Effect.logWarning("The engine refused J3 Bots' credential for an update").pipe(
            Effect.andThen(setUpdate(providerId, { _tag: "refused", askedAt, detail: null })),
          ),
      }),
      Effect.annotateLogs({ providerId }),
      Effect.forkIn(engineScope),
    );
  });

  /**
   * One instance, as provisioning writes it, upserted through the engine's
   * own settings. The engine saves them and answers; a watcher of its own
   * then closes the instance that changed, ending what ran on it, and builds
   * it again from the new entry (**Read** at `bc0f04d`,
   * `ProviderInstanceRegistryHydration.ts`, `layerSettingsWatcher`, and
   * `ProviderInstanceRegistry.ts`, `makeReconcile`, which closes the old
   * instance's scope before it builds the new one). A change of the
   * executable is one; a change of only the display name or accent colour
   * keeps the instance (`runtimeEqual`). So the answer does not
   * say the engine runs the new executable yet: a check of the rebuilt
   * instance that reports `version` does, and the adapter waits for it, up
   * to the first check's budget. The entry's secret variables are marked
   * redacted, which keeps the values the engine stores (**Read**,
   * `settingsSecrets.ts`, `mapSettingsSecrets`).
   */
  const upsertExecutable = Effect.fn("Engine.upsertExecutable")(function* (input: {
    readonly providerId: ProviderId;
    readonly executable: string | undefined;
  }) {
    const current = yield* Ref.get(providers);
    const provider = current.find((each) => each.id === input.providerId);
    if (provider === undefined || provider.harness === "acp-command") return null;
    const settled = !(yield* Ref.get(unsettled)).has(input.providerId);
    if (provider.executable === input.executable && settled) return null;
    // Starting, the engine may have been given the executable before; down,
    // its next start is. Either way it cannot say now which one it runs.
    if ((yield* SubscriptionRef.get(state))._tag !== "ready") {
      return yield* new EngineUnavailable();
    }
    const next = { ...provider, executable: input.executable };
    const spec = instanceSpecOf(options.toolBridge)(next);
    const entry = instanceEntry(path, yield* provisionInput, spec, yield* Ref.get(provisioned));
    yield* Ref.update(unsettled, (now) => new Set([...now, input.providerId]));
    yield* rpc["server.updateSettings"]({
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId: spec.instanceId,
        instance: entry,
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: COMMAND_TIMEOUT,
        orElse: () => Effect.fail(new EngineIndeterminate()),
      }),
      Effect.catchTags({
        RpcClientError: () => Effect.fail(new EngineIndeterminate()),
        EnvironmentAuthorizationError: () => Effect.fail(new EngineUnavailable()),
        ServerSettingsError: () => Effect.fail(new EngineIndeterminate()),
      }),
    );
    yield* markReplaced(input.providerId);
    return { next, instanceId: spec.instanceId };
  }, provisioning.withPermits(1));

  const setHarnessExecutable = Effect.fn("Engine.setHarnessExecutable")(function* (input: {
    readonly providerId: ProviderId;
    readonly executable: string | null;
    readonly version: string | null;
  }) {
    const sentAt = yield* Clock.currentTimeMillis;
    const sent = yield* upsertExecutable({
      providerId: input.providerId,
      executable: input.executable ?? undefined,
    });
    if (sent === null) return;
    const { version } = input;
    // A report the engine made of the rebuilt instance, not one from before.
    const runsIt = (each: ReportedProvider) => {
      if (each.instanceId !== sent.instanceId || Date.parse(each.checkedAt) < sentAt) return false;
      // Back on its `PATH`: any check that ended, the harness found there or not.
      if (version === null) return each.installed || each.status === "error";
      const compatibility = each.compatibilityAdvisory?.status;
      return (
        each.installed &&
        each.status !== "error" &&
        each.availability !== "unavailable" &&
        compatibility !== "broken" &&
        compatibility !== "unsupported" &&
        (versionNumberIn(each.installedVersion) === version ||
          versionNumberIn(each.version) === version)
      );
    };
    yield* SubscriptionRef.changes(reported).pipe(
      Stream.filter((engineProviders) => engineProviders.some(runsIt)),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: FIRST_CHECK_BUDGET,
        orElse: () => Effect.fail(new EngineIndeterminate()),
      }),
    );
    yield* Ref.update(providers, (current) =>
      current.map((each) => (each.id === sent.next.id ? sent.next : each)),
    );
    yield* Ref.update(
      unsettled,
      (now) => new Set([...now].filter((each) => each !== input.providerId)),
    );
  });

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

  /**
   * The session's suggested reply, as the engine keeps it. The subscription
   * ends when the connection drops or the engine restarts; it is made again
   * once the engine is ready, and the engine then answers with what it has.
   */
  const suggestedReplies = (sessionId: SessionId): Stream.Stream<SessionSuggestedReply | null> => {
    const once = rpc["orchestration.subscribePromptSuggestion"]({
      threadId: ThreadId.make(sessionId),
    }).pipe(
      Stream.map((suggestion): SessionSuggestedReply | null =>
        suggestion === null
          ? null
          : { turnId: TurnId.make(suggestion.runId), text: suggestion.text },
      ),
      Stream.catch(() => Stream.empty),
    );
    const untilReady = stateChanges(state).pipe(
      Stream.filter((current) => current._tag === "ready"),
      Stream.take(1),
      Stream.runDrain,
    );
    return Stream.forever(
      Stream.fromEffectDrain(untilReady).pipe(
        Stream.concat(once),
        Stream.concat(Stream.fromEffectDrain(Effect.sleep(Duration.millis(500)))),
      ),
    ).pipe(
      Stream.changesWith(
        (before, after) =>
          before === after ||
          (before !== null &&
            after !== null &&
            before.turnId === after.turnId &&
            before.text === after.text),
      ),
    );
  };

  const engine = Engine.of({
    status,
    starts: stateChanges(state).pipe(
      Stream.map((current) => (current._tag === "ready" ? current.start : null)),
      Stream.changes,
    ),
    instance,
    connectProviders,
    connectedEndpoint: connectedNow,
    recheckProvider,
    updateProvider,
    setHarnessExecutable,
    consoleLink,
    linkSharedSkills: linkSharedSkillsNow,
    linkBotSkills,
    ensureProject,
    removeProject,
    setBrowserAccess,
    withdrawBrowserAccess,
    clearBrowserProfile,
    openSession,
    configureSession,
    retireSession,
    dispatch,
    redispatch,
    stageAttachment,
    stop,
    forceStop,
    resumeQueue,
    respond,
    respondSecret,
    events,
    synchronize,
    suggestedReplies,
  });
  return Context.make(Engine, engine).pipe(Context.add(BrowserBridge, browser));
});

/**
 * The engine, installed, provisioned, supervised and connected for as long as
 * the layer lives, and its browser. Closing it stops the engine.
 */
export const layer = (options: EngineOptions) => Layer.effectContext(make(options));
