// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Attachment,
  Bot,
  BotFile,
  BotId,
  CommandId,
  Device,
  DeviceId,
  EngineStatus as EngineStatusValue,
  EntryId,
  EntryOrder,
  EntryTarget,
  MemoryDocument,
  MemoryFile,
  MemoryPath,
  MemoryScope,
  Mentions,
  Notification,
  Room,
  RoomId,
  RosterItem,
  Routine,
  RoutineId,
  Settings as SettingsValue,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type * as HttpClient from "effect/http/HttpClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Socket from "effect/socket/Socket";
import * as Connection from "./connection/Connection.ts";
import { refuseRedirects } from "./connection/http.ts";
import * as Files from "./files/Files.ts";
import type { MessageProblem } from "./files/limits.ts";
import * as Actions from "./intents/Actions.ts";
import * as SignOut from "./intents/SignOut.ts";
import type {
  ClientStorage,
  CredentialStore,
  FileTransfer,
  Network,
  ServerAddress,
  WindowLocks,
} from "./ports.ts";
import type { Readable } from "./Store.ts";
import * as Conversations from "./stores/Conversations.ts";
import * as Details from "./stores/Details.ts";
import * as Devices from "./stores/Devices.ts";
import * as Drafts from "./stores/Drafts.ts";
import * as EngineStatus from "./stores/EngineStatus.ts";
import * as Presence from "./stores/Presence.ts";
import type { Loaded } from "./stores/reads.ts";
import * as Roster from "./stores/Roster.ts";
import * as Settings from "./stores/Settings.ts";
import type { Synced } from "./stores/synced.ts";
import * as Usage from "./stores/Usage.ts";
import * as WorkSteps from "./stores/WorkSteps.ts";

/** What a platform provides to run the client. See `ports.ts`. */
export type Platform =
  | ServerAddress
  | CredentialStore
  | ClientStorage
  | FileTransfer
  | Network
  | WindowLocks
  | HttpClient.HttpClient
  | Socket.WebSocketConstructor
  | SecureRandom.SecureRandom;

/** Every service of the client runtime, for applications that use Effect directly. */
export const layer = SignOut.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Roster.layer,
      EngineStatus.layer,
      Settings.layer,
      Devices.layer,
      Drafts.layer,
      Details.layer,
      WorkSteps.layer,
      Presence.layer,
      Usage.layer,
    ),
  ),
  Layer.provideMerge(Conversations.layer),
  Layer.provideMerge(Files.layer),
  Layer.provideMerge(Actions.layer),
  Layer.provideMerge(Connection.layer),
  Layer.provide(refuseRedirects),
);

export interface ConversationHandle {
  readonly target: EntryTarget;
  readonly state: Readable<Conversations.ConversationState>;
  readonly loadOlder: () => void;
  /** Moves the read mark forward to `through`, the newest entry the operator has seen. */
  readonly markRead: (through: EntryOrder) => void;
  /** Lets go of the conversation. Its subscription ends when nobody else holds it. */
  readonly release: () => void;
}

export interface WorkStepsHandle {
  readonly state: Readable<WorkSteps.WorkStepsState>;
  readonly release: () => void;
}

export interface UsageHandle {
  readonly state: Readable<Usage.RecentTurnsState>;
  /** Reads more of the period's turns; see `Usage.RecentTurnsView`. */
  readonly loadMore: () => void;
  /** Reads the turns again after a read failed. */
  readonly retry: () => void;
  readonly release: () => void;
}

/** Server state held open until `release`. */
export interface LoadedHandle<A> {
  readonly state: Readable<Loaded<A>>;
  readonly release: () => void;
}

/** A file's bytes, or why there are none. */
export type DownloadResult =
  | { readonly _tag: "done"; readonly value: Files.Download }
  | { readonly _tag: "failed"; readonly reason: "not-found" | "unreachable" | "not-paired" };

export type PairResult =
  | { readonly _tag: "paired" }
  | { readonly _tag: "failed"; readonly reason: Connection.PairingFailure };

/**
 * The client runtime for code that does not use Effect: state as `Readable`s,
 * intents as functions. Intents never reject; each resolves with what
 * happened. Create one per server with `createJ3Client`.
 */
