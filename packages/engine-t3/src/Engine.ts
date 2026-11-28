// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  EffortLevel,
  EngineStatus,
  ModelChoice,
  PermissionMode,
  ProviderId,
  QuestionAnswers,
  SecretRequestAnswer,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import type {
  AnswerRejected,
  BackgroundWorkRunning,
  DispatchRejected,
  EngineDown,
  EngineIncompatible,
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
} from "./errors.ts";
import type { SessionEvent } from "./events.ts";
import type {
  EngineAttachmentId,
  EngineInstanceId,
  EngineProjectId,
  EventCursor,
  IdempotencyKey,
  RequestId,
  SessionId,
  SyncToken,
  TurnId,
} from "./ids.ts";

/**
 * How a dispatched message reaches a session. J3 Bots keeps its own queue and
 * dispatches into an idle session, with one exception: an operator message may
 * steer a turn opened for the same audience.
 */
export type Delivery =
  /**
   * Start a turn. A first `dispatch` is refused with `SessionBusy`, sending
   * nothing, when the adapter already sees a turn running or waiting in the
   * session. That check is best effort: the engine queues a start that reaches
   * it behind an active turn, including one the engine started itself, and the
   * dispatch is then `queued`.
   *
   * `freshContext` starts it in a new provider conversation with none of the
   * session's earlier context, for a fresh start or a session rebuilt from
   * memory.
   */
  | { readonly _tag: "start"; readonly freshContext: boolean }
  /**
   * Add the message to the running turn `turnId`, so it can change course. If
   * that turn has completed or is completing, or its provider can take no steer
   * at all, the engine makes the message a turn of its own instead: see
   * `DispatchDisposition`. So it does with a message that reads as a slash
   * command (`/name` first, no attachments), which a provider would run in
   * place of the turn's task. It refuses (`DispatchRejected`) a steer into a
   * turn that waits behind another, or that ended any way but completing.
   * **Read** at `bc0f04d`, `CommandPolicy.ts`, `resolveMessageDispatch` and
   * `resolveMessageDispatchIntent`, and `Orchestrator.ts`, `dispatchSteerIntoRun`.
   */
  | { readonly _tag: "steer"; readonly turnId: TurnId };

/**
 * How the engine accepted a first `dispatch`. It records acceptance only:
 * delivery is the `turn-started` event whose cause is `dispatch` with the
 * dispatch's key, or, for `steered`, the `steered` event. A `redispatch` has
 * no disposition: the engine's reply to a resend is `{sequence}` whether or not
 * it applied the key just then.
 */
export type DispatchDisposition =
  /** A `start` began turn `turnId`. */
  | { readonly _tag: "started"; readonly turnId: TurnId }
  /**
   * A `start` became turn `turnId`, which waits behind a turn that began before
   * the engine applied the start. It is delivered when `turnId` starts, and
   * never if `stop` cancels it first. **Read** at `bc0f04d`.
   */
  | { readonly _tag: "queued"; readonly turnId: TurnId }
  /**
   * A `steer` was taken for turn `turnId`. How it settles is decided when that
   * turn ends, from the engine's own record of the steer, and reported then:
   * `steered`, `steer-dropped` or `steer-requeued` (see those events).
   *
   * The same holds when the engine cannot steer `turnId` at once: the turn has
   * not started its provider turn yet (the engine keeps the message aside and
   * steers it in when the turn starts, or runs it as the follow-up turn if the
   * turn ends first), or its provider steers only by interrupting the turn and
   * restarting it with the message, which keeps `turnId` (one turn, several
   * attempts). **Read** at `bc0f04d`.
   */
  | { readonly _tag: "steered"; readonly turnId: TurnId }
  /**
   * A `steer` became turn `turnId` of its own: the target turn had completed or
   * was completing, its provider can neither steer nor restart, or the message
   * reads as a slash command. It starts at once if the session is idle, or
   * after the running turn otherwise. **Read** at `bc0f04d`.
   */
  | { readonly _tag: "new-turn"; readonly turnId: TurnId };

/** What the engine is given for one dispatch. */
export interface DispatchInput {
  readonly key: IdempotencyKey;
  readonly sessionId: SessionId;
  /**
   * Exactly what the model receives, as if the user typed it: the wake
   * envelope is the caller's, stored before the first send. Checked first
   * with `engineInputLength` against `ENGINE_INPUT_LIMIT`.
   */
  readonly text: string;
  /**
   * Checked first with `attachmentLimitViolation`. The staged ids are the one
   * part of the input that may change between sends of a key: a file whose
   * `usableUntil` has passed is staged again before any send, first or not,
   * because the engine claims the files before it looks at the key.
   */
  readonly attachments: ReadonlyArray<DispatchAttachment>;
  readonly delivery: Delivery;
}

