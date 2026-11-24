// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Addressing,
  BotPlacement,
  ConversationItem,
  Draft,
  DraftMention,
  IntentResult,
  PairingOffer,
  RecentTurnsState,
  SectionChanges,
  SettingsChange,
  SettingsSaves,
  SignInView,
  VaultView,
} from "@j3-bots/client-runtime";
import type { ConnectorsOpening } from "@j3-bots/client-runtime/presentation";
import type {
  AvatarChoice,
  BotFile,
  BotId,
  Connector,
  Device,
  DeviceId,
  EngineStatus,
  EntryId,
  EntryOrder,
  EntryTarget,
  MemoryFile,
  MemoryPath,
  RoomId,
  RosterItem,
  Routine,
  Section,
  SectionId,
  Settings,
  SignInHarness,
  WorkStep,
} from "@j3-bots/contracts";
import type {
  Accelerator,
  LocalPairingLink,
  ModeChange,
  PhoneAccess,
  PhoneAccessChange,
  ShortcutChange,
  ShortcutStatus,
  UpdateStatus,
} from "@j3-bots/desktop-bridge";
import type { BotDetailsIntents } from "../components/DetailsPanel";
import type { ProviderSetupIntents } from "../components/ProviderSetup";
import type { TimelineIntents } from "../components/Timeline";
import type { VaultIntents } from "../components/vault/VaultForms";

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
   * The operator's sections, in their order. Null until the roster loads, and
   * from a server that has no sections: no menu offers them, nor Mark as unread.
   */
  readonly sections: ReadonlyArray<Section> | null;
  readonly conversation: (target: EntryTarget) => ConversationView;
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
  /** The server's vault: its state, and its saved logins while it is unlocked. */
  readonly vault: VaultView;
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

/** A bot to create: its name, whether it becomes the primary one, and its look, or the server's choice. */
interface NewBot {
  readonly name: string;
  readonly primary: boolean;
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
  /** Files to place at `at` in the draft's text, or after it. */
  readonly attachFiles: (target: EntryTarget, files: ReadonlyArray<File>, at?: number) => void;
  readonly detachFile: (target: EntryTarget, key: string) => void;
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
  readonly pinRoom: (roomId: RoomId, pinned: boolean) => void;
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
  /** Absent where there is no dictation. */
  readonly dictate?: (target: EntryTarget) => void;
  /** Resolves with the new bot's id once the server has created it, or with why it did not. */
  readonly createBot: (draft: NewBot) => Promise<IntentResult<BotId>>;
  readonly newBot: () => void;
  /** Asks for a template file, then shows all a bot made from it would be and do. */
  readonly newBotFromTemplate: () => void;
  /** Shows what sharing the bot as a template puts in the file, then saves or copies it. */
  readonly shareBotTemplate: (botId: BotId) => void;
  readonly newRoom: () => void;
  /** Opens the form that changes a room's name, members, host and hop limit. */
  readonly editRoom: (roomId: RoomId) => void;
  /** Resolves once the server answered, whatever it said. */
  readonly archiveRoom: (roomId: RoomId) => Promise<void>;
  /**
   * Unarchives the room, or opens the form that gives it the members and the
   * host it needs first. Resolves like `archiveRoom`.
   */
  readonly unarchiveRoom: (roomId: RoomId) => Promise<void>;
  readonly deleteRoom: (roomId: RoomId) => void;
  /** Opens the form that edits a bot's profile, model and permission mode. Absent where there is none. */
  readonly editProfile?: (botId: BotId) => void;
  readonly openMemoryFile: (botId: BotId, path: MemoryPath) => void;
  /** `name` is the bot's as the operator asked, for what the shell says once it is done. */
  readonly freshStart: (botId: BotId, name: string) => void;
  readonly deleteBot: (botId: BotId) => void;

  /** Saves the change; the save of its section in `settingsSaves` follows it. */
  readonly updateSettings: (change: SettingsChange) => void;
  readonly setSettingsOpen: (open: boolean) => void;
  /** Opens the connectors screen, closing Settings if it is open. */
  readonly openConnectors: (opening: ConnectorsOpening) => void;
  readonly startPairing: () => Promise<PairingStart>;
  /**
   * Resolves `false` unless the server confirmed it within ten seconds; the
   * list of devices is then read again, and shows whether it was revoked.
   */
  readonly revokeDevice: (deviceId: DeviceId) => Promise<boolean>;
  /** Reads the settings again, as when Settings opens. */
  readonly refreshSettings: () => void;
  /** Sets up, unlocks, locks and changes the vault and its logins. */
  readonly vault: VaultIntents;
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
  /** In the desktop app, the global shortcut that shows it. Absent in a browser. */
  readonly shortcut?: DesktopShortcut;
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
  readonly chooseThisComputer?: () => Promise<ModeChange | null>;
}

/** The bots on this computer, as the desktop app runs them. */
export interface DesktopLocal {
  /**
   * Signs this device out of the server on this computer and stops it, its
   * data kept, for a server elsewhere: the app then loads the server address
   * screen. Resolves `false` when it did not stop.
   */
  readonly stopUsing: () => Promise<boolean>;
  /** Whether the app starts, in the tray, as the operator signs in to the system. */
  readonly startWithSystem: boolean;
  /** Changes it; resolves with what holds once the app answered. */
  readonly setStartWithSystem: (on: boolean) => Promise<boolean>;
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

/** The desktop app's global shortcut, which shows it with the cursor in the composer. */
export interface DesktopShortcut {
  /** The shortcut, and whether it works. */
  readonly status: ShortcutStatus;
  /** Changes it; `null` when the app gave no answer the page understands. */
  readonly change: (accelerator: Accelerator) => Promise<ShortcutChange | null>;
}

/** Updating the desktop app, which carries its own page. */
export interface DesktopUpdate {
  readonly status: UpdateStatus;
  /** Checks for an update now, unless one is on its way or ready. */
  readonly check: () => void;
  /** Restarts into the downloaded update, as soon as no save is under way. */
  readonly restart: () => void;
}
