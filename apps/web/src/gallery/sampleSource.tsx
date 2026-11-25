// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The sample team as a shell source that responds: messages are added, cards
 * are decided, bots answer after a moment. A stand-in for the client runtime
 * in development only; nothing here reaches a server.
 */
import type {
  Draft,
  DraftFile,
  SettingsSaves,
  VaultHandle,
  VaultView,
} from "@j3-bots/client-runtime";
import {
  applyConnectorChange,
  type ConnectorsOpening,
  fittedMarks,
  hasDefaultModel,
  inPair,
  insertMarks,
  placedMessage,
  providerGate,
  showsImage,
  withBot,
  withoutMarks,
} from "@j3-bots/client-runtime/presentation";
import {
  AttachmentId,
  BotId,
  EntryId,
  Invalid,
  ModelId,
  PairingCode,
  ProviderId,
  SectionId,
  ServerOrigin,
  type Attachment,
  type Bot,
  type BotState,
  type Connector,
  type EngineStatus,
  type Entry,
  type EntryTarget,
  type Mentions,
  type PairBotIds,
  type Room,
  type RoomId,
  type RosterItem,
  type Section,
  type TeammateMessage,
} from "@j3-bots/contracts";
import { freeAvatar } from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ClockProvider } from "../app/clock";
import { AttachmentImagesProvider } from "../components/attachmentImages";
import { ConnectorsDialog } from "../components/connectors/ConnectorsDialog";
import { ImageViewer } from "../components/ImageViewer";
import type { ShellData, ShellIntents } from "../shell/data";
import { ShellSourceProvider, type ShellSource } from "../shell/source";
import { ordered, previewOf, type DraftEntry } from "./entries";
import { ids, SAMPLE_NOW, sampleTeam, type SampleTeam } from "./sample";
import { sampleBrowser } from "./sampleBrowser";
import { sampleVault } from "./sampleVault";
import { sampleConnectors, sampleConnectorsIntents } from "./sampleConnectors";

interface State extends Omit<SampleTeam, "bots" | "room" | "attachments"> {
  /** Cards whose answer is on its way, as it would be to a server. */
  readonly inFlight: ReadonlySet<EntryId>;
  /** Each conversation's unsent text and files, by `keyOf`. */
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly settingsSaves: SettingsSaves;
  readonly settingsOpen: boolean;
  readonly connectors: ReadonlyArray<Connector>;
  /** The connectors screen, and what opened it; null while it is closed. */
  readonly connectorsOpening: ConnectorsOpening | null;
}

const blankDraft: Draft = { text: "", mentions: [], files: [], sending: false };

/** How long a new bot takes to say hello, from its creation. */
const OPENING_DELAY = 3200;

/** How long an answer to a card takes to arrive, so a second click has something to miss. */
const ANSWER_DELAY = 500;

const keyOf = (target: EntryTarget) =>
  target._tag === "conversation" ? `bot:${target.botId}` : `room:${target.roomId}`;
const itemKey = (item: RosterItem) =>
  item._tag === "bot" ? `bot:${item.bot.id}` : `room:${item.room.id}`;

/** Replaces one target's entries and keeps its roster row's last entry in step. */
function withEntries(
  state: State,
  key: string,
  update: (entries: ReadonlyArray<Entry>) => Entry[],
): State {
  const entries = update(state.entries[key] ?? []);
  const last = entries.at(-1) ?? null;
  return {
    ...state,
    entries: { ...state.entries, [key]: entries },
    roster: state.roster.map((item) =>
      itemKey(item) === key
        ? { ...item, lastEntry: last && previewOf(last), lastActivityAt: last?.createdAt ?? null }
        : item,
    ),
  };
}

/** Every bot of the roster, hidden ones too. */
const botsOf = (state: State): ReadonlyArray<Bot> =>
  state.roster.flatMap((item) => (item._tag === "bot" ? [item.bot] : []));

function updateEntry(state: State, entryId: EntryId, update: (entry: Entry) => Entry): State {
  const key = Object.keys(state.entries).find((k) =>
    state.entries[k]?.some((e) => e.id === entryId),
  );
  return key === undefined
    ? state
    : withEntries(state, key, (es) => es.map((e) => (e.id === entryId ? update(e) : e)));
}

function updateRoom(state: State, roomId: RoomId, update: (room: Room) => Room): State {
  return {
    ...state,
    roster: state.roster.map((item) =>
      item._tag === "room" && item.room.id === roomId ? { ...item, room: update(item.room) } : item,
    ),
  };
}

