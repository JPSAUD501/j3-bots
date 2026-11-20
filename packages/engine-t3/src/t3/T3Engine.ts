// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ModelChoice, PermissionMode } from "@j3-bots/contracts";
import {
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { isInlineImage } from "../attachments.ts";
import {
  Engine,
  type DispatchLookup,
  type EngineOptions,
  type ProviderInstance,
  type RequestResponse,
  type SecretAnswer,
} from "../Engine.ts";
import {
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
  type TurnId,
} from "../ids.ts";
import { makeEngineRpc } from "./Connection.ts";
import { ensureCredential, renewalDue } from "./Credential.ts";
import { ensureInstalled } from "./Install.ts";
import { commandIdFor, messageIdFor, projectIdFor, threadIdFor } from "./Keys.ts";
import { ORCHESTRATION_PROTOCOL, pin } from "./Pin.ts";
import { instanceIdFor, provision, type InstanceSpec } from "./Provision.ts";
import { baseUrl, supervise } from "./Supervisor.ts";
import {
  activeTurn,
  applyEvent,
  copyView,
  diff,
  dispositionOf,
  emptyMirror,
  findRequest,
  holdsDispatch,
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
/** Views kept per session, for resuming an `events` stream without a replacement. */
const VIEWS_KEPT = 32;
/** How long a staged file stays usable: half the engine's 24-hour sweep. */
const STAGED_LIFETIME = Duration.hours(12);

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

const PairingResult = Schema.Struct({ pairUrl: Schema.String });
const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingResult));

/** `<sequence>.<index>.<count>@<epoch ms>`: an engine sequence, an event within it, and when. */
const CURSOR = /^(\d+)\.(\d+)\.(\d+)@(\d+)$/;

const cursorFor = (sequence: number, index: number, count: number, at: number) =>
  EventCursor.make(`${sequence}.${index}.${count}@${at}`);

const parseCursor = (cursor: EventCursor) => {
  const match = CURSOR.exec(cursor);
  if (match === null) return Option.none();
  const [, sequence, index, count, at] = match.map(Number);
  return sequence === undefined || index === undefined || count === undefined || at === undefined
    ? Option.none()
    : Option.some({ sequence, complete: index === count - 1, at });
};

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
  | { readonly _tag: "lost" }
  | { readonly _tag: "missing" }
  | { readonly _tag: "sync"; readonly token: SyncToken };