/** A file the message carries, staged first with `Engine.stageAttachment`. */
export interface DispatchAttachment {
  readonly stagedId: EngineAttachmentId;
  readonly name: string;
  readonly mediaType: string;
  /** Bytes. */
  readonly size: number;
}

/** A file staged in the engine, ready to name in a dispatch. */
export interface StagedAttachment {
  readonly id: EngineAttachmentId;
  /**
   * Until when a dispatch can name it, first send or resend. The engine
   * removes an upload no message names after 24 hours, and a claimed one stays
   * as the source of copies until then (**Read** at `bc0f04d`,
   * `apps/server/src/attachmentStore.ts`); the adapter reports half of that.
   * Past it, stage the file again before the next send, first send or
   * recovery alike.
   */
  readonly usableUntil: DateTime.Utc;
}

/**
 * An answer to an approval or a question. A question is never dismissed: the
 * engine takes a dismissal only of a question that does not hold its turn,
 * and refuses it for every question a harness asks while its turn waits
 * (**Verified** on `0.1.11` with the scripted agent, and the code it rests on
 * is unchanged at `bc0f04d`: "This question needs an answer. Answer it or
 * stop the turn."; **Read** at `bc0f04d`,
 * `Orchestrator.ts`, `dispatchThreadUserInputDismiss`, which takes it only for
 * a request whose `responseCapability` is `message`, and the Claude Code,
 * Codex and ACP adapters, which give every question they wait on `live`).
 * Such a question is answered, or its turn is stopped.
 */
export type RequestResponse =
  | { readonly _tag: "approval"; readonly decision: ApprovalDecision }
  | { readonly _tag: "question"; readonly answers: QuestionAnswers };

/**
 * The operator's answer to a secret request: the one value of a request for
 * one (or for one field), a value for each field of a request with fields,
 * keyed by the ids its `secret` request gave them, or a decline.
 */
export type SecretAnswer = SecretRequestAnswer;

/** A harness J3 Bots can keep a copy of, and sign in to an account of. */
export type CopiedHarness = "claude-code" | "codex";

/** One harness the engine runs bots on. */
export type ProviderInstance = {
  /** J3 Bots' id for it, which `ModelChoice.providerId` names. */
  readonly id: ProviderId;
  /** As the operator sees it, such as "Claude (work account)". */
  readonly name: string;
  /** Extra environment for the harness, such as an API endpoint and its key. Stored as secrets. */
  readonly environment: ReadonlyArray<{
    readonly name: string;
    readonly value: Redacted.Redacted<string>;
  }>;
  /** Off, the engine keeps it and runs nothing on it: it reports it `disabled`. */
  readonly enabled: boolean;
} & (
  | {
      readonly harness: CopiedHarness;
      /**
       * The harness's own configuration folder, owned by J3 Bots, so bots do
       * not inherit the operator's personal setup. The adapter writes the `j3`
       * tool server and J3 Bots' launch settings into it, merging with what the
       * harness keeps there. The harness reaches its models through the
       * provider connection once one is set (`Engine.connectProviders`), and
       * otherwise through whatever sign-in this folder holds.
       */
      readonly home: string;
      /**
       * The harness's executable the operator chose for this provider, by its
       * path, which it runs in place of J3 Bots' own copy of the harness
       * (`EngineOptions.harnessExecutables`) and of the one on the engine's
       * `PATH`; undefined for those.
       */
      readonly binaryPath: string | undefined;
      /** What the harness starts with after J3 Bots' own arguments; empty for none. */
      readonly launchArguments: string;
    }
  | {
      /**
       * Any agent that speaks the Agent Client Protocol, started as a local
       * command: the scripted agent the conformance suite runs, which needs no
       * model and spends no allowance. It gets no J3 Bots prompt, and the `j3`
       * tools only as the bridge's command line in its environment
       * (`J3_TOOL_BRIDGE`), which it may start itself; the engine passes it
       * the message as it does every harness.
       */
      readonly harness: "acp-command";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }
);

/**
 * How the Claude Code and Codex instances reach their models: an endpoint that
 * speaks both Anthropic's Messages API and OpenAI's Responses API, such as a
 * proxy in front of the operator's subscriptions, and the key it takes.
 */
export interface ProviderConnection {
  /** The endpoint's base URL, without `/v1`. */
  readonly baseUrl: string;
  readonly key: Redacted.Redacted<string>;
}

