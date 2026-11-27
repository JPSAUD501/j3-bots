// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderActions } from "../components/ProviderFix";
import type {
  Addressing,
  BotPlacement,
  ConversationItem,
  Draft,
  DraftMention,
  IntentResult,
  PairingOffer,
  RecentTurnsState,
  Revealed,
  SectionChanges,
  ServerUpdateStart,
  ServerUpdateView,
  SettingsChange,
  SettingsSaves,
  SignInView,
  SecretsView,
  UpdatePromptEntry,
  UpdateResult,
} from "@j3-bots/client-runtime";
import type { ConnectorsPlace, SettingsPage } from "@j3-bots/client-runtime/presentation";
import type {
  AvatarChoice,
  Bot,
  BotFile,
  BotId,
  Connector,
  ConnectorPrompt,
  Device,
  DeviceId,
  EngineStatus,
  EntryId,
  EntryOrder,
  EntryTarget,
  MemoryFile,
  MemoryPath,
  MessageQuote,
  PairBotIds,
  PairSeq,
  PromptArguments,
  ReleaseVersion,
  RoomId,
  RosterItem,
  Routine,
  Section,
  SectionId,
  Settings,
  SignInHarness,
  TeammatePair,
  UpdateChannel,
  WorkStep,
} from "@j3-bots/contracts";
import type {
  Accelerator,
  LocalExportResult,
  LocalPairingLink,
  LookingAtChange,
  LookingAtSettings,
  MovedAway,
  UseThisComputerResult,
  PhoneAccess,
  PhoneAccessChange,
  ShortcutChange,
  ServerUpdate as LocalServerUpdate,
  ShortcutStatus,
  UpdateStatus,
} from "@j3-bots/desktop-bridge";
import type * as Redacted from "effect/Redacted";
import type { BotDetailsIntents } from "../components/DetailsPanel";
import type { PairView } from "../components/PairConversation";
import type { ProviderSetupIntents } from "../components/ProviderSetup";
import type { RenderedPrompt } from "../components/PromptPicker";
import type { RoomPlacement } from "../components/RosterMenu";
import type { TimelineIntents } from "../components/Timeline";
import type { WhatsNewIntents } from "../components/WhatsNew";
import type { SecretsIntents } from "../components/secrets/parts";

