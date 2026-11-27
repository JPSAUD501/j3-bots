// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ClientTelemetryEvent,
  SentTelemetryEvent,
  Attachment,
  WorkImageId,
  DiagnosticsClient,
  ServerInfo,
  Bot,
  Connector,
  ConnectorAppAnswer,
  ConnectorAppContext,
  ConnectorAppContextOutcome,
  ConnectorAppView,
  ConnectorAppViewId,
  ConnectorGrant,
  ConnectorId,
  ConnectorListingDetails,
  ConnectorPrompt,
  Language,
  ListingRef,
  PromptArguments,
  SignInRedirect,
  SignInStarted,
  Skill,
  SkillName,
  SkillScope,
  SkillText,
  SavedTheme,
  ThemeBackground,
  ThemeDefinition,
  ThemeId,
  ThemeLibrary,
  BotFile,
  BotId,
  BrowserInput,
  BrowserTab,
  BrowserTabRef,
  CommandId,
  Device,
  DeviceId,
  DeviceToken,
  EngineStatus as EngineStatusValue,
  EntryId,
  EntryOrder,
  EntryTarget,
  MemoryDocument,
  MemoryFile,
  MemoryPath,
  MemoryScope,
  Mentions,
  HarnessLocation,
  Notification,
  PairBotIds,
  PairSeq,
  ProviderConnectionRequest,
  ProviderId,
  ReactionEmoji,
  Room,
  RoomId,
  MessageQuote,
  RosterItem,
  Routine,
  RoutineId,
  Secret,
  SecretAccess,
  SecretChanges,
  SecretField,
  SecretId,
  Section as RosterSection,
  SectionId,
  TeammatePair,
  ReleaseVersion,
  Settings as SettingsValue,
  SignInHarness,
  UpdateChannel,
  TotpPreview,
  CloudVoiceKeys,
  CloudVoiceModel,
  CloudVoiceProvider,
  VoiceModel,
  VoiceStatus,
} from "@j3-bots/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type * as HttpClient from "effect/http/HttpClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Socket from "effect/socket/Socket";
import * as Connection from "./connection/Connection.ts";
import { refuseRedirects } from "./connection/http.ts";
import * as Files from "./files/Files.ts";
import * as Transcript from "./recording/transcript.ts";
import { type FileProblem, type MessageProblem, normalizeMediaType } from "./files/limits.ts";
import * as Actions from "./intents/Actions.ts";
import * as SignOut from "./intents/SignOut.ts";
import type {
  ClientIdentity,
  ClientStorage,
  CredentialStore,
  DeviceTimeZone,
  FileTransfer,
  Lifecycle,
  Network,
  ServerAddress,
  WindowLocks,
} from "./ports.ts";
import type { Readable } from "./Store.ts";
import * as Browser from "./stores/Browser.ts";
import * as Connectors from "./stores/Connectors.ts";
import * as Skills from "./stores/Skills.ts";
import * as Themes from "./stores/Themes.ts";
import * as Conversations from "./stores/Conversations.ts";
import * as Details from "./stores/Details.ts";
import * as Devices from "./stores/Devices.ts";
import * as Drafts from "./stores/Drafts.ts";
import * as EngineStatus from "./stores/EngineStatus.ts";
import * as Presence from "./stores/Presence.ts";
import * as ProviderSetup from "./stores/ProviderSetup.ts";
import type { Loaded } from "./stores/reads.ts";
import * as Roster from "./stores/Roster.ts";
import * as Settings from "./stores/Settings.ts";
import * as UsageData from "./stores/UsageData.ts";
import type { Synced } from "./stores/synced.ts";
import * as TeammatePairs from "./stores/TeammatePairs.ts";
import * as Usage from "./stores/Usage.ts";
import * as Secrets from "./stores/Secrets.ts";
import * as Voice from "./stores/Voice.ts";
import * as WorkSteps from "./stores/WorkSteps.ts";
import * as ServerUpdate from "./update/ServerUpdate.ts";

/** What a platform provides to run the client. See `ports.ts`. */
export type Platform =
  | ServerAddress
  | CredentialStore
  | ClientStorage
  | DeviceTimeZone
  | ClientIdentity
  | FileTransfer
  | Network
  | Lifecycle
  | WindowLocks
  | HttpClient.HttpClient
  | Socket.WebSocketConstructor
  | SecureRandom.SecureRandom;

/** Every service of the client runtime, for applications that use Effect directly. */
export const layer = SignOut.layer.pipe(
  // Above the roster, whose snapshot says whether the server keeps themes.
  Layer.provideMerge(Themes.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Roster.layer,
      TeammatePairs.layer,
      EngineStatus.layer,
      Devices.layer,
      Drafts.layer,
      Details.layer,
      WorkSteps.layer,
      Presence.layer,
      Usage.layer,
      ProviderSetup.layer,
      ServerUpdate.layer,
      Browser.layer,
      Secrets.layer,
      Connectors.layer,
      Skills.layer,
      Voice.layer,
    ),
  ),
  // Below the stores, so a draft's Send can tell what only the client sees.
  Layer.provideMerge(UsageData.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Conversations.layer),
  Layer.provideMerge(Files.layer),
  Layer.provideMerge(Actions.layer),
  Layer.provideMerge(Connection.layer),
  Layer.provide(refuseRedirects),
);