function updateBot(state: State, botId: BotId, update: (bot: Bot) => Bot): State {
  return {
    ...state,
    roster: state.roster.map((item) =>
      item._tag === "bot" && item.bot.id === botId ? { ...item, bot: update(item.bot) } : item,
    ),
  };
}

/** Marks the bot's conversation or the room read or unread, as the server would. */
function withUnread(state: State, target: EntryTarget, unread: boolean): State {
  const key = keyOf(target);
  return {
    ...state,
    roster: state.roster.map((item) => (itemKey(item) === key ? { ...item, unread } : item)),
  };
}

/** `sections` with the one at `id` moved before `before`, or to the end. */
function placedSection(
  sections: ReadonlyArray<Section>,
  id: SectionId,
  before: SectionId | null,
): ReadonlyArray<Section> {
  const moving = sections.find((section) => section.id === id);
  if (moving === undefined) return sections;
  const others = sections.filter((section) => section.id !== id);
  const index = before === null ? -1 : others.findIndex((section) => section.id === before);
  return index === -1 ? [...others, moving] : others.toSpliced(index, 0, moving);
}

const setState = (botState: BotState) => (bot: Bot) => ({ ...bot, state: botState });

/** The bot waiting on a card, if any. */
const waitingOn = (state: State, entryId: EntryId) =>
  state.roster.flatMap((item) =>
    item._tag === "bot" && item.bot.state._tag === "waiting" && item.bot.state.entryId === entryId
      ? [item.bot.id]
      : [],
  )[0] ?? null;

// The sample's clock: its moment, moved on by the time since the page loaded.
const loadedAt = Date.now();
const now = () => DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) + Date.now() - loadedAt);
let created = 0;
const newId = () => EntryId.make(`local-${++created}`);
// The bytes of each file the operator attached here, which the sample keeps in place of a server.
const attached = new Map<AttachmentId, Blob>();

function message(
  author: Entry["author"],
  text: string,
  attachments: Extract<Entry, { _tag: "message" }>["attachments"] = [],
  mentions: Mentions = { _tag: "bots", ids: [] },
  attachmentOffsets?: ReadonlyArray<number>,
): DraftEntry {
  return {
    _tag: "message",
    id: newId(),
    author,
    createdAt: now(),
    text,
    attachments,
    ...(attachmentOffsets === undefined ? {} : { attachmentOffsets }),
    mentions,
    delivery: { _tag: "delivered" },
    commandId: null,
  };
}

/** `entries` with `draft` placed after the last of them. */
const appended = (entries: ReadonlyArray<Entry>, draft: DraftEntry): Entry[] => [
  ...entries,
  ...ordered([draft], (entries.at(-1)?.order ?? -1) + 1),
];