/** What became of the connection `connectProviders` was given. */
export type ConnectionOutcome =
  /** Stored, and the engine restarted with it: every harness runs on it from now on. */
  | { readonly _tag: "applied"; readonly baseUrl: string }
  /**
   * Stored, and the engine is not back yet: still installing, or not ready
   * within the wait. It starts with this connection whenever it starts.
   */
  | { readonly _tag: "stored"; readonly baseUrl: string }
  /** Not stored: the one before it, if any, stays in force. */
  | { readonly _tag: "refused"; readonly active: string | null };

/**
 * What the adapter's layer is built from: everything the server knows. The
 * layer owns the engine for its whole lifetime. It installs the pinned release
 * (checked against its published checksums) unless `binaryOverride` is set,
 * provisions the engine's settings and the provider instances, starts the
 * engine on loopback with its own data directory, restarts it when it exits,
 * mints its credentials and keeps one connection open, reconnecting on its own.
 */
/** The `j3` MCP server every harness session starts: the server's stdio bridge. */
export interface ToolBridge {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Variables the bridge is started with, such as the key it signs its
   * requests with, which are never logged or reported. Claude Code and Codex
   * get each in the bridge's entry of their configuration, not in their own
   * environment, so the commands a bot runs do not inherit it. An ACP agent,
   * which starts the bridge itself, gets them in its environment.
   */
  readonly environment: ReadonlyArray<{
    readonly name: string;
    readonly value: Redacted.Redacted<string>;
  }>;
  /**
   * The bare names of the bridge's tools that run without asking, in every
   * permission mode: J3 Bots' own. Every other tool it lists, a connector's,
   * follows the session's permission mode, as the harness's own tools do.
   */
  readonly preApproved: ReadonlyArray<string>;
  /**
   * How long a harness waits for one call to the bridge before it gives up
   * on it, in seconds. Above the longest the bridge itself waits for a call,
   * so the bridge's own answer, not the harness's timeout, ends a slow call.
   */
  readonly callTimeoutSeconds: number;
}

export interface EngineOptions {
  /** The engine's data directory, `<J3_HOME>/engine`. Created if missing. */
  readonly home: string;
  /** Loopback port the engine listens on. */
  readonly port: number;
  /** An engine executable to run instead of the pinned release, for development. */
  readonly binaryOverride: Option.Option<string>;
  /** The harness instances to create; `Engine.setProviders` changes them while it runs. */
  readonly providers: ReadonlyArray<ProviderInstance>;
  /**
   * The copy of each harness J3 Bots installed, by its absolute path, which
   * every provider of that harness runs unless it names a `binaryPath`; a
   * harness without one runs what the engine finds on its `PATH`.
   * `Engine.setHarnessExecutable` changes it while the engine runs.
   */
  readonly harnessExecutables: Readonly<Partial<Record<CopiedHarness, string>>>;
  /**
   * The process each harness starts as the `j3` MCP server in every session, for
   * the bot tools: the server's stdio bridge.
   */
  readonly toolBridge: ToolBridge;
  /**
   * The bot's system prompt file, relative to its workspace folder: `.j3/system.md`.
   * A session reads it when its provider process starts, so a change reaches the
   * bot when the session next starts its provider.
   */
  readonly systemPromptFile: string;
  /**
   * The base prompt every bot shares, rendered: the current text, then every
   * change. Codex takes it as its instances' `developer_instructions`, since one
   * Codex process serves every bot of an instance; Claude Code reads it from
   * each bot's `systemPromptFile`, which the caller writes.
   */
  readonly basePrompt: Stream.Stream<string>;
  /**
   * Whether the harnesses guess the operator's next message after each turn
   * (`suggestedReplies`): the current value, then every change. Each guess is
   * one more request on the operator's plan, for every turn a session
   * completes, whoever woke it. The engine reads it as its
   * `promptSuggestionsEnabled`, which every provisioning writes and a change
   * while the engine runs updates. Codex follows a change at its next turn;
   * Claude Code when a session next starts its harness process (**Read** at
   * `bc0f04d`, `ProviderSessionManager.ts`, `promptSuggestionsEnabled`, read
   * per Codex turn and per Claude Code query).
   */
  readonly suggestReplies: Stream.Stream<boolean>;
  /**
   * The folder of the skills every bot shares, one folder per skill with a
   * `SKILL.md`. Each Claude Code and Codex instance lists them as its own
   * user-level skills: the adapter links each one into the harness home's
   * skill folder at every start of the engine, and again at
   * `linkSharedSkills`. A skill of the home's own under the same name wins. A
   * skill whose folder leads out of private state, by `isPrivate`, is not
   * linked.
   */
  readonly sharedSkills: string;
  /**
   * The folder of a bot's own skills, relative to its workspace folder:
   * `skills`. `linkBotSkills` links each one where every harness lists a
   * project's skills.
   */
  readonly botSkills: string;
  /**
   * The caller's containment check: whether `location`, links resolved, is
   * still private state the adapter may write. The adapter asks it for every
   * folder it writes in, at the moment it writes, and leaves alone one it
   * refuses. The folders under `home` it writes are `writtenFolders` (in
   * `@j3-bots/engine-t3/live`), for the caller to check at start too.
   */
  readonly isPrivate: (location: string) => Effect.Effect<boolean>;
}