/** The operator's secrets, with each request answered as a promise; see `Secrets.Secrets`. */
export interface SecretsHandle {
  readonly view: Readable<Secrets.SecretsView>;
  readonly add: (
    secret: Secrets.NewSecret,
    request: EntryId | null,
  ) => Promise<Secrets.SecretsResult<Secret>>;
  readonly addFromAsk: (
    asked: Secrets.AskedValues,
  ) => Promise<Secrets.SecretsResult<ReadonlyArray<Secret>>>;
  readonly update: (id: SecretId, changes: SecretChanges) => Promise<Secrets.SecretsResult<Secret>>;
  readonly remove: (id: SecretId) => Promise<Secrets.SecretsResult>;
  readonly setAccess: (
    id: SecretId,
    access: SecretAccess,
  ) => Promise<Secrets.SecretsResult<Secret>>;
  readonly reveal: (
    id: SecretId,
    field: SecretField,
  ) => Promise<Secrets.SecretsResult<Redacted.Redacted<string>>>;
  readonly totpPreview: (id: SecretId) => Promise<Secrets.SecretsResult<TotpPreview>>;
}

/** What reading back to an entry ends with once its conversation is let go. */
const unreachable: Conversations.Revealed = "unreachable";

export interface ConversationHandle {
  readonly target: EntryTarget;
  readonly state: Readable<Conversations.ConversationState>;
  readonly loadOlder: () => void;
  /**
   * Reads back until the entry `entryId` is held, as for the source of a
   * quote: `unreachable` too when the handle was released first.
   */
  readonly reveal: (entryId: EntryId) => Promise<Conversations.Revealed>;
  /** Moves the read mark forward to `through`, the newest entry the operator has seen. */
  readonly markRead: (through: EntryOrder) => void;
  /** Lets go of the conversation. Its subscription ends when nobody else holds it. */
  readonly release: () => void;
}

/** One teammate conversation, held open until `release`. See `TeammatePairs.PairConversation`. */
export interface PairHandle {
  readonly botIds: PairBotIds;
  readonly state: Readable<TeammatePairs.PairConversationState>;
  readonly loadOlder: () => void;
  /**
   * Reads back until the message one of whose cards is `entryId` is held:
   * its `seq`, to scroll to (`pairMessageKey`), or null when there is none,
   * or the handle was released first.
   */
  readonly reveal: (entryId: EntryId) => Promise<PairSeq | null>;
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

/** The operator's connectors and the gallery to find more in; see `Connectors`. */
export interface ConnectorsClient {
  readonly state: Readable<Synced<ReadonlyArray<Connector>>>;
  readonly prompts: (botId: BotId) => Promise<Actions.IntentResult<ReadonlyArray<ConnectorPrompt>>>;
  readonly renderPrompt: (input: {
    readonly botId: BotId;
    readonly connectorId: ConnectorId;
    readonly name: string;
    readonly arguments: PromptArguments;
  }) => Promise<Actions.IntentResult<{ readonly text: string; readonly cut: boolean }>>;
  readonly listing: (
    ref: ListingRef,
    language: Language,
  ) => Promise<Actions.IntentResult<ConnectorListingDetails>>;
  readonly update: (
    connectorId: ConnectorId,
    changes: Connectors.ConnectorChanges,
  ) => Promise<Actions.IntentResult<Connector, Actions.ConnectorIntentFailure>>;
  readonly remove: (connectorId: ConnectorId) => Promise<Actions.IntentResult>;
  readonly setBots: (
    connectorId: ConnectorId,
    grant: ConnectorGrant,
  ) => Promise<Actions.IntentResult<Connector, Actions.ConnectorIntentFailure>>;
  readonly beginSignIn: (
    connectorId: ConnectorId,
    redirect: SignInRedirect,
  ) => Promise<Actions.IntentResult<SignInStarted>>;
  readonly completeSignIn: (url: Redacted.Redacted<string>) => Promise<Actions.IntentResult>;
  /** A connector's app a bot's reply shows, and what it asks of its connector while drawn. */
  readonly app: {
    readonly open: (viewId: ConnectorAppViewId) => Promise<Actions.IntentResult<ConnectorAppView>>;
    /** `allowed` once the operator allowed the tool in the app's card. */
    readonly callTool: (
      viewId: ConnectorAppViewId,
      name: string,
      args: Schema.JsonObject,
      allowed: boolean,
    ) => Promise<Actions.IntentResult<ConnectorAppAnswer>>;
    readonly readResource: (
      viewId: ConnectorAppViewId,
      uri: string,
    ) => Promise<Actions.IntentResult<ConnectorAppAnswer>>;
    readonly setContext: (
      viewId: ConnectorAppViewId,
      context: ConnectorAppContext,
    ) => Promise<Actions.IntentResult<ConnectorAppContextOutcome>>;
  };
}

/** Every bot's skills and each bot's own; see `Skills`. */
export interface SkillsClient {
  readonly state: Readable<Synced<ReadonlyArray<Skill>>>;
  readonly read: (scope: SkillScope, name: SkillName) => Promise<Actions.IntentResult<SkillText>>;
  readonly save: (
    scope: SkillScope,
    name: SkillName,
    text: SkillText,
  ) => Promise<Actions.IntentResult<Skill>>;
  readonly remove: (scope: SkillScope, name: SkillName) => Promise<Actions.IntentResult>;
}

/** The themes the server keeps and its default; see `Themes`. */
export interface ThemesClient {
  readonly supported: Readable<boolean>;
  readonly state: Readable<Synced<ThemeLibrary>>;
  readonly save: (
    definition: ThemeDefinition,
    themeId?: ThemeId,
  ) => Promise<Actions.IntentResult<SavedTheme>>;
  readonly remove: (themeId: ThemeId) => Promise<Actions.IntentResult>;
  readonly setDefault: (themeId: ThemeId) => Promise<Actions.IntentResult>;
  /** A saved theme's background image, at the revision the library names. */
  readonly background: (themeId: ThemeId, background: ThemeBackground) => Promise<DownloadResult>;
}

/** Server state held open until `release`. */
export interface LoadedHandle<A> {
  readonly state: Readable<Loaded<A>>;
  readonly release: () => void;
}

/** One dictation on the server, until it is over or `cancel`. See `Voice.Dictation`. */
export interface DictationHandle {
  readonly state: Readable<Voice.DictationState>;
  readonly audio: (pcm: Uint8Array) => void;
  readonly finish: (draft?: {
    readonly text: string;
    readonly start: number;
    readonly end: number;
  }) => void;
  /** Ends it: before it is over, nothing is kept and no words come. Call it once it is over too. */
  readonly cancel: () => void;
}

/**
 * Dictation through the server; see `Voice`. The status and keys are only
 * for a server whose settings carry `voice`.
 */
export interface VoiceClient {
  readonly openStatus: () => LoadedHandle<VoiceStatus>;
  readonly openCloudKeys: () => LoadedHandle<CloudVoiceKeys>;
  readonly models: () => Promise<Actions.IntentResult<ReadonlyArray<VoiceModel>>>;
  readonly cloudModels: () => Promise<Actions.IntentResult<ReadonlyArray<CloudVoiceModel>>>;
  readonly setCloudKey: (
    provider: CloudVoiceProvider,
    key: Redacted.Redacted<string> | null,
  ) => Promise<Actions.IntentResult>;
  readonly dictate: () => DictationHandle;
}

/** One tab of a bot's browser, shown while held. See `Browser.BrowserView`. */
export interface BrowserViewHandle {
  readonly state: Readable<Browser.BrowserViewState>;
  readonly picture: Readable<Browser.BrowserPicture | null>;
  readonly probe: Readable<Browser.BrowserProbe | null>;
  readonly cursor: Readable<Browser.BrowserCursor | null>;
  /** Calls `listener` with each answer to a `probe`. Returns the function that stops it. */
  readonly onProbe: (listener: (probe: Browser.BrowserProbe) => void) => () => void;
  /** Calls `listener` with each move and click of the bot's pointer. Returns the function that stops it. */
  readonly onCursor: (listener: (cursor: Browser.BrowserCursor) => void) => () => void;
  /** The picture `sequence` is drawn: the next may come. */
  readonly ack: (sequence: number) => void;
  readonly send: (input: BrowserInput) => void;
  /**
   * Closes the view's socket. It gives nothing back: a tab this device holds
   * stays its own for the server's grace period, unless `release` was sent.
   */
  readonly close: () => void;
}

/** A file's bytes, or why there are none. */
export type DownloadResult =
  | { readonly _tag: "done"; readonly value: Files.Download }
  | {
      readonly _tag: "failed";
      readonly reason: "not-found" | "unreachable" | "too-large" | "not-paired";
    };

/** A download's result as `J3Client` gives it, its failures as data. */
const downloaded = <R>(
  transfer: Effect.Effect<Files.Download, Files.AttachmentUnavailable | Connection.NotPaired, R>,
) =>
  transfer.pipe(
    Effect.map((value): DownloadResult => ({ _tag: "done", value })),
    Effect.catchTags({
      AttachmentUnavailable: (error) =>
        Effect.succeed<DownloadResult>({ _tag: "failed", reason: error.reason }),
      NotPaired: () => Effect.succeed<DownloadResult>({ _tag: "failed", reason: "not-paired" }),
    }),
  );

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
  /**
   * Keeps a credential this device was given without a code, as the desktop
   * app's own server gives the computer it runs on, and connects with it.
   * Resolves `false` when the device could not keep it.
   */
  readonly adopt: (credential: {
    readonly deviceId: DeviceId;
    readonly token: DeviceToken;
  }) => Promise<boolean>;
  /** Ends this device's access, and deletes its credential, drafts and unsent messages here. */
  readonly signOut: () => Promise<SignOut.SignOutResult>;
  readonly reconnectNow: () => void;