interface Store {
  readonly get: () => State;
  readonly update: (change: (state: State) => State) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createStore(initial: State): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    update: (change) => {
      state = change(state);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The sample with no bots yet: the first-run screen, with every provider as it is in the sample. */
const withoutBots = (state: State): State => ({
  ...state,
  roster: [],
  entries: {},
  routines: {},
  files: {},
  memory: {},
});

function sampleIntents({ get, update }: Store, vault: VaultHandle): ShellIntents {
  /** The bot thinks for a moment, then says `text` in `key`. */
  const replyLater = (botId: BotId, key: string, text: string) => {
    update((s) =>
      updateBot(
        s,
        botId,
        setState({ _tag: "thinking", since: now(), stalled: false, quietSince: null }),
      ),
    );
    window.setTimeout(() => {
      update((s) =>
        updateBot(
          withEntries(s, key, (es) => appended(es, message({ _tag: "bot", botId }, text))),
          botId,
          setState({ _tag: "idle" }),
        ),
      );
    }, 1600);
  };
  /** The bot waiting on a card carries on once the card is decided. */
  const resume = (entryId: EntryId, text: string) => {
    const botId = waitingOn(get(), entryId);
    if (botId !== null) replyLater(botId, `bot:${botId}`, text);
  };
  /** A command on an entry: in flight for a moment, then applied. */
  const inFlight = (entryId: EntryId, change: (entry: Entry) => Entry, then = () => {}) => {
    update((s) => ({ ...s, inFlight: new Set([...s.inFlight, entryId]) }));
    window.setTimeout(() => {
      update((s) => ({
        ...updateEntry(s, entryId, change),
        inFlight: new Set([...s.inFlight].filter((id) => id !== entryId)),
      }));
      then();
    }, ANSWER_DELAY);
  };
  /** An answer to a card; the bot that waited on it then carries on with `reply`. */
  const answer = (entryId: EntryId, change: (entry: Entry) => Entry, reply: string) =>
    inFlight(entryId, change, () => resume(entryId, reply));
  const nothing = () => {};

  const changeDraft = (target: EntryTarget, change: (draft: Draft) => Draft) =>
    update((s) => {
      const key = keyOf(target);
      return { ...s, drafts: { ...s.drafts, [key]: change(s.drafts[key] ?? blankDraft) } };
    });

  const openConnectors = (opening: ConnectorsOpening) =>
    // A screen put aside under Settings comes back as it was, with what opened it.
    update((s) => ({
      ...s,
      settingsOpen: false,
      connectorsOpening: s.connectorsOpening ?? opening,
    }));

  return {
    openConnectors,
    connectSuggested: (entry) => {
      const { botId } = entry.author;
      if (entry.subject._tag === "listing") {
        openConnectors({
          at: { _tag: "listing", ref: entry.subject.ref, name: entry.name, glyph: entry.glyph },
          forBot: botId,
          suggestion: entry.id,
        });
        return;
      }
      const { connectorId } = entry.subject;
      inFlight(
        entry.id,
        (e) =>
          e._tag === "connector-suggestion"
            ? { ...e, status: { _tag: "connected", connectorId } }
            : e,
        () =>
          update((s) => ({
            ...s,
            connectors: s.connectors.map((connector) =>
              connector.id === connectorId
                ? { ...connector, grant: withBot(connector.grant, botId, true, botsOf(s)) }
                : connector,
            ),
          })),
      );
    },
    dismissSuggestion: (entryId) =>
      inFlight(entryId, (e) =>
        e._tag === "connector-suggestion" ? { ...e, status: { _tag: "dismissed" } } : e,
      ),
    signInConnector: (entry) =>
      openConnectors({
        at: { _tag: "connector", connectorId: entry.connectorId, signIn: true, added: false },
        forBot: entry.author.botId,
        suggestion: null,
      }),
    setDraftText: (target, text, mentions, order) =>
      changeDraft(target, (draft) => {
        const files =
          order === undefined
            ? draft.files
            : order.flatMap((key) => draft.files.filter((file) => file.key === key));
        return { ...draft, ...fittedMarks({ text, mentions }, files.length), files };
      }),
    // Files are "uploaded" at once: the sample has no server to send them to.
    attachFiles: (target, picked, at) =>
      changeDraft(target, (draft) => {
        const placed = insertMarks(draft, at ?? draft.text.length, picked.length);
        return {
          ...draft,
          text: placed.text,
          mentions: placed.mentions,
          files: draft.files.toSpliced(
            placed.index,
            0,
            ...picked.map((file): DraftFile => {
              const id = AttachmentId.make(`local-file-${++created}`);
              attached.set(id, file);
              return {
                _tag: "ready",
                key: id,
                attachment: {
                  id,
                  name: file.name,
                  mediaType: file.type === "" ? "application/octet-stream" : file.type,
                  size: file.size,
                },
              };
            }),
          ),
        };
      }),
    detachFile: (target, key) =>
      changeDraft(target, (draft) => {
        const index = draft.files.findIndex((file) => file.key === key);
        return {
          ...draft,
          ...withoutMarks(draft, (mark) => mark === index),
          files: draft.files.filter((file) => file.key !== key),
        };
      }),
    restoreDraft: nothing,
    retryDrafts: () => Promise.resolve(true),
    dismissDraftOffer: nothing,
    sendDraft: (target, addressing) => {
      const mentions = addressing?.mentions;
      const key = keyOf(target);
      const draft = get().drafts[key] ?? blankDraft;
      const { text, offsets } = placedMessage(draft.text);
      const attachments = draft.files.flatMap((file) =>
        file._tag === "ready" ? [file.attachment] : [],
      );
      if (text === "" && attachments.length === 0) return;
      update((s) => ({
        ...withEntries(s, key, (es) =>
          appended(
            es,
            message(
              { _tag: "operator" },
              text,
              attachments,
              mentions,
              attachments.length === 0 ? undefined : offsets,
            ),
          ),
        ),
        drafts: { ...s.drafts, [key]: blankDraft },
      }));
      // In a room, the first bot addressed answers, or the first member when nobody is.
      const room = get().roster.find(
        (i) => i._tag === "room" && target._tag === "room" && i.room.id === target.roomId,
      );
      const first = room?._tag === "room" ? room.room.members[0] : undefined;
      const addressed =
        mentions === undefined || mentions._tag === "everyone" ? first : (mentions.ids[0] ?? first);
      const host =
        target._tag === "conversation"
          ? target.botId
          : room?._tag === "room"
            ? (addressed ?? null)
            : null;
      if (host !== null)
        replyLater(
          host,
          key,
          "Noted. This is the sample team, so nothing really runs, but the message is here.",
        );
    },
    answerQuestion: (entryId, answers) =>
      answer(
        entryId,
        (e) => (e._tag === "question" ? { ...e, status: { _tag: "answered", answers } } : e),
        "Thanks, I’ll take it from here.",
      ),
    dismissQuestion: (entryId) =>
      answer(
        entryId,
        (e) => (e._tag === "question" ? { ...e, status: { _tag: "dismissed" } } : e),
        "Understood, I’ll leave it as it is.",
      ),
    decideApproval: (entryId, decision) =>
      answer(
        entryId,
        (e) => (e._tag === "approval" ? { ...e, status: { _tag: "decided", decision } } : e),
        decision === "deny"
          ? "Okay, I won’t run it."
          : "Done. Every invoice on staging has its total now.",
      ),
    // The value is dropped here: the sample has no engine to hand it to.
    provideSecret: (entryId) =>
      answer(
        entryId,
        (e) => (e._tag === "secret-request" ? { ...e, status: "provided" } : e),
        "Got it, searching trains now.",
      ),
    declineSecret: (entryId) =>
      answer(
        entryId,
        (e) => (e._tag === "secret-request" ? { ...e, status: "declined" } : e),
        "No problem. I’ll use the timetables the rail operators publish instead.",
      ),
    answerBrowserHelp: (entryId, outcome) =>
      answer(
        entryId,
        (e) => (e._tag === "browser-help" ? { ...e, status: { _tag: outcome } } : e),
        outcome === "done"
          ? "Thanks, I’m in. The inspection is booked for Thursday at 3:30."
          : "No problem. I’ll call the garage to book it instead.",
      ),
    // The sample has no browser to open.
    openBrowser: nothing,
    // Neither wakes the bot, which says nothing.
    dismissLogin: (entryId) =>
      update((s) =>
        updateEntry(s, entryId, (e) =>
          e._tag === "credential-request" ? { ...e, status: { _tag: "dismissed" } } : e,
        ),
      ),
    retryNotice: (entryId) =>
      update((s) =>
        updateEntry(s, entryId, (e) => (e._tag === "notice" ? { ...e, retryable: false } : e)),
      ),
    retryMessage: (entryId) =>
      inFlight(entryId, (e) =>
        e._tag === "message" ? { ...e, delivery: { _tag: "pending" } } : e,
      ),
    stopBot: (botId) => update((s) => updateBot(s, botId, setState({ _tag: "idle" }))),
    setBrowser: (bot, enabled) =>
      update((s) => updateBot(s, bot.id, (current) => ({ ...current, browser: enabled }))),
    setVault: (bot, enabled) =>
      update((s) => updateBot(s, bot.id, (current) => ({ ...current, vault: enabled }))),
    // The sample's members work only for the room, so its Stop ends whatever they run.
    stopRoom: (roomId) =>
      update((s) => {
        const found = s.roster.find((i) => i._tag === "room" && i.room.id === roomId);
        const members = found?._tag === "room" ? found.room.members : [];
        return members.reduce(
          (next, botId) =>
            updateBot(next, botId, (bot) =>
              bot.state._tag === "thinking" || bot.state._tag === "working"
                ? setState({ _tag: "idle" })(bot)
                : bot,
            ),
          updateRoom(s, roomId, (room) =>
            room.status === "active" ? { ...room, work: "none" } : room,
          ),
        );
      }),
    setRoutineEnabled: (routineId, enabled) =>
      update((s) => ({
        ...s,
        routines: Object.fromEntries(
          Object.entries(s.routines).map(([botId, list]) => [
            botId,
            list.map((r) =>
              r.id === routineId ? { ...r, enabled, nextRunAt: enabled ? r.nextRunAt : null } : r,
            ),
          ]),
        ),
      })),
    createBot: ({ name, primary, avatar }) => {
      // As on a server: with no model to give the bot, it is refused.
      if (!hasDefaultModel(get().engine)) {
        return Promise.resolve({
          _tag: "failed",
          failure: { _tag: "refused", error: new Invalid({ reason: "model" }) },
        });
      }
      const botId = BotId.make(`local-bot-${++created}`);
      const key = `bot:${botId}`;
      // As on a server: the bot opens its conversation once a provider can run it.
      const canSpeak = providerGate(get().engine)._tag === "ready";
      update((s) => {
        const taken = s.roster.flatMap((row) =>
          row._tag === "bot" ? [row.bot.profile.avatar] : [],
        );
        const bot: Bot = {
          id: botId,
          profile: {
            name,
            title: "",
            avatar: avatar ?? freeAvatar(taken),
            job: "",
          },
          model: {
            providerId: ProviderId.make("claude-code"),
            modelId: ModelId.make("claude-sonnet-5-5"),
          },
          permissionMode: "supervised",
          primary,
          browser: false,
          vault: false,
          pinned: false,
          hidden: false,
          sectionId: null,
          state: canSpeak
            ? { _tag: "thinking", since: now(), stalled: false, quietSince: null }
            : { _tag: "idle" },
          settingsHeld: false,
          opening: true,
          createdAt: now(),
        };
        return {
          ...s,
          roster: [
            ...s.roster,
            { _tag: "bot", bot, lastEntry: null, lastActivityAt: null, unread: false },
          ],
        };
      });
      if (canSpeak) {
        window.setTimeout(() => {
          update((s) => {
            const spoken = updateBot(
              withEntries(s, key, (es) =>
                appended(
                  es,
                  message(
                    { _tag: "bot", botId },
                    `Hi, I’m ${name}. What would you like me to take care of first?`,
                  ),
                ),
              ),
              botId,
              setState({ _tag: "idle" }),
            );
            return {
              ...spoken,
              roster: spoken.roster.map((item) =>
                item._tag === "bot" && item.bot.id === botId
                  ? { ...item, bot: { ...item.bot, opening: false } }
                  : item,
              ),
            };
          });
        }, OPENING_DELAY);
      }
      return Promise.resolve({ _tag: "done", value: botId });
    },
    deleteBot: (botId) =>
      update((s) => ({
        ...s,
        roster: s.roster.filter((item) => !(item._tag === "bot" && item.bot.id === botId)),
      })),
    updateSettings: (change) =>
      update((s) =>
        change.section === "profile"
          ? {
              ...s,
              settings: { ...s.settings, ...change.changes },
              settingsSaves: {
                ...s.settingsSaves,
                profile: { _tag: "saved", changes: change.changes },
              },
            }
          : {
              ...s,
              settings: {
                ...s.settings,
                notifications: { ...s.settings.notifications, ...change.changes },
              },
              settingsSaves: {
                ...s.settingsSaves,
                notifications: { _tag: "saved", changes: change.changes },
              },
            },
      ),
    setSettingsOpen: (open) => update((s) => ({ ...s, settingsOpen: open })),
    startPairing: () =>
      Promise.resolve({
        _tag: "started",
        code: PairingCode.make("7KQ2M9XH4D"),
        expiresAt: DateTime.makeUnsafe(Date.now() + 5 * 60_000),
        origins: [
          ServerOrigin.make("http://192.0.2.10:3737"),
          ServerOrigin.make("http://100.64.0.7:3737"),
        ],
      }),
    revokeDevice: (deviceId) => {
      update((s) => ({ ...s, devices: s.devices.filter((device) => device.id !== deviceId) }));
      return Promise.resolve(true);
    },
    // Screens for these come later; the sample has nothing to show for them yet.
    resendMessage: nothing,
    discardMessage: nothing,
    openWorkFold: nothing,
    closeWorkFold: nothing,
    openAttachment: nothing,
    openRoutine: nothing,
    openConversation: nothing,
    openMemoryFile: nothing,
    loadOlder: nothing,
    loadOlderPair: nothing,
    // Every sample message is held: the one a card names is found at once.
    revealInPair: (botIds, entryId) =>
      Promise.resolve(
        messagesOf(get(), botIds).find(
          (message) => message.sentEntryId === entryId || message.receivedEntryId === entryId,
        )?.seq ?? null,
      ),
    markRead: nothing,
    markRosterRead: (target) => update((s) => withUnread(s, target, false)),
    markUnread: (target) => update((s) => withUnread(s, target, true)),
    placeBot: (botId, { primary, ...placement }) =>
      update((s) => ({
        ...s,
        roster: s.roster.map((item) => {
          if (item._tag !== "bot") return item;
          if (item.bot.id === botId)
            return { ...item, bot: { ...item.bot, ...placement, ...(primary ? { primary } : {}) } };
          // One primary bot at a time: making another one primary replaces it.
          return primary && item.bot.primary
            ? { ...item, bot: { ...item.bot, primary: false } }
            : item;
        }),
      })),
    pinRoom: (roomId, pinned) =>
      update((s) => updateRoom(s, roomId, (room) => ({ ...room, pinned }))),
    createSection: (name, botId) => {
      const id = SectionId.make(`local-section-${++created}`);
      update((s) => {
        const made = { ...s, sections: [...s.sections, { id, name }] };
        return botId === null ? made : updateBot(made, botId, (bot) => ({ ...bot, sectionId: id }));
      });
      return Promise.resolve(id);
    },
    updateSection: (sectionId, { name, before }) =>
      update((s) => {
        const renamed = s.sections.map((section) =>
          section.id === sectionId && name !== undefined ? { ...section, name } : section,
        );
        return {
          ...s,
          sections: before === undefined ? renamed : placedSection(renamed, sectionId, before),
        };
      }),
    // Its bots stay, in no section.
    deleteSection: (sectionId) =>
      update((s) => ({
        ...s,
        sections: s.sections.filter((section) => section.id !== sectionId),
        roster: s.roster.map((item) =>
          item._tag === "bot" && item.bot.sectionId === sectionId
            ? { ...item, bot: { ...item.bot, sectionId: null } }
            : item,
        ),
      })),
    setShown: nothing,
    newBot: nothing,
    newBotFromTemplate: nothing,
    shareBotTemplate: nothing,
    // The room form belongs to the client runtime's source; the sample has no dialog for it.
    newRoom: nothing,
    startRoomWith: nothing,
    editRoom: nothing,
    archiveRoom: (roomId) => {
      update((s) =>
        updateRoom(s, roomId, (room) =>
          room.status === "archived" ? room : { ...room, status: "archived", archivedAt: now() },
        ),
      );
      return Promise.resolve();
    },
    unarchiveRoom: (roomId) => {
      update((s) =>
        updateRoom(s, roomId, (room) =>
          room.status === "active" || room.members.length < 2
            ? room
            : {
                id: room.id,
                name: room.name,
                pinned: room.pinned,
                createdAt: room.createdAt,
                status: "active",
                members: room.members,
                work: "none",
              },
        ),
      );
      return Promise.resolve();
    },
    deleteRoom: (roomId) =>
      update((s) => ({
        ...s,
        roster: s.roster.filter((item) => !(item._tag === "room" && item.room.id === roomId)),
      })),
    editProfile: nothing,
    freshStart: nothing,
    refreshSettings: nothing,
    signOutBrowser: () => Promise.resolve(true),
    vault,
    refreshDevices: nothing,
    loadMoreTurns: nothing,
    retryTurns: nothing,
    signOut: () => Promise.resolve(true),
  };
}

/** The sample messages between the two bots of `botIds`, oldest first. */
const messagesOf = (state: State, botIds: PairBotIds): ReadonlyArray<TeammateMessage> =>
  state.pairMessages.find((messages) => {
    const first = messages[0];
    return first !== undefined && inPair(botIds, first.from) && inPair(botIds, first.to);
  }) ?? [];

function toData(state: State, vault: VaultView): ShellData {
  return {
    engine: state.engine,
    engineStale: false,
    signIns: new Map(),
    roster: state.roster,
    sections: state.sections,
    conversation: (target) => ({
      phase: "ready",
      items: state.entries[keyOf(target)] ?? [],
      hasOlder: false,
      loadingOlder: false,
    }),
    pairs: state.pairs,
    pair: (botIds) => ({
      phase: "ready",
      messages: messagesOf(state, botIds),
      hasOlder: false,
      loadingOlder: false,
    }),
    draft: (target) => state.drafts[keyOf(target)] ?? blankDraft,
    // The sample is one tab: nothing else replaces its drafts, or pairs anew.
    offer: () => null,
    draftsLoading: false,
    draftsFailed: false,
    draftNotSaved: () => false,
    submitting: (entryId) => state.inFlight.has(entryId),
    workSteps: (entryId) => state.workSteps[entryId] ?? null,
    routines: (botId) => state.routines[botId] ?? [],
    files: (botId) => state.files[botId] ?? [],
    memory: (botId) => state.memory[botId] ?? [],
    connectors: state.connectors,
    settings: state.settings,
    settingsSaves: state.settingsSaves,
    settingsOpen: state.settingsOpen,
    devices: state.devices,
    recentTurns: {
      read: { _tag: "ready", value: state.recentTurns, stale: false },
      loadingMore: false,
      failed: false,
    },
    connected: true,
    signInUnencrypted: false,
    vault,
  };
}

/**
 * The sample team, with intents that change it. Each call keeps its own copy.
 * `firstRun` starts it with no bots, at the first-run screen; `engine`, when
 * given, replaces the team's engine.
 */
export function useSampleSource({
  firstRun = false,
  engine,
}: { firstRun?: boolean; engine?: EngineStatus } = {}): ShellSource & {
  /** The dialogs the source holds over the shell: the connectors screen. */
  readonly overlays: ReactNode;
} {
  const [store] = useState(() => {
    const team: State = {
      ...sampleTeam(SAMPLE_NOW),
      inFlight: new Set(),
      drafts: {},
      settingsSaves: { profile: { _tag: "idle" }, notifications: { _tag: "idle" } },
      settingsOpen: false,
      connectors: sampleConnectors,
      connectorsOpening: null,
    };
    const started = firstRun ? withoutBots(team) : team;
    return createStore(engine === undefined ? started : { ...started, engine });
  });
  // A login saved from a card closes it as the server would.
  const [vault] = useState(() =>
    sampleVault({
      state: firstRun ? "uninitialized" : "locked",
      now,
      onSaved: (request, credential) =>
        store.update((s) =>
          updateEntry(s, request, (e) =>
            e._tag === "credential-request"
              ? {
                  ...e,
                  status: { _tag: "saved", credentialId: credential.id, name: credential.name },
                }
              : e,
          ),
        ),
    }),
  );
  const state = useSyncExternalStore(store.subscribe, store.get);
  const vaultView = useSyncExternalStore(vault.view.subscribe, vault.view.get);
  const intents = useMemo(() => sampleIntents(store, vault), [store, vault]);
  const connectorsIntents = useMemo(
    () => ({
      ...sampleConnectorsIntents({
        get: () => store.get().connectors,
        change: (upsert, remove) =>
          store.update((s) => ({
            ...s,
            connectors: applyConnectorChange(s.connectors, upsert, remove),
          })),
      }),
      // As the live source: Settings opens over the connectors, which wait as they were.
      openVault: () => store.update((s) => ({ ...s, settingsOpen: true })),
    }),
    [store],
  );
  // Scout shops in its browser.
  const [browser] = useState(() => sampleBrowser([ids.scout]));
  return {
    data: toData(state, vaultView),
    intents,
    browser,
    overlays: (
      <ConnectorsDialog
        opening={state.connectorsOpening}
        aside={state.settingsOpen}
        connectors={state.connectors}
        bots={botsOf(state)}
        connected
        intents={connectorsIntents}
        onClose={() => store.update((s) => ({ ...s, connectorsOpening: null }))}
      />
    ),
  };
}

/**
 * Development's stand-in for the server: the sample team, and a clock held at
 * the sample's moment so its times read as they were written.
 */
export function SampleSourceProvider({ children }: { children: ReactNode }) {
  const { overlays, ...source } = useSampleSource();
  // An image the operator attached here shows as it would from a server.
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const intents: ShellIntents = {
    ...source.intents,
    openAttachment: (attachment) => {
      if (showsImage(attachment) && attached.has(attachment.id)) setViewing(attachment);
    },
  };
  return (
    <ClockProvider now={SAMPLE_NOW}>
      <ShellSourceProvider source={{ ...source, intents }}>
        <AttachmentImagesProvider
          fetch={(attachment) => Promise.resolve(attached.get(attachment.id) ?? null)}
        >
          {children}
          {overlays}
          <ImageViewer attachment={viewing} onClose={() => setViewing(null)} onSave={() => {}} />
          {overlays}
        </AttachmentImagesProvider>
      </ShellSourceProvider>
    </ClockProvider>
  );
}