/**
 * The harness's guess at the operator's next message, after `turnId` of the
 * session completed: one short line, unpersisted. The harness guesses from the
 * session's whole context, envelopes and working text included, not only what
 * the operator saw.
 */
export interface SessionSuggestedReply {
  readonly turnId: TurnId;
  readonly text: string;
}

/**
 * A session's model, the effort and the fast mode asked of it, which
 * `configureSession` takes together, or none of them.
 */
export type ModelSetting =
  | { readonly model?: undefined; readonly effort?: undefined; readonly fast?: undefined }
  | { readonly model: ModelChoice; readonly effort: EffortLevel | null; readonly fast: boolean };

/**
 * The engine, in J3 Bots terms: projects for bot workspaces, sessions for
 * working context, turns that run in them, and the requests a turn holds on.
 *
 * Contract for every method:
 * - It fails with `EngineDown` when the engine cannot answer. `EngineUnavailable`
 *   and `EngineIncompatible` mean nothing was sent. `EngineIndeterminate` means
 *   a command was sent and no reply settled it: it may have been applied, and
 *   never counts as "not applied". Once a call has sent a command, any later
 *   failure of the call is `EngineIndeterminate`, except `DispatchRejected`,
 *   `PermissionModeRefused` and `BackgroundWorkRunning`, which the engine
 *   answered.
 * - Methods that take a `key` apply it once, even across engine and server
 *   restarts: calling again with the same key and input applies nothing new.
 *   After `EngineIndeterminate`, that is how the caller learns what happened;
 *   for a dispatch, the second call is `redispatch`.
 * - Methods without a key are idempotent by nature, except where noted.
 * - It never returns engine identifiers other than the opaque ids in `ids.ts`.
 *
 * The engine holds a session's queue of waiting turns after an engine restart,
 * a provider error, a model or provider change while the replaced provider
 * session still runs background work, and a Stop. Each time the queue becomes
 * held, the session's events carry one `queue-held`; the server answers it with
 * `resumeQueue`, through its per-session gate. The adapter never resumes a
 * queue on its own.
 *
 * `@j3-bots/engine-t3/testing` has an in-memory implementation that keeps this
 * contract, for testing the server without an engine.
 */