export interface J3Client {
  readonly connection: Readable<Connection.ConnectionState>;
  /**
   * The pairing this window follows: its device id, or null without one. A
   * window shows, keeps and sends only the records of the pairing it follows.
   */
  readonly pairing: Readable<DeviceId | null>;
  readonly pair: (input: {
    readonly code: string;
    readonly deviceName: string;
  }) => Promise<PairResult>;
  /** Ends this device's access, and deletes its credential, drafts and unsent messages here. */
  readonly signOut: () => Promise<SignOut.SignOutResult>;
  readonly reconnectNow: () => void;

  readonly roster: Readable<Synced<ReadonlyArray<RosterItem>>>;
  readonly engine: Readable<Synced<EngineStatusValue>>;
  readonly settings: Readable<Synced<SettingsValue>>;
  /** Each section of Settings' latest save, under way or how it ended. */
  readonly settingsSaves: {
    readonly [Section in keyof Settings.SettingsSaves]: Readable<Settings.SettingsSaves[Section]>;
  };
  readonly devices: Readable<Synced<ReadonlyArray<Device>>>;
  /** The turns bots spent recently, read while held, for the usage view. */
  readonly openUsage: () => UsageHandle;
  /** Actions in flight or just accepted, by `cardAction`, `retryAction`, `stopAction` or `roomStopAction` key. */
  readonly actions: Readable<ReadonlyMap<string, Actions.ActionState>>;

  readonly openConversation: (target: EntryTarget) => ConversationHandle;
  readonly openWorkSteps: (foldId: EntryId) => WorkStepsHandle;

  /** `invalid` when the message breaks a limit of `message.send`: it was not sent. */
  readonly send: (input: {
    readonly target: EntryTarget;
    readonly text: string;
    readonly attachments?: ReadonlyArray<Attachment>;
    readonly mentions?: Mentions;
  }) => Promise<
    Actions.IntentResult<EntryId> | { readonly _tag: "invalid"; readonly problem: MessageProblem }
  >;
  /**
   * `mentions`, when given, replace the message's own. `not-kept` when the
   * device could not keep the new attempt: nothing was sent.
   */
  readonly resend: (
    commandId: CommandId,
    mentions?: Mentions,
  ) => Promise<Actions.IntentResult<EntryId> | { readonly _tag: "not-kept" }>;
  /** Resolves `false` when the device could not keep the change: the message stays as it was. */
  readonly discard: (commandId: CommandId) => Promise<boolean>;

  /** Every conversation's draft, by `targetKey`. Kept on the device. */
  readonly drafts: Readable<ReadonlyMap<string, Drafts.Draft>>;
  /** The draft's new text, with the mentions picked in it; none when left out. */
  readonly setDraftText: (
    target: EntryTarget,
    text: string,
    mentions?: ReadonlyArray<Drafts.DraftMention>,
  ) => void;
  /** Adds files to the draft and uploads them. */
  readonly attachFiles: (
    target: EntryTarget,
    files: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
  ) => void;
  readonly detachFile: (target: EntryTarget, key: string) => void;
  /**
   * Sends the draft once and clears it. `addressing` only applies in a room;
   * leaving it out mentions nobody.
   */
  readonly sendDraft: (
    target: EntryTarget,
    addressing?: Drafts.Addressing,
  ) => Promise<Drafts.DraftSendResult>;
  /**
   * Calls `listener` for each draft another window sent or changed under this
   * one; see `Drafts.changedElsewhere`. Returns the function that stops it.
   */
  readonly onDraftChangedElsewhere: (
    listener: (change: Drafts.DraftChangedElsewhere) => void,
  ) => () => void;
  /**
   * The drafts, by `targetKey`, whose text another window's change displaced,
   * each with the revision of its offer, which grows whenever new text is
   * displaced: `restoreDraft` puts it back, `dismissDraftOffer` lets it go.
   */
  readonly draftOffers: Readable<ReadonlyMap<string, number>>;
  /**
   * This window is reading the drafts of the pairing it follows now, after
   * the pairing changed: the drafts take no change meanwhile.
   */
  readonly draftsSwitching: Readable<boolean>;
  /**
   * The drafts of the pairing this window follows could not be read: they
   * take no change until `retryDrafts` reads them.
   */
  readonly draftsReadFailed: Readable<boolean>;
  /** Resolves with whether the drafts are read now. */
  readonly retryDrafts: () => Promise<boolean>;
  /**
   * The drafts, by `targetKey`, the device could not keep as they show: held
   * in memory only, and saved again until they are.
   */
  readonly draftsNotSaved: Readable<ReadonlySet<string>>;
  /** Puts back the text this window held, never kept, when another window changed the draft. */
  readonly restoreDraft: (target: EntryTarget) => void;
  /** Lets go of the text on offer for `restoreDraft`. */
  readonly dismissDraftOffer: (target: EntryTarget) => void;
  /** A file's bytes, with this device's credential. */
  readonly download: (attachment: Attachment) => Promise<DownloadResult>;