  readonly roster: Readable<Synced<ReadonlyArray<RosterItem>>>;
  /** See `Roster.sections`: null while the server has not said it has sections. */
  readonly sections: Readable<ReadonlyArray<RosterSection> | null>;
  /** See `Roster.conversationMentions`: whether `@` is offered in a bot's conversation. */
  readonly conversationMentions: Readable<boolean>;
  /** See `Roster.quotes`: whether Reply and Quote are offered. */
  readonly quotes: Readable<boolean>;
  /** See `Roster.quoteComments`: whether a quoted passage takes a comment. */
  readonly quoteComments: Readable<boolean>;
  /** See `Roster.screenRecordings`: whether recording the screen is offered. */
  readonly screenRecordings: Readable<boolean>;
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

  /**
   * Every pair of bots that wrote each other, latest first; see
   * `TeammatePairs.state`. `betweenBots` picks the roster's, `teammatesOf` a
   * bot's details'.
   */
  readonly pairs: Readable<Synced<ReadonlyArray<TeammatePair>>>;

  readonly openConversation: (target: EntryTarget) => ConversationHandle;
  readonly openPair: (botIds: PairBotIds) => PairHandle;
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
   * Uploads `files` one after another and then sends `text` with them as one
   * message, outside any draft: what a share from another app does. Each
   * upload waits for the server as the composer's does. `onProgress` hears
   * the bytes sent of all the files. Aborting `signal` while files upload
   * stops it, and what was uploaded until then is never sent; once
   * `onSending` is heard, the message is the outbox's, which sends it, and
   * aborting only stops waiting for the server's answer. `refused` names the first file the
   * server would not take, with the composer's reason; nothing was sent.
   */
  readonly sendWithFiles: (
    input: {
      readonly target: EntryTarget;
      readonly text: string;
      readonly files: ReadonlyArray<{ readonly name: string; readonly body: Blob }>;
      readonly onProgress: (sent: number, total: number) => void;
      /**
       * Every file is uploaded and the outbox keeps the message, which it
       * sends on its own from then on: aborting `signal` no longer stops it.
       */
      readonly onSending: () => void;
    },
    signal: AbortSignal,
  ) => Promise<SendWithFilesResult>;
  /**
   * `readdressing`, when given, replaces whom the message was for. `not-kept`
   * when the device could not keep the new attempt: nothing was sent.
   */
  readonly resend: (
    commandId: CommandId,
    readdressing?: Conversations.Readdressing,
  ) => Promise<Actions.IntentResult<EntryId> | { readonly _tag: "not-kept" }>;
  /** Resolves `false` when the device could not keep the change: the message stays as it was. */
  readonly discard: (commandId: CommandId) => Promise<boolean>;

