// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotFile,
  BotId,
  EngineStatus,
  Entry,
  EntryId,
  EntryTarget,
  MemoryFile,
  RosterItem,
  Routine,
  WorkStep,
} from "@j3-bots/contracts";
import type { BotDetailsIntents } from "../components/DetailsPanel";
import type { TimelineIntents } from "../components/Timeline";

/**
 * What the shell renders. Today a sample (in development) or nothing (in a
 * build); the client runtime will provide it from the server's subscriptions.
 */
export interface ShellData {
  /** Null until the server has reported the engine's status. */
  readonly engine: EngineStatus | null;
  readonly roster: ReadonlyArray<RosterItem>;
  readonly entries: (target: EntryTarget) => ReadonlyArray<Entry>;
  /** Whether the operator's answer to a card is still on its way to the server. */
  readonly submitting: (entryId: EntryId) => boolean;
  /** A work fold's steps, or null while they load. */
  readonly workSteps: (entryId: EntryId) => ReadonlyArray<WorkStep> | null;
  readonly routines: (botId: BotId) => ReadonlyArray<Routine>;
  /** Files a bot delivered, newest first. */
  readonly files: (botId: BotId) => ReadonlyArray<BotFile>;
  readonly memory: (botId: BotId) => ReadonlyArray<MemoryFile>;
}

/** What the operator can ask for from the shell. Every intent is carried out by the client runtime. */
export interface ShellIntents
  extends TimelineIntents, Omit<BotDetailsIntents, "editProfile" | "freshStart" | "deleteBot"> {
  readonly sendMessage: (target: EntryTarget, text: string) => void;
  readonly stopBot: (botId: BotId) => void;
  readonly attach: (target: EntryTarget) => void;
  readonly dictate: (target: EntryTarget) => void;
  /** Resolves with the new bot's id once the server has created it. */
  readonly createBot: (name: string, primary: boolean) => Promise<BotId>;
  readonly newBot: () => void;
  readonly newRoom: () => void;
  readonly editProfile: (botId: BotId) => void;
  readonly freshStart: (botId: BotId) => void;
  readonly deleteBot: (botId: BotId) => void;
}

const nothing = () => {};

/** A build before the client runtime exists: no server, so the first-run screen says it is connecting. */
export const unconnected: { readonly data: ShellData; readonly intents: ShellIntents } = {
  data: {
    engine: null,
    roster: [],
    entries: () => [],
    submitting: () => false,
    workSteps: () => null,
    routines: () => [],
    files: () => [],
    memory: () => [],
  },
  intents: {
    answerQuestion: nothing,
    dismissQuestion: nothing,
    decideApproval: nothing,
    provideSecret: nothing,
    declineSecret: nothing,
    retryNotice: nothing,
    openWorkFold: nothing,
    openAttachment: nothing,
    openHandoff: nothing,
    openRoutine: nothing,
    openConversation: nothing,
    setRoutineEnabled: nothing,
    openMemoryFile: nothing,
    sendMessage: nothing,
    stopBot: nothing,
    attach: nothing,
    dictate: nothing,
    createBot: () => Promise.reject(new Error("No J3 Bots server to create a bot on")),
    newBot: nothing,
    newRoom: nothing,
    editProfile: nothing,
    freshStart: nothing,
    deleteBot: nothing,
  },
};