/** One conversation or room as the shell shows it. */
export interface ConversationView {
  /** `not-found` when the bot or room is gone. */
  readonly phase: "loading" | "ready" | "not-found";
  /** Entries oldest first, then the operator's messages still on their way. */
  readonly items: ReadonlyArray<ConversationItem>;
  /** There are entries before the first one held. */
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

/** What the shell renders: a sample in development, the client runtime's state in a build. */
export interface ShellData {
  /** Null until the server has reported the engine's status. */
  readonly engine: EngineStatus | null;
  /** `engine` is what the server last reported, before this device lost the connection. */
  readonly engineStale: boolean;
  /** Each harness's sign-in this device follows (`ShellIntents.providerSetup`). */
  readonly signIns: ReadonlyMap<SignInHarness, SignInView>;
  /** Null until the roster first loads. */
  readonly roster: ReadonlyArray<RosterItem> | null;
  /**
   * The operator's sections, in their order. Null until the roster loads: no
   * menu offers them then, nor Mark as unread.
   */
  readonly sections: ReadonlyArray<Section> | null;
  /**
   * Whether the server takes mentions of bots and rooms in a bot's
   * conversation: only then does `@` offer them there.
   */
  readonly conversationMentions: boolean;
  /** Whether the server takes quotes on a message: only then are Reply and Quote offered. */
  readonly quotes: boolean;
  readonly conversation: (target: EntryTarget) => ConversationView;
  /** Every pair of bots that wrote each other, latest first; null until they load. */
  readonly pairs: ReadonlyArray<TeammatePair> | null;
  /** The teammate conversation between `botIds`, while it is the one shown. */
  readonly pair: (botIds: PairBotIds) => PairView;
  /** What the operator has written to `target` and not sent. */
  readonly draft: (target: EntryTarget) => Draft;
  /**
   * Text the operator wrote to `target` was replaced in another tab, and can
   * come back: the revision of that offer, which changes whenever newer text
   * is replaced. Null when nothing can come back.
   */
  readonly offer: (target: EntryTarget) => number | null;
  /**
   * The drafts of the pairing this device follows now are being read, after
   * another pairing ended: no draft takes a change until they show.
   */
  readonly draftsLoading: boolean;
  /** The drafts could not be read: no draft takes a change until `retryDrafts` reads them. */
  readonly draftsFailed: boolean;
  /**
   * The device could not keep the draft of `target` as it shows: it is held
   * in memory only, and saved again until it is.
   */
  readonly draftNotSaved: (target: EntryTarget) => boolean;
  /** Whether the operator's answer to a card is still on its way to the server. */
  readonly submitting: (entryId: EntryId) => boolean;
  /** A work fold's steps, or null while they load. */
  readonly workSteps: (entryId: EntryId) => ReadonlyArray<WorkStep> | null;
  /** Null while they load. */
  readonly routines: (botId: BotId) => ReadonlyArray<Routine> | null;
  /** Files a bot delivered, newest first; null while they load. */
  readonly files: (botId: BotId) => ReadonlyArray<BotFile> | null;
  /** Every connector the operator added; null until they load. */
  readonly connectors: ReadonlyArray<Connector> | null;
  /** Null while they load. */
  readonly memory: (botId: BotId) => ReadonlyArray<MemoryFile> | null;
  /** The server's settings; null until they load. */
  readonly settings: Settings | null;
  /** Each section of Settings' latest save, under way or how it ended. */
  readonly settingsSaves: SettingsSaves;
  /** Settings is open. */
  readonly settingsOpen: boolean;
  /**
   * The page Settings shows; null for its list of pages on a narrow screen,
   * and its first page on a wide one.
   */
  readonly settingsPage: SettingsPage | null;
  /** The operator's secrets: their state, and the saved ones while they can be used. */
  readonly secrets: SecretsView;
  /** Every paired device; null until they load. */
  readonly devices: ReadonlyArray<Device> | null;
  /** The turns bots spent recently, read while Settings is open. */
  readonly recentTurns: RecentTurnsState;
  /** A connection to the server is open now. Pairing another device needs one. */
  readonly connected: boolean;
  /**
   * In the desktop app, this device's sign-in is stored only obscured, not
   * encrypted, as Linux had no keyring the app could use when it was stored.
   */
  readonly signInUnencrypted: boolean;
}

/** A pairing code for another device and where it reaches the server, or why there is none. */
type PairingStart = ({ readonly _tag: "started" } & PairingOffer) | { readonly _tag: "failed" };

/**
 * A bot to create: its name, whether it becomes the primary one or starts
 * hidden (visible when left out), and its look, or the server's choice.
 */
interface NewBot {
  readonly name: string;
  readonly primary: boolean;
  readonly hidden?: boolean;
  readonly avatar?: AvatarChoice;
}

/** What the operator can ask for from the shell. Every intent is carried out by the client runtime. */
export interface ShellIntents extends TimelineIntents {
  readonly setRoutineEnabled: BotDetailsIntents["setRoutineEnabled"];
  /**
   * The draft's new text, with the mentions picked in it, and the keys of the
   * files its marks place, in their order, when that changed.
   */
  readonly setDraftText: (
    target: EntryTarget,
    text: string,
    mentions: ReadonlyArray<DraftMention>,
    order?: ReadonlyArray<string>,
  ) => void;
  /**
   * The prompts the connectors `botId` may use offer, for the `/` menu of its
   * conversation; null when they could not be read.
   */
  readonly connectorPrompts: (botId: BotId) => Promise<ReadonlyArray<ConnectorPrompt> | null>;
  /** `prompt` as its server writes it with `given`, for the draft of `botId`'s conversation. */
  readonly renderPrompt: (
    botId: BotId,
    prompt: ConnectorPrompt,
    given: PromptArguments,
  ) => Promise<RenderedPrompt>;
  /** Files to place at `at` in the draft's text, or after it. */
  readonly attachFiles: (target: EntryTarget, files: ReadonlyArray<File>, at?: number) => void;
  readonly detachFile: (target: EntryTarget, key: string) => void;
  /**
   * Adds a reply or a passage to the draft's quotes: `full` when it quotes
   * all a message can, and nothing changed; `not-now` while it is sent.
   */
  readonly quoteInDraft: (target: EntryTarget, quote: MessageQuote) => "added" | "full" | "not-now";
  /** Takes the draft's quote at `index` out. */
  readonly unquoteInDraft: (target: EntryTarget, index: number) => void;
  /**
   * Sends the draft once, however often it is called, and clears it.
   * `addressing` only applies in a room; leaving it out mentions nobody.
   */
  readonly sendDraft: (target: EntryTarget, addressing?: Addressing) => void;
  /** Puts back the text another tab replaced. */
  readonly restoreDraft: (target: EntryTarget) => void;
  /** Lets go of the text another tab replaced. */
  readonly dismissDraftOffer: (target: EntryTarget) => void;
  /** Reads the drafts again after they could not be read: resolves with whether they are read now. */
  readonly retryDrafts: () => Promise<boolean>;
  readonly loadOlder: (target: EntryTarget) => void;
  /**
   * Reads the conversation shown back until `entryId` is held, as for a
   * quote's card: whether it is (`Conversation.reveal`).
   */
  readonly revealEntry: (target: EntryTarget, entryId: EntryId) => Promise<Revealed>;
  readonly loadOlderPair: (botIds: PairBotIds) => void;
  /**
   * Reads the teammate conversation shown back to the message of the card
   * `entryId`: its `seq`, or null when it holds none.
   */
  readonly revealInPair: (botIds: PairBotIds, entryId: EntryId) => Promise<PairSeq | null>;
  /** The operator has seen the conversation through this entry. */
  readonly markRead: (target: EntryTarget, through: EntryOrder) => void;
  /** Marks a conversation or room read through `through` from the roster, shown or not. */
  readonly markRosterRead: (target: EntryTarget, through: EntryOrder) => void;
  /** Marks the conversation or room unread from its last entry the operator did not write. */
  readonly markUnread: (target: EntryTarget) => void;
  /**
   * Pins, hides, moves into a section or makes primary. The roster changes
   * when the server says it did; the shell says so when it did not.
   */
  readonly placeBot: (botId: BotId, placement: BotPlacement) => void;
  /** Pins or hides a room, as `placeBot` does a bot. */
  readonly placeRoom: (roomId: RoomId, placement: RoomPlacement) => void;
  /** Resolves with the new section's id, or null when it was not made. */
  readonly createSection: (name: string, botId: BotId | null) => Promise<SectionId | null>;
  readonly updateSection: (sectionId: SectionId, changes: SectionChanges) => void;
  /** Its bots stay, back in the main list. */
  readonly deleteSection: (sectionId: SectionId) => void;
  /**
   * The conversation or room the shell shows with nothing over it, such as
   * the details as a sheet or a dialog; null when there is none. Whether the
   * window itself is in view is the source's to tell.
   */
  readonly setShown: (target: EntryTarget | null) => void;
  readonly stopBot: (botId: BotId) => void;
  /** Stops the work addressed to the room; the shell says so if it did not. */
  readonly stopRoom: (roomId: RoomId) => void;
  /** Stop, for a bot whose AI ignores it (`Bot.forceStop`). */
  readonly forceStopBot: (botId: BotId) => void;
  /** Stop, for a room whose member's AI ignores it; the shell says so if it did not. */
  readonly forceStopRoom: (roomId: RoomId) => void;
  /** Absent where there is no dictation. */
  readonly dictate?: (target: EntryTarget) => void;
  /**
   * In the desktop app, opens its screen recorder for the conversation or room
   * `target`, whose draft the recording joins (decision 0098). Absent in a
   * browser, where a bot's offer to record says to open the app on the computer.
   */
  readonly recordScreen?: (target: EntryTarget) => void;
  /** Resolves with the new bot's id once the server has created it, or with why it did not. */
  readonly createBot: (draft: NewBot) => Promise<IntentResult<BotId>>;
  readonly newBot: () => void;
  /** Asks for a template file, then shows all a bot made from it would be and do. */
  readonly newBotFromTemplate: () => void;
  /** Shows what sharing the bot as a template puts in the file, then saves or copies it. */
  readonly shareBotTemplate: (botId: BotId) => void;
  readonly newRoom: () => void;
  /** Opens the form for a new room with the two bots of a teammate conversation in it. */
  readonly startRoomWith: (botIds: PairBotIds) => void;
  /** Opens the form that changes a room's name and members. */
  readonly editRoom: (roomId: RoomId) => void;
  /** Resolves once the server answered, whatever it said. */
  readonly archiveRoom: (roomId: RoomId) => Promise<void>;
  /**
   * Unarchives the room, or opens the form that gives it the members it needs
   * first. Resolves like `archiveRoom`.
   */
  readonly unarchiveRoom: (roomId: RoomId) => Promise<void>;
  readonly deleteRoom: (roomId: RoomId) => void;
  /** Opens the form that edits a bot's profile, model and permission mode. Absent where there is none. */
  readonly editProfile?: (botId: BotId) => void;
  readonly openMemoryFile: (botId: BotId, path: MemoryPath) => void;
  /** Gives the bot the browser, or takes it away; the shell says so if it was not saved. */
  readonly setBrowser: (bot: Bot, enabled: boolean) => void;
  /** `name` is the bot's as the operator asked, for what the shell says once it is done. */
  readonly freshStart: (botId: BotId, name: string) => void;
  readonly deleteBot: (botId: BotId) => void;