export const make = Effect.fn("engine.make")(function* (options: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;

  yield* fs.makeDirectory(options.home, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const executable = Option.isSome(options.binaryOverride)
    ? options.binaryOverride.value
    : yield* ensureInstalled({
        home: options.home,
        platform: process.platform,
        arch: process.arch,
      }).pipe(Effect.orDie);

  const providerIds = new Set(options.providers.map((provider) => provider.id));
  const provisionEngine = provision({
    home: options.home,
    instances: options.providers.map(instanceSpecOf),
    toolBridge: options.toolBridge,
    systemPromptFile: options.systemPromptFile,
  }).pipe(
    Effect.orDie,
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  yield* provisionEngine;

  const credential = yield* Ref.make(
    yield* ensureCredential({ executable, home: options.home }).pipe(Effect.orDie),
  );
  const renewCredential = ensureCredential({ executable, home: options.home }).pipe(
    Effect.flatMap((fresh) => Ref.set(credential, fresh)),
    Effect.catch((error) => Effect.logWarning("Renewing the engine token failed", error)),
  );
  // Renew ahead of expiry, for as long as the engine lives.
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const due = renewalDue(yield* Ref.get(credential));
        const now = yield* DateTime.now;
        yield* Effect.sleep(
          Duration.millis(
            Math.max(60_000, DateTime.toEpochMillis(due) - DateTime.toEpochMillis(now)),
          ),
        );
        yield* renewCredential;
      }),
    ),
  );

  const supervisor = yield* supervise({
    executable,
    home: options.home,
    port: options.port,
    beforeStart: provisionEngine,
  });
  const rpc = yield* makeEngineRpc({
    port: options.port,
    token: Ref.get(credential).pipe(Effect.map((current) => current.token)),
  });

  // ---------------------------------------------------------------------------
  // Sending

  /** Fails without sending when the engine cannot take commands. */
  const ready = Effect.gen(function* () {
    const state = yield* supervisor.current;
    if (state._tag === "incompatible") {
      return yield* new EngineIncompatible({
        runningVersion: state.runningVersion,
        pinnedVersion: pin.version,
      });
    }
    if (state._tag !== "ready") return yield* new EngineUnavailable();
  });

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
      Effect.map(mirrorOf),
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
    const token = (yield* Ref.get(credential)).token;
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
          projection(sessionId).pipe(Effect.andThen(refused(error))),
      }),
      Effect.asVoid,
    );

  const configureSession = Effect.fn("Engine.configureSession")(function* (input: {
    readonly sessionId: SessionId;
    readonly model?: ModelChoice;
    readonly permissionMode?: PermissionMode;
  }) {
    yield* projection(input.sessionId);
    const threadId = ThreadId.make(input.sessionId);
    if (input.model !== undefined) {
      yield* sendSessionCommand(input.sessionId, {
        type: "thread.model-selection.set",
        commandId: commandId("model", `${input.sessionId}:${yield* uniqueKey}`),
        threadId,
        modelSelection: yield* modelSelection(input.model),
      });
    }
    if (input.permissionMode !== undefined) {
      yield* sendSessionCommand(input.sessionId, {
        type: "thread.runtime-mode.set",
        commandId: commandId("mode", `${input.sessionId}:${yield* uniqueKey}`),
        threadId,
        runtimeMode: RUNTIME_MODES[input.permissionMode],
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Stop

  /** Sessions a Stop is working on: their held queues must not be resumed meanwhile. */
  const stopping = new Set<string>();

  const stop = Effect.fn("Engine.stop")(function* (input: {
    readonly key: IdempotencyKey;
    readonly sessionId: SessionId;
  }) {
    const before = yield* projection(input.sessionId);
    if (Option.isNone(activeTurn(before))) return;
    const threadId = ThreadId.make(input.sessionId);
    stopping.add(input.sessionId);
    yield* Effect.gen(function* () {
      yield* sendSessionCommand(input.sessionId, {
        type: "thread.stop",
        commandId: commandId("stop", input.key),
        threadId,
        stopDelegatedTasks: true,
      });
      // The engine's stop only holds the queue; J3 Bots' Stop ends what it dispatched.
      const held = yield* projection(input.sessionId);
      for (const run of queuedRuns(held)) {
        yield* sendSessionCommand(input.sessionId, {
          type: "queued-run.cancel",
          commandId: commandId(`cancel-${run.id}`, input.key),
          threadId,
          runId: RunId.make(run.id),
        });
      }
    }).pipe(Effect.ensuring(Effect.sync(() => stopping.delete(input.sessionId))));
  });

  const retireSession = Effect.fn("Engine.retireSession")(function* (sessionId: SessionId) {
    const retire = stop({ key: IdempotencyKey.make(`retire:${sessionId}`), sessionId }).pipe(
      Effect.andThen(
        sendSessionCommand(sessionId, {
          type: "thread.archive",
          commandId: commandId("archive", sessionId),
          threadId: ThreadId.make(sessionId),
        }),
      ),
    );
    // Already gone counts as retired.
    yield* retire.pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
  });

  // ---------------------------------------------------------------------------
  // Dispatch

  const dispatch = Effect.fn("Engine.dispatch")(function* (input: {
    readonly key: IdempotencyKey;
    readonly sessionId: SessionId;
    readonly text: string;
    readonly attachments: ReadonlyArray<{
      readonly stagedId: EngineAttachmentId;
      readonly name: string;
      readonly mediaType: string;
      readonly size: number;
    }>;
    readonly delivery:
      | { readonly _tag: "start"; readonly freshContext: boolean }
      | { readonly _tag: "steer"; readonly turnId: TurnId };
  }) {
    const before = yield* projection(input.sessionId);
    // A retry of a dispatch the engine already applied returns its first answer.
    const known = dispositionOf(before, input.key);
    if (Option.isSome(known)) return known.value;
    if (input.delivery._tag === "start") {
      const busy = activeTurn(before);
      if (Option.isSome(busy)) {
        return yield* new SessionBusy({ sessionId: input.sessionId, turnId: busy.value });
      }
    }
    const kind = input.delivery._tag;
    const attachments: Array<ChatAttachment> = input.attachments.map((attachment) => ({
      type: isInlineImage(attachment.mediaType) ? "image" : "file",
      id: attachment.stagedId,
      name: attachment.name,
      mimeType: attachment.mediaType,
      sizeBytes: attachment.size,
    }));
    yield* sendSessionCommand(input.sessionId, {
      type: "message.dispatch",
      commandId: commandId("dispatch", input.key),
      threadId: ThreadId.make(input.sessionId),
      messageId: MessageId.make(messageIdFor(kind, input.key)),
      text: input.text,
      attachments,
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
    const after = yield* projection(input.sessionId).pipe(
      Effect.mapError(() => new EngineIndeterminate()),
    );
    const disposition = dispositionOf(after, input.key);
    if (Option.isNone(disposition)) {
      // Applied (the engine answered) but not visible: only a lookup can tell now.
      return yield* new EngineIndeterminate();
    }
    return disposition.value;
  });

  const lookupDispatch = Effect.fn("Engine.lookupDispatch")(function* (input: {
    readonly sessionId: SessionId;
    readonly key: IdempotencyKey;
  }) {
    const mirror = yield* projection(input.sessionId).pipe(
      Effect.asSome,
      Effect.catchTag("SessionNotFound", () => Effect.succeed(Option.none<Mirror>())),
    );
    if (Option.isNone(mirror)) return { _tag: "unknown" } satisfies DispatchLookup;
    const disposition = dispositionOf(mirror.value, input.key);
    return Option.isSome(disposition)
      ? ({ _tag: "applied", disposition: disposition.value } satisfies DispatchLookup)
      : ({ _tag: "not-applied" } satisfies DispatchLookup);
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
    const upload = yield* rpc["attachments.createUploadUrl"](
      isInlineImage(input.mediaType)
        ? {
            type: "image",
            name: input.name,
            mimeType: input.mediaType.toLowerCase() as "image/png",
            sizeBytes: input.size,
          }
        : { type: "file", name: input.name, mimeType: input.mediaType, sizeBytes: input.size },
    ).pipe(
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
    const token = (yield* Ref.get(credential)).token;
    yield* http
      .execute(
        HttpClientRequest.post(`${baseUrl(options.port)}${upload.relativeUrl}`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyUint8Array(bytes, input.mediaType),
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

  /** The open request a response is for, or `RequestClosed`. */
  const openRequest = Effect.fnUntraced(function* (sessionId: SessionId, requestId: RequestId) {
    const mirror = yield* projection(sessionId);
    const found = findRequest(mirror, requestId);
    if (Option.isNone(found) || found.value.resolution !== undefined) {
      return yield* new RequestClosed({ requestId });
    }
    return found.value;
  });

  /** A response that does not fit its request is the caller's bug, not the engine's. */
  const mismatched = (requestId: RequestId, answer: string) =>
    Effect.die(new Error(`A ${answer} cannot answer request ${requestId}`));

  const respond = Effect.fn("Engine.respond")(function* (input: {
    readonly key: IdempotencyKey;
    readonly sessionId: SessionId;
    readonly requestId: RequestId;
    readonly response: RequestResponse;
  }) {
    const state = yield* openRequest(input.sessionId, input.requestId);
    const { answerTo, request } = state;
    const response = input.response;
    const fits =
      response._tag === "approval" ? request._tag === "approval" : request._tag === "question";
    if (answerTo._tag !== "runtime-request" || !fits) {
      return yield* mismatched(input.requestId, `${response._tag} response`);
    }
    const threadId = ThreadId.make(input.sessionId);
    const requestId = RuntimeRequestId.make(answerTo.requestId);
    const commandIdOf = commandId("respond", input.key);
    switch (response._tag) {
      case "approval":
        return yield* sendSessionCommand(input.sessionId, {
          type: "runtime-request.respond",
          commandId: commandIdOf,
          threadId,
          requestId,
          decision: APPROVAL_DECISIONS[response.decision],
        });
      case "question": {
        const answers: Record<string, string | ReadonlyArray<string>> = {};
        for (const [questionId, answer] of Object.entries(response.answers)) {
          const chosen =
            answer.text === null ? answer.optionIds : [...answer.optionIds, answer.text];
          answers[questionId] = chosen.length === 1 && chosen[0] !== undefined ? chosen[0] : chosen;
        }
        return yield* sendSessionCommand(input.sessionId, {
          type: "runtime-request.respond",
          commandId: commandIdOf,
          threadId,
          requestId,
          answers,
        });
      }
      case "dismiss":
        return yield* sendSessionCommand(input.sessionId, {
          type: "thread.user-input.dismiss",
          commandId: commandIdOf,
          threadId,
          requestId,
        });
    }
  });

  const respondSecret = Effect.fn("Engine.respondSecret")(function* (input: {
    readonly sessionId: SessionId;
    readonly requestId: RequestId;
    readonly answer: SecretAnswer;
  }) {
    const state = yield* openRequest(input.sessionId, input.requestId);
    if (state.answerTo._tag !== "secret") {
      return yield* mismatched(input.requestId, "secret");
    }
    yield* rpc["secrets.answerRequest"]({
      threadId: ThreadId.make(input.sessionId),
      turnItemId: TurnItemId.make(state.answerTo.turnItemId),
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
  });

  // ---------------------------------------------------------------------------
  // Events

  /** The last views handed out per session, by the cursor of the last event of their batch. */
  const views = new Map<string, Map<string, View>>();
  const keepView = (sessionId: SessionId, cursor: EventCursor, view: View) => {
    const kept = views.get(sessionId) ?? new Map<string, View>();
    kept.set(cursor, copyView(view));
    for (const oldest of kept.keys()) {
      if (kept.size <= VIEWS_KEPT) break;
      kept.delete(oldest);
    }
    views.set(sessionId, kept);
  };

  /** Open `events` streams per session, for `synchronize`. */
  const syncTargets = new Map<string, Set<Queue.Queue<LoopInput>>>();

  const resumeHeldQueue = (sessionId: SessionId, mirror: Mirror, sequence: number) =>
    holdsDispatch(mirror) && !stopping.has(sessionId)
      ? command({
          type: "queue.resume",
          commandId: commandId("resume", `${sessionId}:${sequence}`),
          threadId: ThreadId.make(sessionId),
        }).pipe(
          Effect.catch((error) => Effect.logWarning("Resuming a held queue failed", error)),
          Effect.asVoid,
        )
      : Effect.void;

  const events = (input: { readonly sessionId: SessionId; readonly after: EventCursor | null }) =>
    Stream.callback<SessionEvent, SessionNotFound | EngineIncompatible>((output) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(input.sessionId);
        const inputs = yield* Queue.unbounded<LoopInput>();
        const targets = syncTargets.get(input.sessionId) ?? new Set();
        targets.add(inputs);
        syncTargets.set(input.sessionId, targets);
        yield* Effect.addFinalizer(() => Effect.sync(() => targets.delete(inputs)));

        let mirror = emptyMirror();
        let view: View | undefined;
        let sequence = -1;
        let lastCursor: EventCursor | null = input.after;

        const emit = Effect.fnUntraced(function* (bodies: ReadonlyArray<EventBody>) {
          if (bodies.length === 0 || view === undefined) return;
          const now = yield* Clock.currentTimeMillis;
          const at = DateTime.makeUnsafe(now);
          for (const [index, body] of bodies.entries()) {
            const cursor = cursorFor(Math.max(sequence, 0), index, bodies.length, now);
            lastCursor = cursor;
            const event: SessionEvent = { ...body, cursor, at };
            yield* Queue.offer(output, event);
          }
          if (lastCursor !== null) keepView(input.sessionId, lastCursor, view);
        });

        /** The first state of the stream: a replay from a kept view, or one `replaced`. */
        const begin = Effect.fnUntraced(function* () {
          const parsed = input.after === null ? Option.none() : parseCursor(input.after);
          const kept =
            input.after === null ? undefined : views.get(input.sessionId)?.get(input.after);
          if (kept !== undefined && Option.isSome(parsed) && parsed.value.complete) {
            view = copyView(kept);
            yield* emit(diff(mirror, view));
            return;
          }
          const since = Option.match(parsed, {
            onNone: () => null,
            onSome: (cursor) => DateTime.makeUnsafe(cursor.at),
          });
          const replaced = replacement(
            mirror,
            input.after === null ? null : (since ?? DateTime.makeUnsafe(0)),
          );
          view = replaced.view;
          yield* emit([replaced.event]);
        });

        const subscribe = (afterSequence: number | undefined, marker: boolean) =>
          rpc["orchestration.subscribeThread"]({
            threadId,
            ...(afterSequence === undefined ? {} : { afterSequence }),
            ...(marker ? { requestCompletionMarker: true } : {}),
          });

        /** Feeds the main engine subscription into the loop, resubscribing after a loss. */
        const pump = Effect.gen(function* () {
          while (true) {
            const lost = yield* subscribe(sequence < 0 ? undefined : sequence, false).pipe(
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
            yield* supervisor.changes.pipe(
              Stream.filter((state) => state._tag !== "starting" && state._tag !== "unavailable"),
              Stream.take(1),
              Stream.runDrain,
            );
          }
        });
        yield* Effect.forkScoped(pump);

        /** Applies one engine stream item. Returns whether the mirror changed. */
        const apply = (item: OrchestrationV2ThreadStreamItem) => {
          switch (item.kind) {
            case "snapshot":
              if (item.snapshotSequence < sequence) return false;
              mirror = mirrorOf(item.projection);
              sequence = item.snapshotSequence;
              return true;
            case "event":
              if (item.sequence <= sequence) return false;
              sequence = item.sequence;
              return applyEvent(mirror, item.event);
            default:
              return false;
          }
        };

        while (true) {
          const next = yield* Queue.take(inputs);
          switch (next._tag) {
            case "missing":
              return yield* Queue.fail(output, new SessionNotFound({ sessionId: input.sessionId }));
            case "lost": {
              const state = yield* supervisor.current;
              if (state._tag === "incompatible") {
                return yield* Queue.fail(
                  output,
                  new EngineIncompatible({
                    runningVersion: state.runningVersion,
                    pinnedVersion: pin.version,
                  }),
                );
              }
              break;
            }
            case "item": {
              const changed = apply(next.item);
              if (view === undefined) {
                if (next.item.kind === "snapshot") yield* begin();
              } else if (changed) {
                yield* emit(diff(mirror, view));
              }
              if (changed) yield* resumeHeldQueue(input.sessionId, mirror, sequence);
              break;
            }
            case "sync": {
              // A second subscription from where this one is, up to the engine's marker.
              yield* subscribe(sequence < 0 ? undefined : sequence, true).pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runForEach((item) =>
                  Effect.gen(function* () {
                    const changed = apply(item);
                    if (view === undefined) {
                      if (item.kind === "snapshot") yield* begin();
                    } else if (changed) {
                      yield* emit(diff(mirror, view));
                    }
                  }),
                ),
                Effect.ignore,
              );
              const now = yield* Clock.currentTimeMillis;
              yield* Queue.offer(output, {
                _tag: "synchronized",
                token: next.token,
                cursor: lastCursor ?? cursorFor(Math.max(sequence, 0), 0, 1, now),
                at: DateTime.makeUnsafe(now),
              });
              break;
            }
          }
        }
      }),
    );

  const synchronize = Effect.fn("Engine.synchronize")(function* (input: {
    readonly sessionId: SessionId;
    readonly token: SyncToken;
  }) {
    yield* projection(input.sessionId);
    for (const target of syncTargets.get(input.sessionId) ?? []) {
      yield* Queue.offer(target, { _tag: "sync", token: input.token });
    }
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

  const status = supervisor.changes.pipe(
    Stream.map((state): EngineStatus => ({
      state:
        state._tag === "ready"
          ? { _tag: "ready" }
          : state._tag === "incompatible"
            ? { _tag: "incompatible", runningVersion: state.runningVersion }
            : state._tag === "starting"
              ? { _tag: "starting" }
              : { _tag: "unavailable" },
      pinnedVersion: pin.version,
      providers: state._tag === "ready" ? providers : [],
    })),
  );

  const consoleLink = Effect.gen(function* () {
    yield* ready;
    const output = yield* spawner
      .string(
        ChildProcess.make(executable, [
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
    stageAttachment,
    lookupDispatch,
    stop,
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