  readonly openBotFiles: (botId: BotId) => LoadedHandle<ReadonlyArray<BotFile>>;
  readonly openMemory: (scope: MemoryScope) => LoadedHandle<ReadonlyArray<MemoryFile>>;
  readonly readMemory: (
    scope: MemoryScope,
    path: MemoryPath,
  ) => Promise<Actions.IntentResult<MemoryDocument>>;
  /** See `Details.writeMemory`; `memorySaves` follows it. */
  readonly writeMemory: (
    scope: MemoryScope,
    path: MemoryPath,
    edit: Details.MemoryEdit,
  ) => Promise<Details.SaveResult<MemoryDocument>>;
  /** The latest write of each memory file, by `memorySaveKey`, while under way or once failed. */
  readonly memorySaves: Readable<ReadonlyMap<string, Details.Save<Details.MemoryEdit>>>;
  readonly dismissMemorySave: (scope: MemoryScope, path: MemoryPath) => void;
  readonly openRoutines: (botId: BotId) => LoadedHandle<ReadonlyArray<Routine>>;
  readonly setRoutineEnabled: (
    routineId: RoutineId,
    enabled: boolean,
  ) => Promise<Actions.IntentResult<Routine>>;
  readonly createBot: (draft: Details.BotDraft) => Promise<Actions.IntentResult<Bot>>;
  /** See `Details.updateBot`; `botSaves` follows it. */
  readonly updateBot: (
    botId: BotId,
    changes: Details.BotChanges,
  ) => Promise<Details.SaveResult<Bot>>;
  /** The latest update of each bot, while under way or once failed. */
  readonly botSaves: Readable<ReadonlyMap<BotId, Details.Save<Details.BotChanges>>>;
  readonly dismissBotSave: (botId: BotId) => void;
  readonly freshStart: (botId: BotId) => Promise<Actions.IntentResult>;
  readonly deleteBot: (botId: BotId, deleteFiles: boolean) => Promise<Actions.IntentResult>;
  readonly createRoom: (draft: Details.RoomDraft) => Promise<Actions.IntentResult<Room>>;
  readonly updateRoom: (
    roomId: RoomId,
    changes: Details.RoomChanges,
  ) => Promise<Actions.IntentResult<Room>>;
  readonly deleteRoom: (roomId: RoomId) => Promise<Actions.IntentResult>;
  readonly retryMessage: (entryId: EntryId) => Promise<Actions.IntentResult>;
  readonly retryNotice: (entryId: EntryId) => Promise<Actions.IntentResult>;
  readonly answerCard: (
    entryId: EntryId,
    answer: Conversations.CardAnswer,
  ) => Promise<Actions.IntentResult>;
  readonly provideSecret: (
    entryId: EntryId,
    answer: Conversations.SecretAnswer,
  ) => Promise<Actions.IntentResult>;
  readonly stopBot: (botId: BotId) => Promise<Actions.IntentResult>;
  readonly stopRoom: (roomId: RoomId) => Promise<Actions.IntentResult>;

  readonly updateSettings: (
    change: Settings.SettingsChange,
  ) => Promise<Actions.IntentResult<SettingsValue>>;
  /** Reads the settings again, as when Settings opens. */
  readonly refreshSettings: () => void;
  readonly refreshDevices: () => void;
  /** Waits ten seconds at most; see `Devices.revoke`. */
  readonly revokeDevice: (deviceId: DeviceId) => Promise<Devices.RevokeResult>;
  readonly startPairing: () => Promise<Actions.IntentResult<Devices.PairingOffer>>;

  readonly setView: (target: EntryTarget | null) => void;
  /** Calls `listener` for each notification. Returns the function that stops it. */
  readonly onNotification: (listener: (notification: Notification) => void) => () => void;

  /**
   * Any RPC of the contract, through the typed client: bots, rooms, routines,
   * memory. `use` may run again on a new socket if the first one drops, so it
   * must be a read or a command with a fixed command id.
   */
  readonly call: <A, E>(
    use: (client: Connection.J3RpcClient) => Effect.Effect<A, E | RpcClientError>,
  ) => Promise<Exit.Exit<A, Exclude<E, RpcClientError> | Connection.NotPaired>>;
  /** A new command id, for `call`. */
  readonly commandId: () => Promise<CommandId>;