  /** Saves the change; the save of its section in `settingsSaves` follows it. */
  readonly updateSettings: (change: SettingsChange) => void;
  readonly setSettingsOpen: (open: boolean) => void;
  readonly showSettingsPage: (page: SettingsPage | null) => void;
  /** Opens the connectors screen, closing Settings if it is open. */
  readonly openConnectors: (opening: ConnectorsPlace) => void;
  readonly startPairing: () => Promise<PairingStart>;
  /**
   * Resolves `false` unless the server confirmed it within ten seconds; the
   * list of devices is then read again, and shows whether it was revoked.
   */
  readonly revokeDevice: (deviceId: DeviceId) => Promise<boolean>;
  /** Reads the settings again, as when Settings opens. */
  readonly refreshSettings: () => void;
  /** Signs the bots' browser out of every site; resolves with whether it did. */
  readonly signOutBrowser: () => Promise<boolean>;
  /** Checks a provider again, updates its harness, installs J3 Bots' own copy, or cancels that (`ProviderActions`). */
  readonly providerActions: ProviderActions;
  /** Adds, changes, shows and deletes secrets, and opens a vault from before them. */
  readonly secrets: SecretsIntents;
  /** Reads the list of devices again, as when Settings opens. */
  readonly refreshDevices: () => void;
  /** Reads more of the recent turns, when `recentTurns` can take more. */
  readonly loadMoreTurns: () => void;
  /** Reads the recent turns again after a read failed. */
  readonly retryTurns: () => void;
  /**
   * Ends this device's access and deletes what it keeps here; the app then
   * returns to pairing. Resolves `false` when the credential could not be
   * deleted and the device is still signed in.
   */
  readonly signOut: () => Promise<boolean>;
  /**
   * In the desktop app, the server elsewhere it talks to. Absent in a
   * browser, whose server is the page's own, and in local mode (`local`).
   */
  readonly server?: DesktopServer;
  /** In the desktop app, while the bots live on this computer. */
  readonly local?: DesktopLocal;
  /** In the desktop app, updating it. Absent in a browser, whose page is the server's own. */
  readonly update?: DesktopUpdate;
  /**
   * Updating the server from here. Absent in the desktop app's local mode,
   * where updating the app updates the server it runs.
   */
  readonly serverUpdate?: RemoteServerUpdate;
  /** The way back to the update prompt: what waits behind it, and opening it again. */
  readonly updatePrompt?: UpdatePromptIntents;
  /** What each release lets people do, up to the server's, and its mark after an update. */
  readonly whatsNew: WhatsNewIntents;
  /** In the desktop app, the global shortcut that shows it. Absent in a browser. */
  readonly shortcut?: DesktopShortcut;
  /** In the desktop app, what quick access reads of the window in front. Absent in a browser. */
  readonly lookingAt?: DesktopLookingAt;
  /**
   * In the desktop app, while the bots live on this computer: signing the
   * providers in from here. Absent elsewhere, where the command connects them.
   */
  readonly providerSetup?: ProviderSetupIntents;
}

/** The server the desktop app talks to, and a way to leave it for another. */
export interface DesktopServer {
  /** Its origin, as shown to the operator. */
  readonly address: string;
  /**
   * Forgets it, with this device's sign-in there and everything kept for it,
   * and opens the app's first page, the server address screen. Resolves `false`
   * when it is still kept.
   */
  readonly forget: () => Promise<boolean>;
  /**
   * Leaves it for this computer: forgets it as `forget` does, then runs the
   * bots here. Absent where this computer cannot run them.
   */
  readonly chooseThisComputer?: () => Promise<UseThisComputerResult | null>;
  /**
   * The data the bots that moved from this computer left here, and deleting
   * it, which resolves `false` when nothing was deleted. Absent while there
   * is none.
   */
  readonly leftHere?: {
    readonly moved: MovedAway;
    readonly deleteData: () => Promise<boolean>;
  };
}

/** The bots on this computer, as the desktop app runs them. */
export interface DesktopLocal {
  /**
   * Signs this device out of the server on this computer and stops it, its
   * data kept, for a server elsewhere: the app then loads the server address
   * screen. Resolves `false` when it did not stop.
   */
  readonly stopUsing: () => Promise<boolean>;
  /**
   * Moves the bots to another server: the app asks where to save the export,
   * its secrets sealed under `passphrase`, stops their server and writes it,
   * then loads the page again on the screen that says they moved.
   */
  readonly moveAway: (passphrase: Redacted.Redacted<string>) => Promise<LocalExportResult | null>;
  /** Whether the app starts, in the tray, as the operator signs in to the system. */
  readonly startWithSystem: boolean;
  /** Changes it; resolves with what holds once the app answered. */
  readonly setStartWithSystem: (on: boolean) => Promise<boolean>;
  /**
   * What the version of the server on this computer is going through, as
   * the app reports it: the app moves it to the release it carries, rolled
   * an update back, or is older than it. None when nothing moves it.
   */
  readonly serverUpdate: LocalServerUpdate | undefined;
  /** Tries the update it was rolled back from again. */
  readonly retryServerUpdate: () => void;
  /** Shows why that update was rolled back. */
  readonly showUpdateDetails: () => void;
  /** Phones on this computer's network reaching the bots. */
  readonly phone: DesktopPhone;
}

/** The system the desktop app runs on, as far as its firewall goes. */
export type DesktopSystem = "windows" | "mac" | "linux";

/** Phones on this computer's network reaching the bots on it ("Use from your phone"). */
export interface DesktopPhone {
  /** Phone access as last known. */
  readonly access: PhoneAccess;
  /**
   * Calls `listener` with phone access now, its addresses read again, then
   * each time it changes; answers a function that stops it.
   */
  readonly follow: (listener: (access: PhoneAccess) => void) => () => void;
  /** Which system's firewall to speak of. */
  readonly system: DesktopSystem;
  /**
   * Turns it on or off. The server on this computer restarts, which stops
   * the work bots have running: `stopWork` says the operator agreed.
   * Resolves `null` when the app gave no answer the page understands.
   */
  readonly set: (on: boolean, stopWork: boolean) => Promise<PhoneAccessChange | null>;
  /** A pairing code for a phone; `unlock` lifts the lock wrong codes set first. */
  readonly pairingLink: (unlock: boolean) => Promise<LocalPairingLink | null>;
}

/** What quick access reads of the window the operator was in as they opened it. */
export interface DesktopLookingAt {
  readonly settings: LookingAtSettings;
  /** Changes it; `null` when the app gave no answer the page understands. */
  readonly change: (change: LookingAtChange) => Promise<LookingAtSettings | null>;
  /** Asks macOS for Screen Recording, where the operator allows it. */
  readonly askScreenAccess: () => Promise<LookingAtSettings | null>;
}

/** The desktop app's global shortcut, which shows it with the cursor in the composer. */
export interface DesktopShortcut {
  /** The shortcut, and whether it works. */
  readonly status: ShortcutStatus;
  /** Changes it; `null` when the app gave no answer the page understands. */
  readonly change: (accelerator: Accelerator) => Promise<ShortcutChange | null>;
}

/**
 * Updating a server this device connects to but does not run, through its
 * update routes outside the protocol, as the shared client follows it.
 */
export interface RemoteServerUpdate {
  readonly view: ServerUpdateView;
  /** How an update this device saw under way ended, until `dismissEnded`. */
  readonly ended: UpdateResult | null;
  readonly dismissEnded: () => void;
  /** Reads the status again, as when the screen that shows it opens. */
  readonly refresh: () => void;
  /** Has the server check its release feed now; settles once the check has ended. */
  readonly check: () => Promise<void>;
  /** Sets the server's channel; the view follows. */
  readonly setChannel: (channel: UpdateChannel) => void;
  /** Starts the update to `version`, stopping the bots' running work only with `stopWork`. */
  readonly start: (version: ReleaseVersion, stopWork: boolean) => Promise<ServerUpdateStart>;
}

/**
 * The update prompt's quiet entry point: a release that waits after
 * "Later", or an update under way behind the dialog the operator put aside;
 * null when there is nothing to come back to. `reopen` brings the dialog
 * back in front, as "Update now" in Settings does.
 */
interface UpdatePromptIntents {
  readonly entry: UpdatePromptEntry | null;
  readonly reopen: () => void;
}

/** Updating the desktop app, which carries its own page. */
export interface DesktopUpdate {
  readonly status: UpdateStatus;
  /** Checks for an update now, unless one is on its way or ready. */
  readonly check: () => void;
  /** Restarts into the downloaded update, as soon as no save is under way. */
  readonly restart: () => void;
  /** Calls off a restart that waits for a save; the update stays ready. */
  readonly cancelRestart: () => void;
  /** Chooses the releases the app follows, unless a version is on its way or installing. */
  readonly setChannel: (channel: UpdateChannel) => void;
  /** Turns "Update automatically" on or off. */
  readonly setAutomatic: (on: boolean) => void;
}
