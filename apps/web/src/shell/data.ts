// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConversationItem, Draft } from "@j3-bots/client-runtime";
import type {
  BotFile,
  BotId,
  Device,
  DeviceId,
  EngineStatus,
  EntryId,
  EntryTarget,
  MemoryFile,
  MemoryPath,
  PairingCode,
  RosterItem,
  Routine,
  Settings,
  WorkStep,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";
import type { BotDetailsIntents } from "../components/DetailsPanel";
import type { TimelineIntents } from "../components/Timeline";

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
  /** Null until the roster first loads. */
  readonly roster: ReadonlyArray<RosterItem> | null;
  readonly conversation: (target: EntryTarget) => ConversationView;
  /** What the operator has written to `target` and not sent. */
  readonly draft: (target: EntryTarget) => Draft;
  /** Whether the operator's answer to a card is still on its way to the server. */
  readonly submitting: (entryId: EntryId) => boolean;
  /** A work fold's steps, or null while they load. */
  readonly workSteps: (entryId: EntryId) => ReadonlyArray<WorkStep> | null;
  /** Null while they load. */
  readonly routines: (botId: BotId) => ReadonlyArray<Routine> | null;
  /** Files a bot delivered, newest first; null while they load. */
  readonly files: (botId: BotId) => ReadonlyArray<BotFile> | null;
  /** Null while they load. */
  readonly memory: (botId: BotId) => ReadonlyArray<MemoryFile> | null;
  /** The server's settings; null until they load. */
  readonly settings: Settings | null;
  /** Every paired device; null until they load. */
  readonly devices: ReadonlyArray<Device> | null;
}

/** A pairing code for another device, or why there is none. */
type PairingStart =
  | { readonly _tag: "started"; readonly code: PairingCode; readonly expiresAt: DateTime.Utc }
  | { readonly _tag: "failed" };

/** What the operator can ask for from the shell. Every intent is carried out by the client runtime. */
export interface ShellIntents extends TimelineIntents {
  readonly setRoutineEnabled: BotDetailsIntents["setRoutineEnabled"];
  readonly setDraftText: (target: EntryTarget, text: string) => void;
  readonly attachFiles: (target: EntryTarget, files: ReadonlyArray<File>) => void;
  readonly detachFile: (target: EntryTarget, key: string) => void;
  /** Sends the draft once, however often it is called, and clears it. */
  readonly sendDraft: (target: EntryTarget) => void;
  readonly loadOlder: (target: EntryTarget) => void;
  readonly stopBot: (botId: BotId) => void;
  /** Absent where there is no dictation. */
  readonly dictate?: (target: EntryTarget) => void;
  /** Resolves with the new bot's id once the server has created it. */
  readonly createBot: (name: string, primary: boolean) => Promise<BotId>;
  readonly newBot: () => void;
  /** Absent until rooms can be made. */
  readonly newRoom?: () => void;
  /** Absent until profiles can be edited. */
  readonly editProfile?: (botId: BotId) => void;
  readonly openMemoryFile: (botId: BotId, path: MemoryPath) => void;
  readonly freshStart: (botId: BotId) => void;
  readonly deleteBot: (botId: BotId) => void;

  /** Resolves `false` when the server refused the change. */
  readonly updateSettings: (
    changes: Partial<Pick<Settings, "operatorName" | "timeZone">>,
  ) => Promise<boolean>;
  readonly startPairing: () => Promise<PairingStart>;
  /** Resolves `false` when the server refused it. */
  readonly revokeDevice: (deviceId: DeviceId) => Promise<boolean>;
  /** Reads the list of devices again, as when Settings opens. */
  readonly refreshDevices: () => void;
  /** Signs this device out: its credential is forgotten here and pairing starts over. */
  readonly forgetDevice: () => void;
}