export class Engine extends Context.Service<
  Engine,
  {
    /**
     * The engine's health and its providers, starting with the current value
     * and then on every change. Never fails: an unreachable engine is a state.
     */
    readonly status: Stream.Stream<EngineStatus>;

    /**
     * Which start of the engine is ready: `null` while it is not, and
     * otherwise a number that grows each time it becomes ready again, so a
     * restart is seen even when no `null` came between. Starting with the
     * current value. An answer that depends on what the engine read when it
     * started names the start that gave it (`PermissionModeRefused`).
     */
    readonly starts: Stream.Stream<number | null>;

    /**
     * Which engine is ready now. Projects, sessions and the keys they were
     * opened under are that engine's alone: another one, as a fresh data
     * directory starts, has none of them. Fails while the engine is not ready.
     */
    readonly instance: Effect.Effect<EngineInstanceId, EngineUnavailable>;

    /**
     * Points the Claude Code and Codex instances at `connection`. It is
     * stored, URL and key in one write, in the engine's secret store and
     * nowhere else: not in a settings or configuration file, not in a log.
     * Then the engine is restarted: each harness is configured for it only
     * while the engine is stopped, and every harness starts again with it.
     * The restart interrupts every turn and every background task running in
     * the engine; asking the operator first is the caller's. Setting it again
     * replaces it. Answers what became of it.
     */
    readonly connectProviders: (connection: ProviderConnection) => Effect.Effect<ConnectionOutcome>;

    /** The base URL of the provider connection stored, or null when none is. Never its key. */
    readonly connectedEndpoint: Effect.Effect<string | null>;

    /**
     * Has the engine check the provider again now, as after a sign-in into
     * its home, instead of at its next periodic check, minutes away. What it
     * finds follows on `status`.
     */
    readonly recheckProvider: (providerId: ProviderId) => Effect.Effect<void, EngineDown>;

    /**
     * Has the engine update the provider's harness to the newer version it
     * knows of (`ProviderStatus.version`), the way the harness's maker
     * updates it. It answers once asked; how the update goes follows on
     * `status`, as the provider's `update`. A provider without a version
     * has nothing to update, and asking does nothing.
     */
    readonly updateProvider: (providerId: ProviderId) => Effect.Effect<void, EngineDown>;

    /**
     * Runs every Claude Code or Codex provider of `harness` that names no
     * `binaryPath` of its own on `executable`, a harness J3 Bots installed,
     * by its absolute path, from now on; null runs the one the engine finds
     * on its `PATH`. An engine that runs applies it at once, by rebuilding
     * each provider's instance: a session it opens from then on runs the new
     * executable, while a session it already has open keeps the one it
     * started on until the engine releases it. It answers once a check the
     * engine made after the request shows each rebuilt instance: with
     * `version`, installed, that version, not failed and not flagged
     * incompatible; with null, any check that ended. Its status reads as
     * `checking` until then. Every later start of the engine is given it
     * only once it succeeded. `EngineUnavailable` when the engine is not
     * ready, which leaves what it runs as it was; `EngineIndeterminate`
     * when it may or may not run `executable` now: asking again, for either
     * executable, sends it again. Sends nothing for a provider that already
     * runs `executable`.
     */
    readonly setHarnessExecutable: (input: {
      readonly harness: CopiedHarness;
      readonly executable: string | null;
      readonly version: string | null;
    }) => Effect.Effect<void, EngineDown>;

    /**
     * Runs the engine with `providers` from now on, in place of the ones it
     * had: each that is new, or changed, is written to the engine's own
     * settings as its instance (an `upsert`), and each that is gone is
     * removed, while the engine runs; one it does not run yet is given them
     * at its next start. A change of anything but a provider's name rebuilds
     * its instance, which ends what ran on it. Never fails. Whether the
     * engine took every change now: one it did not take is sent again while
     * it runs, until it does, and every provider at its next start, and the
     * log says which it did not take. A provider removed may still run until
     * then, so its home stays until the engine took its removal.
     */
    readonly setProviders: (providers: ReadonlyArray<ProviderInstance>) => Effect.Effect<boolean>;

    /**
     * A link that opens the engine's own web interface, signed in, for setting
     * up providers until J3 Bots has its own screen. Short-lived.
     */
    readonly consoleLink: Effect.Effect<string, EngineDown>;

    /**
     * Links the shared skills into every harness home now, while the engine
     * runs: a skill added to the shared folder, or removed from it, reaches
     * each harness without a restart. Never fails: a home it cannot link is
     * logged and left as it was.
     */
    readonly linkSharedSkills: Effect.Effect<void>;

    /**
     * Links the bot's own skills, the folders of `botSkills` in the
     * workspace, into the folders each harness lists a project's skills from
     * there, so the bot's harness offers them. A folder the bot or the
     * operator put there under a skill's name is left alone. Never fails.
     */
    readonly linkBotSkills: (workspacePath: string) => Effect.Effect<void>;

    /**
     * The project for a workspace folder, created if missing. Looked up by
     * path, so calling it again returns the same project.
     */
    readonly ensureProject: (input: {
      readonly workspacePath: string;
      readonly title: string;
    }) => Effect.Effect<EngineProjectId, EngineDown>;

    /**
     * Removes the project and every session in it, stopping what runs there.
     * The workspace folder is left alone. Succeeds if the project is already
     * gone. The engine drops the project's settings overrides, its browser
     * access with them, and at its start any a failed removal left (**Read**
     * at `bc0f04d`: `ProjectService.ts`, `clearProjectSettingsOverrides`;
     * `ProjectSettingsOverrideSweep.ts`).
     */
    readonly removeProject: (projectId: EngineProjectId) => Effect.Effect<void, EngineDown>;

    /**

    /**
     * A new, idle session in the project. `key` is written by the server
     * before this call, so a retry returns the same session: with the model,
     * effort and permission mode it was first opened with, which a retry with
     * other settings does not change. `configureSession` sets them. The
     * session's id is derived from the key, so another key opens another
     * session. The effort is asked of the model only while the engine
     * reports it as one of the model's levels: otherwise, as for null, the
     * harness picks its own, and the turn runs. Fast mode likewise, only
     * while the engine reports one for the model.
     *
     * `OpenRejected`: the engine refused it and keeps that refusal for the
     * key, which is spent. The caller opens the session later under a fresh
     * key. `PermissionModeRefused`: the engine refuses the permission mode,
     * and keeps nothing for the key; it opens no session in that mode until
     * it starts again under a policy that allows it. The error names the
     * highest mode the policy allows, when the engine reports one.
     */
    readonly openSession: (input: {
      readonly key: IdempotencyKey;
      readonly projectId: EngineProjectId;
      readonly title: string;
      readonly model: ModelChoice;
      readonly effort: EffortLevel | null;
      readonly fast: boolean;
      readonly permissionMode: PermissionMode;
    }) => Effect.Effect<
      SessionId,
      EngineDown | ModelUnavailable | OpenRejected | PermissionModeRefused
    >;

    /**
     * Changes the model, its effort or the permission mode of a session, from
     * its next turn. The model and its effort go together, the effort as
     * `openSession` asks it. Sends only what differs from what the session
     * runs, so it also brings a session to settings it may already have.
     *
     * A change can replace the session's provider session: on Claude Code a
     * permission mode always does, which ends a turn running there (**Read**
     * at `bc0f04d`, `Orchestrator.ts` L4871-4913, `ClaudeAdapterV2.ts` L660).
     * So it is refused with `SessionBusy`, sending nothing, while the adapter
     * sees a turn preparing, starting or running in the session; a turn that
     * only waits in the queue does not count. Like the dispatch's busy check,
     * a turn the engine starts on its own between the check and the change
     * is not seen. `BackgroundWorkRunning`: the engine refused a change that
     * would end the session's background work. `PermissionModeRefused`: the
     * engine refuses the permission mode, as `openSession` says. A model sent
     * before a refused permission mode stays applied; calling again sends what
     * still differs.
     */
    readonly configureSession: (
      input: {
        readonly sessionId: SessionId;
        readonly permissionMode?: PermissionMode;
        /**
         * Starts the session's provider again before its next turn, so it
         * runs the provider's executable now (`setHarnessExecutable`). The
         * conversation resumes where it was. Refused as a change is: while a
         * turn runs, and while background work it would end runs.
         */
        readonly reloadTools?: boolean;
      } & ModelSetting,
    ) => Effect.Effect<
      void,
      | EngineDown
      | SessionNotFound
      | ModelUnavailable
      | SessionBusy
      | BackgroundWorkRunning
      | PermissionModeRefused
    >;

    /**
     * Takes a replaced session out of use, as a rotation does: stops what runs
     * in it as `stop` does and archives it. Its history stays in the engine.
     * Succeeds if it is already retired. Each call sends keys of its own, so
     * calling again after any failure is safe.
     *
     * `RetireRejected`: the engine refused the Stop or the archive while the
     * session still has work the Stop has not ended yet. The caller retires
     * it again later.
     */
    readonly retireSession: (
      sessionId: SessionId,
    ) => Effect.Effect<void, EngineDown | RetireRejected>;

    /**
     * Sends a message into a session for the first time: the caller has never
     * sent this key. The result is acceptance only (see `DispatchDisposition`).
     *
     * - `SessionBusy`, `SessionNotFound`: the adapter refused it before
     *   sending anything. The key was never sent.
     * - `DispatchRejected`: the engine refused it and applied nothing.
     * - `PermissionModeRefused`: the engine refuses to run a turn in the
     *   session's permission mode, as under a policy installed after the
     *   session was opened in it: nothing was applied and the engine keeps
     *   nothing for the key, so the message may go again once the session's
     *   mode is lowered or the engine starts again under another policy. The
     *   error names the session's mode, and the highest one the policy
     *   allows, when the engine reports one.
     * - `EngineIndeterminate`: anything else, including an error the adapter
     *   cannot identify. Resolve it with `redispatch`, never with `dispatch`.
     *
     * Calling it twice with one key is a defect: once a send may have reached
     * the engine, every later send of the key is a `redispatch`.
     */
    readonly dispatch: (
      input: DispatchInput,
    ) => Effect.Effect<
      DispatchDisposition,
      EngineDown | SessionNotFound | SessionBusy | DispatchRejected | PermissionModeRefused
    >;

    /**
     * Sends a key again after a send whose answer was lost, with the same
     * text, files and delivery (staged ids may be fresh: see `DispatchInput`).
     * It skips every local check, the busy check included, since the turn
     * that makes the session busy may be this key's own: it always reaches
     * the engine with the same command id.
     *
     * Success means the engine holds the key as accepted. It says nothing of
     * how: the engine answers a resend with `{sequence}` whether it applied
     * the key now or earlier, so the events say where it went, as for any
     * dispatch. `DispatchRejected` means it was refused and nothing was
     * applied. `PermissionModeRefused` means the engine refuses to run a turn
     * in the session's permission mode, as `dispatch` says: it holds no
     * receipt for the key, so no earlier send of it was applied either.
     * `EngineIndeterminate` leaves it open, as before.
     */
    readonly redispatch: (
      input: DispatchInput,
    ) => Effect.Effect<void, EngineDown | DispatchRejected | PermissionModeRefused>;

    /**
     * Uploads a file for a later dispatch. The engine mints the id; the caller
     * stores it with the dispatch before dispatching, and stages the file again
     * whenever `usableUntil` has passed before a send of the dispatch, the
     * first send or a recovery. Not keyed: a retry after a lost reply stages a
     * second copy, which the engine removes unused.
     */
    readonly stageAttachment: (input: {
      readonly name: string;
      readonly mediaType: string;
      /** Bytes; the file at `path` must have exactly this size. */
      readonly size: number;
      /** Where the bytes are on disk. */
      readonly path: string;
    }) => Effect.Effect<StagedAttachment, EngineDown>;

    /**
     * The operator's Stop, for one session: the engine's own stop, which
     * interrupts the running turn and the background work the engine can
     * reach (delegated tasks, and pending work of a turn that already ended)
     * and holds the queue, then a cancel for each turn waiting in the engine's
     * queue. It also disarms a pending usage-limit continuation. The engine's
     * stop is always sent, also to a session with no running turn, since
     * background work can outlive its turn (**Read** at `bc0f04d`,
     * `Orchestrator.ts`, `dispatchThreadStop`).
     *
     * Success acknowledges the commands; it does not mean they took effect.
     * The engine interrupts a provider turn asynchronously (**Read** at
     * `bc0f04d`, `Orchestrator.ts`, `dispatchThreadStop`: the interrupt is an
     * effect run after the commit). The events say when they did: the running
     * turn's `turn-finished`, a `turn-finished` with `cancelled` for each
     * waiting turn, `steer-dropped` for each untaken steer,
     * `continuation-dropped` for a disarmed continuation, and a
     * `synchronized` with no background work pending and no
     * `runnableTurns` for the background work of a turn that had already
     * ended and for a turn the engine started or queued on its own. An
     * acknowledged stop's interrupt can still fail and leave such work
     * running (**Read**, `Orchestrator.ts`, L14183-14212): the marker reports
     * it pending as long as the engine's own state holds it.
     *
     * A message the engine counts as a user's releases the hold Stop put on
     * the queue, so a dispatch sent between the stop and the cancels starts a
     * turn the cancels miss (**Read**, `sentByUserFromClient`). The caller
     * sends a session nothing while a Stop of it is unsettled.
     *
     * Every command is resolved by its key, as a dispatch is: an error reply
     * is answered by a resend of the same command, whose receipt says whether
     * the engine applied it. A refusal is moot, and counts as done, when
     * nothing it targets can still run, nor may: a live tool whose
     * persistence the adapter could not read keeps it from being moot.
     * Otherwise it is `StopRejected`, and
     * the key is spent. `EngineIndeterminate` is resolved by calling again
     * with the same key.
     *
     * `key` is derived from the Stop command, the session and the round, and
     * stored with the Stop's targets before this call. Wakes J3 Bots holds
     * for the bot are the server's to cancel.
     */
    readonly stop: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | StopRejected>;

    /**
     * Force stop, for a provider that ignores the engine's stop
     * (`stop-ignored`): the engine kills the session's own agent processes,
     * never one another session shares, then ends turn `turnId` as
     * interrupted, or settles the background work it left once it ended, and
     * releases its provider session (**Read** at `bc0f04d`,
     * `ThreadManagementService.ts`, `forceStopThread`). A turn waiting behind
     * it is not ended: that is the Stop's to cancel. What the agent already
     * did stays done, and the next turn starts a new provider session.
     *
     * `turnId` pins the turn the stop was ignored on: the engine refuses once
     * a newer turn has started, which counts as done, since nothing then
     * ignores the stop the operator saw. Not keyed: the engine keeps no
     * receipt of it, and sending it again kills nothing more. The events say
     * when it took: the turn's `turn-finished`, and a `stop-ignored` with
     * null.
     */
    readonly forceStop: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;

    /**
     * Releases the session's held queue, in answer to the `queue-held` event
     * whose cursor is `hold`, which is also its key: a retry sends the same
     * command. If the engine holds the queue again in answer, as it does while
     * a replaced provider session still runs background work, the events
     * carry no new `queue-held` until that cause has passed.
     */
    readonly resumeQueue: (input: {
      readonly sessionId: SessionId;
      readonly hold: EventCursor;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;

    /**
     * Answers an approval or a question, which lets its turn continue. Fails
     * with `RequestClosed` when the request is no longer open, including when
     * the engine refuses the answer for that reason, and with
     * `AnswerRejected` when the engine refuses it while the request stays
     * open. Either is final for the key.
     */
    readonly respond: (input: {
      readonly key: IdempotencyKey;
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly response: RequestResponse;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | RequestClosed | AnswerRejected>;

    /**
     * Answers a secret request. The values go where the request said
     * (`delivery`): the engine's secret store, reached by the tool that asked
     * through a one-use reference, or private files the bot's commands read.
     * Never the conversation. An answer that does not give a value for
     * exactly the fields the request asks for fails with
     * `SecretAnswerMismatch`, and the request stays open. Applied once by nature:
     * the request closes, and answering again fails with `RequestClosed`. The
     * adapter submits one answer per request at a time, so of two concurrent
     * calls the second waits and then fails with `RequestClosed`.
     *
     * Success is the only proof that this call's answer was the one applied.
     * After `EngineIndeterminate`, a retry that fails with `RequestClosed` says
     * only that the request is closed: its resolution (from `request-closed`,
     * after `synchronize`) is how it closed, which may be another submission's
     * answer, a decline from elsewhere, or `expired`.
     */
    readonly respondSecret: (input: {
      readonly sessionId: SessionId;
      readonly requestId: RequestId;
      readonly answer: SecretAnswer;
    }) => Effect.Effect<void, EngineDown | SessionNotFound | RequestClosed | SecretAnswerMismatch>;

    /**
     * The session's events. With `after`, either every event after that cursor,
     * in order, or a single `replaced` when the adapter can no longer replay
     * from there; never both. A cursor names the engine's position, and the
     * adapter replays only from a batch the same process emitted and still
     * keeps. A `replaced` lists every turn that ended, not only those after
     * the cursor. A stream that reconnects and gets a snapshot from the engine
     * continues with a `replaced` too, never with a diff of it. With `after: null`, a `replaced` first: use it only
     * for a session nothing has been dispatched to yet, and store its cursor
     * before the first dispatch.
     *
     * The stream survives engine restarts and dropped connections: the adapter
     * reconnects and resumes the same way, so within one stream no event is
     * delivered twice and none is skipped without a `replaced` covering it. It
     * fails only when the session no longer exists, the engine turns out not
     * to be the pinned version, or the session is archived: by `retireSession`,
     * or from the engine's own console, which leaves a turn already starting
     * or running there with no end of its own. Each of those fails it with
     * `SessionNotFound`, after the events before it. A stream counts as open from when it is
     * subscribed (when it starts running), before it emits anything: a
     * `synchronize` called after that reaches it. **Verified** on release
     * `4969` by the conformance scenario "counts a stream as open from its
     * subscription, before it emits anything", which subscribes and reads
     * nothing, calls `synchronize`, and then reads until the `synchronized`
     * event with its token arrives.
     */
    readonly events: (input: {
      readonly sessionId: SessionId;
      readonly after: EventCursor | null;
    }) => Stream.Stream<SessionEvent, SessionNotFound | EngineIncompatible>;

    /**
     * Asks for a `synchronized` event carrying `token` on every open `events`
     * stream of the session, after every event the engine had recorded for the
     * session when this was called. Once the server has applied that event, it
     * knows the session's state as of this call: the bot tool bridge uses it to
     * find the `tool-call` a tool request came from. The event also says
     * what background work the session still has (`BackgroundWork`), which
     * a Stop's interrupt ends only after it answered. Choose
     * the token, and start waiting for it, before calling.
     *
     * A stream counts as open from when it is subscribed, so one subscribed
     * before this call emits the event even if it has emitted nothing yet
     * (**Verified**, as on `events`).
     * Each stream emits the event only once the engine's completion marker
     * reached it, and the call returns once every open stream has emitted it
     * or closed. A catch-up that fails or times out fails the call with
     * `EngineUnavailable`; retry it.
     */
    readonly synchronize: (input: {
      readonly sessionId: SessionId;
      readonly token: SyncToken;
    }) => Effect.Effect<void, EngineDown | SessionNotFound>;

    /**
     * The session's suggested reply: the current one, then every change, and
     * `null` while it has none. The harness makes one after a turn it
     * completed, while `suggestReplies` is on and the harness can (Claude
     * Code, Codex 0.165 and later), and may make none; a newer one replaces
     * it, whatever turn it follows. The
     * engine keeps them in memory only, so an engine restart loses them. It
     * keeps none for a deleted session (**Read** at `bc0f04d`,
     * `ProviderSessionManager.ts`, `subscribePromptSuggestion`;
     * `ClaudeAdapterV2.ts`, `prompt_suggestion`; `CodexAdapterV2.ts`,
     * `samplePromptSuggestion`).
     *
     * The stream survives engine restarts and dropped connections: it
     * subscribes again once the engine is ready, and goes on with what the
     * engine has then. It never fails.
     */
    readonly suggestedReplies: (
      sessionId: SessionId,
    ) => Stream.Stream<SessionSuggestedReply | null>;
  }
>()("@j3-bots/engine-t3/Engine") {}