  /** Every conversation's draft, by `targetKey`. Kept on the device. */
  readonly drafts: Readable<ReadonlyMap<string, Drafts.Draft>>;
  /**
   * The draft's new text, with the mentions picked in it, none when left out,
   * and, from a field that draws the files, the keys of the files its marks
   * place, in order (`Drafts.setText`).
   */
  readonly setDraftText: (
    target: EntryTarget,
    text: string,
    mentions?: ReadonlyArray<Drafts.DraftMention>,
    order?: ReadonlyArray<string>,
  ) => void;
  /** Adds files to the draft, placed at `at` in its text or after it, and uploads them. */
  readonly attachFiles: (
    target: EntryTarget,
    files: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
    at?: number,
  ) => void;
  /**
   * Adds a screen recording to the draft, placed at `at` in its text or
   * after it, and uploads it in resumable pieces (`Drafts.attachRecording`):
   * `false` when the draft did not take it, which leaves it as it was.
   */
  readonly attachRecording: (
    target: EntryTarget,
    recording: RecordingAttachment,
    at?: number,
  ) => Promise<boolean>;
  readonly detachFile: (target: EntryTarget, key: string) => void;
  /**
   * Adds a reply or a passage to the draft's quotes (`Drafts.quote`): `full`
   * when it quotes all a message can, and nothing changed.
   */
  readonly quoteInDraft: (target: EntryTarget, quote: MessageQuote) => "added" | "full" | "not-now";
  /** Takes the draft's quote at `index` out. */
  readonly unquoteInDraft: (target: EntryTarget, index: number) => void;
  /**
   * Sends the draft once and clears it. `addressing` is whom a room message
   * wakes, or what a message in a bot's conversation mentions; leaving it out
   * mentions nobody.
   */
  readonly sendDraft: (
    target: EntryTarget,
    addressing?: Drafts.Addressing,
    /** What goes beside it, waited for once the draft is on its way (`Drafts.send`). */
    context?: Promise<Drafts.WindowContext | undefined>,
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
  /** Whether a change to a draft made here is not kept on the device yet. */
  readonly draftsSaving: Readable<boolean>;
  /** Puts back the text this window held, never kept, when another window changed the draft. */
  readonly restoreDraft: (target: EntryTarget) => void;
  /** Lets go of the text on offer for `restoreDraft`. */
  readonly dismissDraftOffer: (target: EntryTarget) => void;
  /** A file's bytes, with this device's credential. */
  readonly download: (attachment: Attachment) => Promise<DownloadResult>;
  /** The bytes of an image a step of a bot's work looked at (`WorkStep.image`). */
  readonly workImage: (id: WorkImageId) => Promise<DownloadResult>;
  /**
   * What the server said of itself when this window last reached it, null
   * before: what it offers beside the protocol (`ServerInfo`).
   */
  readonly server: Readable<ServerInfo | null>;
  /** The server's diagnostics zip, saying `client` asked: only when `server` offers one. */
  readonly downloadDiagnostics: (client: DiagnosticsClient) => Promise<DownloadResult>;

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
  /** See `Details.routineRuns`. */
  readonly openRoutineRuns: (routineId: RoutineId) => LoadedHandle<Details.RoutineRuns>;
  readonly setRoutineEnabled: (
    routineId: RoutineId,
    enabled: boolean,
  ) => Promise<Actions.IntentResult<Routine>>;
  readonly createBot: (draft: Details.BotDraft) => Promise<Actions.IntentResult<Bot>>;
  /** The bot as a template, to share as a file. */
  readonly botTemplate: (botId: BotId) => Promise<Details.BotTemplateResult>;
  /** Creates a bot from a template the operator has seen in full. */
  readonly createBotFromTemplate: (
    draft: Details.TemplateDraft,
  ) => Promise<Actions.IntentResult<Bot>>;
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
  /** See `Roster.placeBot`. */
  readonly placeBot: (
    botId: BotId,
    placement: Roster.BotPlacement,
  ) => Promise<Actions.IntentResult<Bot>>;
  /** See `Roster.markRead`: from the roster, without opening the conversation. */
  readonly markRosterRead: (
    target: EntryTarget,
    through: EntryOrder,
  ) => Promise<Actions.IntentResult>;
  readonly markUnread: (target: EntryTarget) => Promise<Actions.IntentResult>;
  readonly createSection: (
    name: string,
    botId: BotId | null,
  ) => Promise<Actions.IntentResult<RosterSection>>;
  readonly updateSection: (
    sectionId: SectionId,
    changes: Roster.SectionChanges,
  ) => Promise<Actions.IntentResult<RosterSection>>;
  readonly deleteSection: (sectionId: SectionId) => Promise<Actions.IntentResult>;
  readonly retryMessage: (entryId: EntryId) => Promise<Actions.IntentResult>;
  readonly retryNotice: (entryId: EntryId) => Promise<Actions.IntentResult>;
  /** Sets the operator's reaction on a message, or takes it off with `null`. */
  readonly react: (entryId: EntryId, emoji: ReactionEmoji | null) => Promise<Actions.IntentResult>;
  readonly answerCard: (
    entryId: EntryId,
    answer: Conversations.CardAnswer,
  ) => Promise<Actions.IntentResult>;
  /** See `Conversations.routineCard`. */
  readonly routineCard: (
    entryId: EntryId,
    command: Conversations.RoutineCardCommand,
  ) => Promise<Actions.IntentResult>;
  readonly provideSecret: (
    entryId: EntryId,
    answer: Conversations.SecretAnswer,
  ) => Promise<Actions.IntentResult>;
  readonly stopBot: (botId: BotId) => Promise<Actions.IntentResult>;
  readonly stopRoom: (roomId: RoomId) => Promise<Actions.IntentResult>;
  /** Stop, for a bot whose AI ignores it (`Bot.forceStop`). */
  readonly forceStopBot: (botId: BotId) => Promise<Actions.IntentResult>;
  /** Stop, for a room whose member's AI ignores it (`Room.forceStop`). */
  readonly forceStopRoom: (roomId: RoomId) => Promise<Actions.IntentResult>;

  readonly updateSettings: (
    change: Settings.SettingsChange,
  ) => Promise<Actions.IntentResult<SettingsValue>>;
  /** Reads the settings again, as when Settings opens. */
  readonly refreshSettings: () => void;
  /** Signs the bots' browser out of every site, for every bot. */
  readonly signOutBrowser: () => Promise<Actions.IntentResult>;
  /** See `UsageData.record`: something only this client sees, told while usage data is on. */
  readonly recordUsage: (event: ClientTelemetryEvent) => void;
  /** See `UsageData.sent`: the newest events the server sent, as they left. */
  readonly usageDataSent: () => Promise<Actions.IntentResult<ReadonlyArray<SentTelemetryEvent>>>;
  /** Has the engine check the provider again now, as after its harness was installed or fixed. */
  readonly recheckProvider: (providerId: ProviderId) => Promise<Actions.IntentResult>;
  /** Has the engine update the provider's harness to the newer version it reports. */
  readonly updateProvider: (providerId: ProviderId) => Promise<Actions.IntentResult>;
  /**
   * Has the server install its own copy of the harness, or update it; done
   * once it started, and only for a provider whose status has `copy`.
   */
  readonly installHarness: (harness: SignInHarness) => Promise<Actions.IntentResult>;
  /** Stops the server's install or update of the harness under way. */
  readonly cancelHarnessInstall: (harness: SignInHarness) => Promise<Actions.IntentResult>;
  readonly refreshDevices: () => void;
  /** Waits ten seconds at most; see `Devices.revoke`. */
  readonly revokeDevice: (deviceId: DeviceId) => Promise<Devices.RevokeResult>;
  readonly startPairing: () => Promise<Actions.IntentResult<Devices.PairingOffer>>;

  /** Each harness's sign-in, as this client follows it; see `ProviderSetup`. */
  readonly signIns: Readable<ReadonlyMap<SignInHarness, ProviderSetup.SignInView>>;
  /**
   * Starts the harness's sign-in on the server, or follows the one under way;
   * `openPage` opens the page it waits on (`ProviderSetup`).
   */
  readonly signIn: (harness: SignInHarness, openPage: (url: string) => void) => void;
  readonly cancelSignIn: (harness: SignInHarness) => void;
  /** Where the server finds each harness; null when it cannot say. */
  readonly harnessLocations: () => Promise<ReadonlyArray<HarnessLocation> | null>;
  readonly connectors: ConnectorsClient;
  readonly skills: SkillsClient;
  readonly themes: ThemesClient;
  /** Connects the providers to an endpoint, restarting the engine. */
  readonly connectEndpoint: (
    request: ProviderConnectionRequest,
  ) => Promise<ProviderSetup.ConnectEndpointResult>;

  /** The tabs the bot has open in its browser, live while held. */
  readonly openBrowserTabs: (botId: BotId) => LoadedHandle<ReadonlyArray<BrowserTab>>;
  /**
   * Shows one tab: its pictures and who holds it, on a socket of its own that
   * opens again after a drop and while the app is in the foreground. `size`
   * is read for each socket.
   */
  readonly openBrowserView: (input: {
    readonly ref: BrowserTabRef;
    readonly size: () => Browser.BrowserViewSize;
  }) => BrowserViewHandle;
  /** The operator's secrets on the server; see `Secrets`. */
  readonly secrets: SecretsHandle;
  readonly voice: VoiceClient;

  readonly setView: (target: EntryTarget | null) => void;
  /**
   * The server's updates: what it runs and is offered, an update under way,
   * and starting one. It works while the server speaks another protocol too.
   */
  readonly serverUpdate: ServerUpdateHandle;

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

/** How sending a message with its files went (`sendWithFiles`). */
export type SendWithFilesResult =
  | Actions.IntentResult<EntryId>
  | { readonly _tag: "invalid"; readonly problem: MessageProblem }
  | { readonly _tag: "refused"; readonly index: number; readonly problem: FileProblem }
  | { readonly _tag: "stopped" };

/** A start of the server's update, or why it did not start. */
export type ServerUpdateStart = ServerUpdate.StartResult | { readonly _tag: "not-paired" };

/** Updating the server from this client; see `ServerUpdate`. */
export interface ServerUpdateHandle {
  readonly view: Readable<ServerUpdate.ServerUpdateView>;
  readonly ended: Readable<ServerUpdate.UpdateResult | null>;
  readonly dismissEnded: () => void;
  readonly refresh: () => void;
  readonly check: () => Promise<ServerUpdate.RequestResult | "not-paired">;
  readonly setChannel: (
    channel: UpdateChannel,
  ) => Promise<ServerUpdate.RequestResult | "not-paired">;
  readonly start: (version: ReleaseVersion, stopWork: boolean) => Promise<ServerUpdateStart>;
}

/**
 * A screen recording to put in a draft (`J3Client.attachRecording`): its zip,
 * and, when its voice is still to be written down, that voice with where its
 * transcript goes. `keep` puts the transcript in the zip, or settles that the
 * zip goes without one (null), and answers the zip's size then; null once
 * the recording is gone.
 */
export interface RecordingAttachment extends Files.RecordingSource {
  readonly release: () => void;
  readonly speech?: Transcript.RecordingSpeech & {
    readonly keep: (transcript: Transcript.RecordingTranscript | null) => Promise<number | null>;
  };
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
        pairs: yield* TeammatePairs.TeammatePairs,
        engine: yield* EngineStatus.EngineStatus,
        settings: yield* Settings.Settings,
        devices: yield* Devices.Devices,
        conversations: yield* Conversations.Conversations,
        workSteps: yield* WorkSteps.WorkSteps,
        presence: yield* Presence.Presence,
        usage: yield* Usage.Usage,
        providerSetup: yield* ProviderSetup.ProviderSetup,
        browser: yield* Browser.Browser,
        secrets: yield* Secrets.Secrets,
        connectors: yield* Connectors.Connectors,
        skills: yield* Skills.Skills,
        themes: yield* Themes.Themes,
        voice: yield* Voice.Voice,
        drafts: yield* Drafts.Drafts,
        files: yield* Files.Files,
        details: yield* Details.Details,
        signOut: yield* SignOut.SignOut,
        serverUpdate: yield* ServerUpdate.ServerUpdate,
        usageData: yield* UsageData.UsageData,
      };
    }),
  );
  const { connection, conversations } = services;
  const transcriptServices: Transcript.TranscriptServices = {
    takesTranscripts: services.roster.recordingTranscripts,
    connection: connection.state,
    settings: services.settings.state,
    voiceStatus: services.voice.status,
    transcribe: services.voice.transcribe,
  };

  /** `sendWithFiles`: each file uploaded in turn, under the pairing followed as it began, then the message. */
  const sendingWithFiles = Effect.fnUntraced(function* (input: {
    readonly target: EntryTarget;
    readonly text: string;
    readonly files: ReadonlyArray<{ readonly name: string; readonly body: Blob }>;
    readonly onProgress: (sent: number, total: number) => void;
    readonly onSending: () => void;
  }) {
    const pairing = connection.pairing.get();
    if (pairing === null) {
      return { _tag: "failed", failure: { _tag: "not-paired" } } satisfies SendWithFilesResult;
    }
    const total = input.files.reduce((sum, file) => sum + file.body.size, 0);
    const attachments: Array<Attachment> = [];
    let before = 0;
    for (const [index, file] of input.files.entries()) {
      const uploaded = yield* services.files
        .upload({
          pairing,
          name: file.name,
          mediaType: normalizeMediaType(file.body.type),
          body: file.body,
          onProgress: (sent) => input.onProgress(before + sent, total),
        })
        .pipe(
          Effect.match({
            onSuccess: (attachment) => ({ _tag: "uploaded", attachment }) as const,
            onFailure: (error) =>
              ({
                _tag: "refused",
                index,
                problem: Files.uploadProblem(error),
              }) satisfies SendWithFilesResult,
          }),
        );
      if (uploaded._tag === "refused") return uploaded;
      attachments.push(uploaded.attachment);
      before += file.body.size;
      input.onProgress(before, total);
    }
    return yield* conversations
      .send({ target: input.target, text: input.text, attachments, onKept: input.onSending })
      .pipe(
        Effect.catchTag("InvalidMessage", ({ problem }) =>
          Effect.succeed({ _tag: "invalid", problem } satisfies SendWithFilesResult),
        ),
      );
  });

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

  /** Calls `listener` with each value `readable` takes but null, until the returned function is called. */
  const each = <A>(readable: Readable<A | null>, listener: (value: A) => void) =>
    readable.subscribe(() => {
      const value = readable.get();
      if (value !== null) listener(value);
    });

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
    adopt: ({ deviceId, token }) =>
      run.promise(
        connection.adopt({ deviceId, token: Redacted.make(token) }).pipe(
          Effect.as(true),
          Effect.catchTag("CredentialStorageError", () => Effect.succeed(false)),
        ),
      ),
    signOut: () => run.promise(services.signOut.run),
    reconnectNow: () => fire(connection.reconnectNow),

    roster: services.roster.state,
    sections: services.roster.sections,
    conversationMentions: services.roster.conversationMentions,
    quotes: services.roster.quotes,
    quoteComments: services.roster.quoteComments,
    screenRecordings: services.roster.screenRecordings,
    pairs: services.pairs.state,
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
      const released = run.sync(Deferred.make<void>());
      return {
        target,
        state: value.state,
        loadOlder: () => fire(value.loadOlder),
        reveal: (entryId) =>
          run.promise(
            value
              .reveal(entryId)
              .pipe(Effect.raceFirst(Effect.as(Deferred.await(released), unreachable))),
          ),
        markRead: (through) => fire(value.markRead(through)),
        release: () => {
          run.sync(Deferred.succeed(released, undefined));
          release();
        },
      };
    },
    openPair: (botIds) => {
      const { value, release } = hold(services.pairs.open(botIds));
      const released = run.sync(Deferred.make<void>());
      return {
        botIds,
        state: value.state,
        loadOlder: () => fire(value.loadOlder),
        reveal: (entryId) =>
          run.promise(
            value.reveal(entryId).pipe(Effect.raceFirst(Effect.as(Deferred.await(released), null))),
          ),
        release: () => {
          run.sync(Deferred.succeed(released, undefined));
          release();
        },
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
    sendWithFiles: (input, signal) =>
      run.promiseExit(sendingWithFiles(input), { signal }).then((exit): SendWithFilesResult => {
        if (Exit.isSuccess(exit)) return exit.value;
        return signal.aborted
          ? { _tag: "stopped" }
          : { _tag: "failed", failure: { _tag: "unexpected" } };
      }),
    resend: (commandId, readdressing) =>
      run.promise(
        conversations
          .resend(commandId, readdressing)
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
    setDraftText: (target, text, mentions, order) =>
      run.sync(services.drafts.setText(target, text, mentions, order)),
    attachFiles: (target, files, at) => fire(services.drafts.attach(target, files, at)),
    attachRecording: (target, { speech, ...recording }, at) =>
      run.promise(
        services.drafts.attachRecording(
          target,
          speech === undefined
            ? recording
            : {
                ...recording,
                transcribe: (progress) =>
                  Transcript.writeDown(transcriptServices, speech, progress).pipe(
                    Effect.flatMap((transcript) =>
                      Effect.promise(async () => {
                        const keep = (kept: Transcript.RecordingTranscript | null) =>
                          speech.keep(kept).catch(() => null);
                        const size = await keep(transcript);
                        // A transcript the device could not put in the zip: it goes without one.
                        return size === null && transcript !== null ? keep(null) : size;
                      }),
                    ),
                    // Gone meanwhile, the recording cannot be read for its upload either.
                    Effect.filterOrFail(
                      (size): size is number => size !== null,
                      () => new Files.UploadRefused({ problem: "unreadable" }),
                    ),
                  ),
              },
          at,
        ),
      ),
    detachFile: (target, key) => fire(services.drafts.detach(target, key)),
    quoteInDraft: (target, quote) => run.sync(services.drafts.quote(target, quote)),
    unquoteInDraft: (target, index) => run.sync(services.drafts.unquote(target, index)),
    sendDraft: (target, addressing, context) =>
      run.promise(
        services.drafts.send(
          target,
          addressing,
          context === undefined ? undefined : Effect.promise(() => context),
        ),
      ),
    onDraftChangedElsewhere: (listener) => listen(services.drafts.changedElsewhere, listener),
    draftOffers: services.drafts.offers,
    draftsSwitching: services.drafts.switching,
    draftsReadFailed: services.drafts.readFailed,
    retryDrafts: () => run.promise(services.drafts.retryRead),
    draftsNotSaved: services.drafts.notSaved,
    draftsSaving: services.drafts.saving,
    restoreDraft: (target) => fire(services.drafts.restore(target)),
    dismissDraftOffer: (target) => fire(services.drafts.dismiss(target)),
    download: (attachment) => run.promise(downloaded(services.files.download(attachment))),
    workImage: (id) => run.promise(downloaded(services.files.workImage(id))),
    server: connection.server,
    downloadDiagnostics: (client) => run.promise(downloaded(services.files.diagnostics(client))),

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
    openRoutineRuns: (routineId) => {
      const { value, release } = hold(services.details.routineRuns(routineId));
      return { state: value, release };
    },
    setRoutineEnabled: (routineId, enabled) =>
      run.promise(services.details.setRoutineEnabled(routineId, enabled)),
    createBot: (draft) => run.promise(services.details.createBot(draft)),
    botTemplate: (botId) => run.promise(services.details.botTemplate(botId)),
    createBotFromTemplate: (draft) => run.promise(services.details.createBotFromTemplate(draft)),
    updateBot: (botId, changes) => run.promise(services.details.updateBot(botId, changes)),
    botSaves: services.details.botSaves,
    dismissBotSave: services.details.dismissBotSave,
    freshStart: (botId) => run.promise(services.details.freshStart(botId)),
    deleteBot: (botId, deleteFiles) => run.promise(services.details.deleteBot(botId, deleteFiles)),
    createRoom: (draft) => run.promise(services.details.createRoom(draft)),
    updateRoom: (roomId, changes) => run.promise(services.details.updateRoom(roomId, changes)),
    deleteRoom: (roomId) => run.promise(services.details.deleteRoom(roomId)),
    placeBot: (botId, placement) => run.promise(services.roster.placeBot(botId, placement)),
    markRosterRead: (target, through) => run.promise(services.roster.markRead(target, through)),
    markUnread: (target) => run.promise(services.roster.markUnread(target)),
    createSection: (name, botId) => run.promise(services.roster.createSection(name, botId)),
    updateSection: (sectionId, changes) =>
      run.promise(services.roster.updateSection(sectionId, changes)),
    deleteSection: (sectionId) => run.promise(services.roster.deleteSection(sectionId)),
    retryMessage: (entryId) => run.promise(conversations.retryMessage(entryId)),
    retryNotice: (entryId) => run.promise(conversations.retryNotice(entryId)),
    react: (entryId, emoji) => run.promise(conversations.react(entryId, emoji)),
    answerCard: (entryId, answer) => run.promise(conversations.answerCard(entryId, answer)),
    routineCard: (entryId, command) => run.promise(conversations.routineCard(entryId, command)),
    provideSecret: (entryId, answer) => run.promise(conversations.provideSecret(entryId, answer)),
    stopBot: (botId) => run.promise(services.roster.stop(botId)),
    stopRoom: (roomId) => run.promise(services.roster.stopRoom(roomId)),
    forceStopBot: (botId) => run.promise(services.roster.forceStop(botId)),
    forceStopRoom: (roomId) => run.promise(services.roster.forceStopRoom(roomId)),

    updateSettings: (change) => run.promise(services.settings.update(change)),
    refreshSettings: () => fire(services.settings.refresh),
    signOutBrowser: () => run.promise(services.settings.signOutBrowser),
    recordUsage: (event) => fire(services.usageData.record(event)),
    usageDataSent: () => run.promise(services.usageData.sent),
    recheckProvider: (providerId) => run.promise(services.engine.recheck(providerId)),
    updateProvider: (providerId) => run.promise(services.engine.update(providerId)),
    installHarness: (harness) => run.promise(services.engine.installHarness(harness)),
    cancelHarnessInstall: (harness) => run.promise(services.engine.cancelHarnessInstall(harness)),
    refreshDevices: () => fire(services.devices.refresh),
    revokeDevice: (deviceId) => run.promise(services.devices.revoke(deviceId)),
    startPairing: () =>
      run.promise(
        services.devices.startPairing.pipe(Effect.exit, Effect.map(Actions.intentResult)),
      ),

    secrets: {
      view: services.secrets.view,
      add: (secret, request) => run.promise(services.secrets.add(secret, request)),
      addFromAsk: (asked) => run.promise(services.secrets.addFromAsk(asked)),
      update: (id, changes) => run.promise(services.secrets.update(id, changes)),
      remove: (id) => run.promise(services.secrets.remove(id)),
      setAccess: (id, access) => run.promise(services.secrets.setAccess(id, access)),
      reveal: (id, field) => run.promise(services.secrets.reveal(id, field)),
      totpPreview: (id) => run.promise(services.secrets.totpPreview(id)),
    },
    signIns: services.providerSetup.signIns,
    signIn: (harness, openPage) => fire(services.providerSetup.signIn(harness, openPage)),
    cancelSignIn: (harness) => fire(services.providerSetup.cancelSignIn(harness)),
    harnessLocations: () => run.promise(services.providerSetup.harnesses),
    connectors: {
      state: services.connectors.state,
      prompts: (botId) => run.promise(services.connectors.prompts(botId)),
      renderPrompt: (input) => run.promise(services.connectors.renderPrompt(input)),
      listing: (ref, language) => run.promise(services.connectors.listing(ref, language)),
      update: (connectorId, changes) =>
        run.promise(services.connectors.update(connectorId, changes)),
      remove: (connectorId) => run.promise(services.connectors.remove(connectorId)),
      setBots: (connectorId, grant) => run.promise(services.connectors.setBots(connectorId, grant)),
      beginSignIn: (connectorId, redirect) =>
        run.promise(services.connectors.beginSignIn(connectorId, redirect)),
      completeSignIn: (url) => run.promise(services.connectors.completeSignIn(url)),
      app: {
        open: (viewId) => run.promise(services.connectors.openApp(viewId)),
        callTool: (viewId, name, args, allowed) =>
          run.promise(services.connectors.callAppTool(viewId, name, args, allowed)),
        readResource: (viewId, uri) =>
          run.promise(services.connectors.readAppResource(viewId, uri)),
        setContext: (viewId, context) =>
          run.promise(services.connectors.setAppContext(viewId, context)),
      },
    },
    themes: {
      supported: services.themes.supported,
      state: services.themes.state,
      save: (definition, themeId) => run.promise(services.themes.save(definition, themeId)),
      remove: (themeId) => run.promise(services.themes.remove(themeId)),
      setDefault: (themeId) => run.promise(services.themes.setDefault(themeId)),
      background: (themeId, background) =>
        run.promise(downloaded(services.files.themeBackground(themeId, background))),
    },
    skills: {
      state: services.skills.state,
      read: (scope, name) => run.promise(services.skills.read(scope, name)),
      save: (scope, name, text) => run.promise(services.skills.save(scope, name, text)),
      remove: (scope, name) => run.promise(services.skills.remove(scope, name)),
    },
    connectEndpoint: (request) => run.promise(services.providerSetup.connect(request)),

    serverUpdate: {
      view: services.serverUpdate.view,
      ended: services.serverUpdate.ended,
      dismissEnded: () => run.sync(services.serverUpdate.dismissEnded),
      refresh: () => fire(services.serverUpdate.refresh),
      check: () =>
        run.promise(
          services.serverUpdate.check.pipe(
            Effect.catchTag("NotPaired", () => Effect.succeed("not-paired" as const)),
          ),
        ),
      setChannel: (channel) =>
        run.promise(
          services.serverUpdate
            .setChannel(channel)
            .pipe(Effect.catchTag("NotPaired", () => Effect.succeed("not-paired" as const))),
        ),
      start: (version, stopWork) =>
        run.promise(
          services.serverUpdate
            .start(version, stopWork)
            .pipe(
              Effect.catchTag("NotPaired", () =>
                Effect.succeed<ServerUpdateStart>({ _tag: "not-paired" }),
              ),
            ),
        ),
    },
    openBrowserTabs: (botId) => {
      const { value, release } = hold(services.browser.tabs(botId));
      return { state: value, release };
    },
    openBrowserView: (input) => {
      const { value, release } = hold(services.browser.view(input));
      return {
        state: value.state,
        picture: value.picture,
        probe: value.probe,
        cursor: value.cursor,
        onProbe: (listener) => each(value.probe, listener),
        onCursor: (listener) => each(value.cursor, listener),
        ack: (sequence) => fire(value.ack(sequence)),
        send: (frame) => fire(value.send(frame)),
        close: release,
      };
    },

    voice: {
      openStatus: () => {
        const { value, release } = hold(services.voice.status);
        return { state: value, release };
      },
      openCloudKeys: () => {
        const { value, release } = hold(services.voice.cloudKeys);
        return { state: value, release };
      },
      models: () => run.promise(services.voice.models),
      cloudModels: () => run.promise(services.voice.cloudModels),
      setCloudKey: (provider, key) => run.promise(services.voice.setCloudKey(provider, key)),
      dictate: () => {
        const { value, release } = hold(services.voice.dictate);
        // Every client dictates through this, but a phone that recognizes on its own.
        fire(
          services.usageData.record({
            event: "feature.used",
            properties: { feature: "voice-input" },
          }),
        );
        return {
          state: value.state,
          audio: (pcm) => fire(value.audio(pcm)),
          finish: (draft) => fire(value.finish(draft)),
          cancel: release,
        };
      },
    },

    setView: (target) => fire(services.presence.setView(target)),
    onNotification: (listener) => listen(services.presence.notifications, listener),

    call: <A, E>(use: (client: Connection.J3RpcClient) => Effect.Effect<A, E | RpcClientError>) =>
      run.promiseExit(connection.call<A, E>(use)),
    commandId: () => run.promise(services.actions.commandId),
    dispose: () => runtime.dispose(),
  };
};