  /** Closes the socket and every subscription. */
  readonly dispose: () => Promise<void>;
}

/** Starts the client runtime on `platform`. */
export const createJ3Client = async <E>(platform: Layer.Layer<Platform, E>): Promise<J3Client> => {
  const runtime = ManagedRuntime.make(layer.pipe(Layer.provide(platform)));
  // Once built, the runtime cannot fail to build; run against what it built.
  const context = await runtime.context();
  const run = {
    fork: Effect.runForkWith(context),
    promise: Effect.runPromiseWith(context),
    promiseExit: Effect.runPromiseExitWith(context),
    sync: Effect.runSyncWith(context),
  };
  const services = run.sync(
    Effect.gen(function* () {
      return {
        connection: yield* Connection.Connection,
        actions: yield* Actions.Actions,
        roster: yield* Roster.Roster,
        engine: yield* EngineStatus.EngineStatus,
        settings: yield* Settings.Settings,
        devices: yield* Devices.Devices,
        conversations: yield* Conversations.Conversations,
        workSteps: yield* WorkSteps.WorkSteps,
        presence: yield* Presence.Presence,
        usage: yield* Usage.Usage,
        drafts: yield* Drafts.Drafts,
        files: yield* Files.Files,
        details: yield* Details.Details,
        signOut: yield* SignOut.SignOut,
      };
    }),
  );
  const { connection, conversations } = services;

  const fire = <E>(effect: Effect.Effect<void, E>) => {
    run.fork(effect.pipe(Effect.ignore));
  };

  /** Runs `use` in a scope of its own, which `release` closes once. */
  const hold = <A>(use: Effect.Effect<A, never, Scope.Scope>) => {
    const scope = run.sync(Scope.make());
    const value = run.sync(Scope.provide(use, scope));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      fire(Scope.close(scope, Exit.void));
    };
    return { value, release };
  };

  /** Calls `listener` for each item of `stream` until the returned function is called. */
  const listen = <A>(stream: Stream.Stream<A>, listener: (item: A) => void) => {
    const fiber = run.fork(
      stream.pipe(Stream.runForEach((item) => Effect.sync(() => listener(item)))),
    );
    return () => fire(Fiber.interrupt(fiber));
  };

  return {
    connection: connection.state,
    pairing: connection.pairing,
    pair: (input) =>
      run.promise(
        connection.pair(input).pipe(
          Effect.as<PairResult>({ _tag: "paired" }),
          Effect.catchTag("PairingFailed", (error) =>
            Effect.succeed<PairResult>({ _tag: "failed", reason: error.reason }),
          ),
        ),
      ),
    signOut: () => run.promise(services.signOut.run),
    reconnectNow: () => fire(connection.reconnectNow),

    roster: services.roster.state,
    engine: services.engine.state,
    settings: services.settings.state,
    settingsSaves: services.settings.saves,
    devices: services.devices.state,
    openUsage: () => {
      const { value, release } = hold(services.usage.open);
      return {
        state: value.state,
        loadMore: () => fire(value.loadMore),
        retry: () => fire(value.retry),
        release,
      };
    },
    actions: services.actions.state,

    openConversation: (target) => {
      const { value, release } = hold(conversations.open(target));
      return {
        target,
        state: value.state,
        loadOlder: () => fire(value.loadOlder),
        markRead: (through) => fire(value.markRead(through)),
        release,
      };
    },
    openWorkSteps: (foldId) => {
      const { value, release } = hold(services.workSteps.open(foldId));
      return { state: value, release };
    },

    send: (input) =>
      run.promise(
        conversations
          .send(input)
          .pipe(
            Effect.catchTag("InvalidMessage", ({ problem }) =>
              Effect.succeed({ _tag: "invalid", problem } as const),
            ),
          ),
      ),
    resend: (commandId, mentions) =>
      run.promise(
        conversations
          .resend(commandId, mentions)
          .pipe(
            Effect.catchTag("LocalStorageError", () =>
              Effect.succeed({ _tag: "not-kept" } as const),
            ),
          ),
      ),
    discard: (commandId) =>
      run.promise(
        conversations.discard(commandId).pipe(
          Effect.as(true),
          Effect.catchTag("LocalStorageError", () => Effect.succeed(false)),
        ),
      ),

    drafts: services.drafts.state,
    setDraftText: (target, text, mentions) =>
      run.sync(services.drafts.setText(target, text, mentions)),
    attachFiles: (target, files) => fire(services.drafts.attach(target, files)),
    detachFile: (target, key) => fire(services.drafts.detach(target, key)),
    sendDraft: (target, addressing) => run.promise(services.drafts.send(target, addressing)),
    onDraftChangedElsewhere: (listener) => listen(services.drafts.changedElsewhere, listener),
    draftOffers: services.drafts.offers,
    draftsSwitching: services.drafts.switching,
    draftsReadFailed: services.drafts.readFailed,
    retryDrafts: () => run.promise(services.drafts.retryRead),
    draftsNotSaved: services.drafts.notSaved,
    restoreDraft: (target) => fire(services.drafts.restore(target)),
    dismissDraftOffer: (target) => fire(services.drafts.dismiss(target)),
    download: (attachment) =>
      run.promise(
        services.files.download(attachment).pipe(
          Effect.map((value): DownloadResult => ({ _tag: "done", value })),
          Effect.catchTags({
            AttachmentUnavailable: (error) =>
              Effect.succeed<DownloadResult>({ _tag: "failed", reason: error.reason }),
            NotPaired: () =>
              Effect.succeed<DownloadResult>({ _tag: "failed", reason: "not-paired" }),
          }),
        ),
      ),

    openBotFiles: (botId) => {
      const { value, release } = hold(services.details.files(botId));
      return { state: value, release };
    },
    openMemory: (scope) => {
      const { value, release } = hold(services.details.memory(scope));
      return { state: value, release };
    },
    readMemory: (scope, path) => run.promise(services.details.readMemory(scope, path)),
    writeMemory: (scope, path, edit) =>
      run.promise(services.details.writeMemory(scope, path, edit)),
    memorySaves: services.details.memorySaves,
    dismissMemorySave: services.details.dismissMemorySave,
    openRoutines: (botId) => {
      const { value, release } = hold(services.details.routines(botId));
      return { state: value, release };
    },
    setRoutineEnabled: (routineId, enabled) =>
      run.promise(services.details.setRoutineEnabled(routineId, enabled)),
    createBot: (draft) => run.promise(services.details.createBot(draft)),
    updateBot: (botId, changes) => run.promise(services.details.updateBot(botId, changes)),
    botSaves: services.details.botSaves,
    dismissBotSave: services.details.dismissBotSave,
    freshStart: (botId) => run.promise(services.details.freshStart(botId)),
    deleteBot: (botId, deleteFiles) => run.promise(services.details.deleteBot(botId, deleteFiles)),
    createRoom: (draft) => run.promise(services.details.createRoom(draft)),
    updateRoom: (roomId, changes) => run.promise(services.details.updateRoom(roomId, changes)),
    deleteRoom: (roomId) => run.promise(services.details.deleteRoom(roomId)),
    retryMessage: (entryId) => run.promise(conversations.retryMessage(entryId)),
    retryNotice: (entryId) => run.promise(conversations.retryNotice(entryId)),
    answerCard: (entryId, answer) => run.promise(conversations.answerCard(entryId, answer)),
    provideSecret: (entryId, answer) => run.promise(conversations.provideSecret(entryId, answer)),
    stopBot: (botId) => run.promise(services.roster.stop(botId)),
    stopRoom: (roomId) => run.promise(services.roster.stopRoom(roomId)),

    updateSettings: (change) => run.promise(services.settings.update(change)),
    refreshSettings: () => fire(services.settings.refresh),
    refreshDevices: () => fire(services.devices.refresh),
    revokeDevice: (deviceId) => run.promise(services.devices.revoke(deviceId)),
    startPairing: () =>
      run.promise(
        services.devices.startPairing.pipe(Effect.exit, Effect.map(Actions.intentResult)),
      ),

    setView: (target) => fire(services.presence.setView(target)),
    onNotification: (listener) => listen(services.presence.notifications, listener),

    call: <A, E>(use: (client: Connection.J3RpcClient) => Effect.Effect<A, E | RpcClientError>) =>
      run.promiseExit(connection.call<A, E>(use)),
    commandId: () => run.promise(services.actions.commandId),
    dispose: () => runtime.dispose(),
  };
};
