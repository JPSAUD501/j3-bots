// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The sample team as a shell source that responds: messages are added, cards
 * are decided, bots answer after a moment. A stand-in for the client runtime
 * in development only; nothing here reaches a server.
 */
import type { BotCardIntents } from "../components/BotCard";
import type { ProviderActions } from "../components/ProviderFix";
import type {
  Draft,
  DraftFile,
  SecretsHandle,
  SecretsView,
  SettingsSaves,
} from "@j3-bots/client-runtime";
import {
  applyConnectorChange,
  type ConnectorsPlace,
  fittedMarks,
  hasDefaultModel,
  inPair,
  insertMarks,
  placedMessage,
  providerGate,
  ROOM_MEMBERS,
  type SettingsPage,
  showsImage,
  withoutMarks,
  withQuote,
} from "@j3-bots/client-runtime/presentation";
import {
  type Attachment,
  AttachmentId,
  BotId,
  EntryId,
  Invalid,
  ModelId,
  PairingCode,
  ProviderId,
  SectionId,
  ServerOrigin,
  type Bot,
  type BotState,
  type Connector,
  type Skill,
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
import { useI18n } from "../app/context";
import { documentKind } from "@j3-bots/client-runtime/documents";
import { AttachmentImagesProvider, type ImageSource } from "../components/attachmentImages";
import { galleryImage } from "./workImages";
import { ConnectorsDialog } from "../components/connectors/ConnectorsDialog";
import { ImageViewer } from "../components/ImageViewer";
import { DocumentsProvider } from "../components/documents/documents";
import { DocumentViewer } from "../components/documents/DocumentViewer";
import { sampleDocumentBytes } from "./sampleDocuments";
import type { ShellData, ShellIntents } from "../shell/data";
import { sampleConnectorAppAccess } from "./sampleConnectorApps";
import { ShellSourceProvider, type ShellSource } from "../shell/source";
import { ordered, previewOf, type DraftEntry, withOwnReaction } from "./entries";
import { ids, SAMPLE_NOW, sampleTeam, type SampleTeam } from "./sample";
import { sampleSentEvents } from "./usageData";
import { sampleBrowser } from "./sampleBrowser";
import { copySample, sampleSecrets } from "./sampleSecrets";
import { sampleVoice } from "./sampleVoice";
import { galleryVariants } from "./variants";
import {
  SAMPLE_ASKED_CONNECTOR,
  sampleConnectors,
  sampleConnectorsIntents,
  sampleOwnAppSetup,
  samplePromptIntents,
} from "./sampleConnectors";
import { sampleSkills, sampleSkillsIntents } from "./sampleSkills";
import { sampleTrackCommand } from "./sampleRoutineTrack";
import { whatsNewViews } from "./updates";

interface State extends Omit<SampleTeam, "bots" | "room" | "attachments"> {
  /** Cards whose answer is on its way, as it would be to a server. */
  readonly inFlight: ReadonlySet<EntryId>;
  /** Each conversation's unsent text and files, by `keyOf`. */
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly settingsSaves: SettingsSaves;
  readonly settingsOpen: boolean;
  readonly settingsPage: SettingsPage | null;
  readonly connectors: ReadonlyArray<Connector>;
  readonly skills: ReadonlyArray<Skill>;
  /** The connectors screen, and what opened it; null while it is closed. */
  readonly connectorsOpening: ConnectorsPlace | null;
}

/** Provider actions as the gallery takes them: done at once, changing nothing. */
export const sampleProviderActions: ProviderActions = {
  recheck: () => Promise.resolve(true),
  update: () => Promise.resolve(true),
  install: () => Promise.resolve(true),
  cancelInstall: () => Promise.resolve(true),
};

const blankDraft: Draft = { text: "", mentions: [], quotes: [], files: [], sending: false };

/** How long a new bot takes to say hello, from its creation. */
const OPENING_DELAY = 3200;

/** How long each message of the hello takes after the one before: the server's pause, about. */
const HELLO_PAUSE = 1800;

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

function sampleIntents({ get, update }: Store, secrets: SecretsHandle): ShellIntents {
  /** The bot thinks for a moment, then says `text` in `key`. */
  const replyLater = (botId: BotId, key: string, text: string) => {
    update((s) =>
      updateBot(
        s,
        botId,
        setState({
          _tag: "thinking",
          since: now(),
          stalled: false,
          typing: false,
          retrying: false,
        }),
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
  /** Each room's latest round: a newer one, or a Stop, ends what an older one had left to do. */
  const rounds = new Map<RoomId, number>();
  const nextRound = (roomId: RoomId) => {
    const round = (rounds.get(roomId) ?? 0) + 1;
    rounds.set(roomId, round);
    return round;
  };
  /** The room's Stop: the sample's members work only for the room, so it ends whatever they run. */
  const stopSampleRoom = (roomId: RoomId) => {
    nextRound(roomId);
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
          room.status === "active"
            ? { ...room, work: "none", answering: [], forceStop: false }
            : room,
        ),
      );
    });
  };
  /**
   * A room message as the server takes one: the members it mentions start at
   * once, or every member when it mentions nobody or everyone. Those it
   * mentions, or everyone, each reply; with no mention the first two reply,
   * as if they had something to add, and the rest end without a word. The
   * room says who is still answering.
   */
  const roomRound = (roomId: RoomId, key: string, mentions: Mentions | undefined) => {
    const found = get().roster.find((i) => i._tag === "room" && i.room.id === roomId);
    if (found?._tag !== "room" || found.room.status !== "active") return;
    const round = nextRound(roomId);
    const members = found.room.members;
    const named = mentions?._tag === "bots" && mentions.ids.length > 0 ? mentions.ids : null;
    const woken = named ?? members;
    const speakers = named ?? (mentions?._tag === "everyone" ? members : members.slice(0, 2));
    const working = (botIds: ReadonlyArray<BotId>, state: BotState) => (s: State) =>
      botIds.reduce((next, botId) => updateBot(next, botId, setState(state)), s);
    /** The room with these members answering in it, or without them. */
    const answering = (s: State, change: (now: ReadonlyArray<BotId>) => ReadonlyArray<BotId>) =>
      updateRoom(s, roomId, (room) => {
        if (room.status !== "active") return room;
        const next = change(room.answering);
        return { ...room, work: next.length > 0 ? "running" : "none", answering: next };
      });
    /** These members' turns end, unless the round is over; `reply` is what one of them said. */
    const ends = (
      botIds: ReadonlyArray<BotId>,
      reply?: { readonly botId: BotId; readonly text: string },
    ) => {
      if (rounds.get(roomId) !== round) return;
      update((s) => {
        const said =
          reply === undefined
            ? s
            : withEntries(s, key, (es) =>
                appended(es, message({ _tag: "bot", botId: reply.botId }, reply.text)),
              );
        return answering(working(botIds, { _tag: "idle" })(said), (now) =>
          now.filter((id) => !botIds.includes(id)),
        );
      });
    };
    const replies = [
      "Noted. This is the sample team, so nothing really runs, but the message is here.",
      "I read it too, and I’ll pick up what is mine in it.",
      "Same here: I have it, and I’ll say so when there is more.",
    ] as const;
    // Those an earlier round left at work and this one does not wake stop with it.
    const left = found.room.answering.filter((id) => !woken.includes(id));
    update((s) =>
      answering(
        working(woken, {
          _tag: "thinking",
          since: now(),
          stalled: false,
          typing: false,
          retrying: false,
        })(working(left, { _tag: "idle" })(s)),
        () => woken,
      ),
    );
    window.setTimeout(() => ends(woken.filter((id) => !speakers.includes(id))), 1500);
    speakers.forEach((botId, index) => {
      const text = replies[index % replies.length] ?? replies[0];
      window.setTimeout(() => ends([botId], { botId, text }), 2500 * (index + 1));
    });
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

  const openConnectors = (opening: ConnectorsPlace) =>
    // A screen put aside under Settings comes back as it was, with what opened it.
    update((s) => ({
      ...s,
      settingsOpen: false,
      connectorsOpening: s.connectorsOpening ?? opening,
    }));

  return {
    connectorApp: sampleConnectorAppAccess,
    openConnectors,
    signInConnector: (entry) =>
      openConnectors({ _tag: "connector", connectorId: entry.connectorId, signIn: true }),
    routineCard: (entryId, _name, command) =>
      inFlight(entryId, (e) =>
        e._tag === "routine-run" ? { ...e, run: sampleTrackCommand(e.run, command) } : e,
      ),
    answerConnectorInput: (entryId, answer) =>
      inFlight(entryId, (e) =>
        e._tag === "connector-input"
          ? { ...e, status: { _tag: "answered", action: answer._tag } }
          : e,
      ),
    openConnectorPage: () => {},
    connectorAskSetup: sampleOwnAppSetup,
    // The sample adds nothing: a yes reads as added.
    allowConnectorAsk: (entryId) =>
      inFlight(entryId, (e) =>
        e._tag === "connector-ask"
          ? { ...e, status: { _tag: "added", connectorId: SAMPLE_ASKED_CONNECTOR } }
          : e,
      ),
    declineConnectorAsk: (entryId) =>
      inFlight(entryId, (e) =>
        e._tag === "connector-ask" ? { ...e, status: { _tag: "declined" } } : e,
      ),
    connectorPrompts: (botId) =>
      samplePromptIntents
        .prompts(botId)
        .then((result) => (result._tag === "done" ? result.value : null)),
    renderPrompt: (botId, prompt, given) =>
      samplePromptIntents
        .renderPrompt({
          botId,
          connectorId: prompt.connectorId,
          name: prompt.name,
          arguments: given,
        })
        .then((result) => (result._tag === "done" ? result.value : null)),
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
    quoteInDraft: (target, quote) => {
      const quotes = withQuote((get().drafts[keyOf(target)] ?? blankDraft).quotes, quote);
      if (quotes === "full") return "full";
      changeDraft(target, (draft) => ({ ...draft, quotes }));
      return "added";
    },
    unquoteInDraft: (target, index) =>
      changeDraft(target, (draft) => ({ ...draft, quotes: draft.quotes.toSpliced(index, 1) })),
    restoreDraft: nothing,
    retryDrafts: () => Promise.resolve(true),
    dismissDraftOffer: nothing,
    sendDraft: (target, addressing) => {
      const mentions =
        addressing !== undefined && "mentions" in addressing ? addressing.mentions : undefined;
      const named =
        addressing !== undefined && "conversationMentions" in addressing
          ? addressing.conversationMentions
          : [];
      const key = keyOf(target);
      const draft = get().drafts[key] ?? blankDraft;
      const { text, offsets } = placedMessage(draft.text);
      const attachments = draft.files.flatMap((file) =>
        file._tag === "ready" ? [file.attachment] : [],
      );
      if (text === "" && attachments.length === 0) return;
      update((s) => ({
        ...withEntries(s, key, (es) =>
          appended(es, {
            ...message(
              { _tag: "operator" },
              text,
              attachments,
              mentions,
              attachments.length === 0 ? undefined : offsets,
            ),
            ...(named.length === 0 ? {} : { conversationMentions: named }),
            ...(draft.quotes.length === 0 ? {} : { quotes: draft.quotes }),
          }),
        ),
        drafts: { ...s.drafts, [key]: blankDraft },
      }));
      if (target._tag === "room") {
        roomRound(target.roomId, key, mentions);
        return;
      }
      replyLater(
        target.botId,
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
    declineSecretAsk: (entryId) =>
      answer(
        entryId,
        (e) => (e._tag === "secret-ask" ? { ...e, status: { _tag: "declined" } } : e),
        "Understood. I’ll ask the inspection office to change the booking by phone.",
      ),
    retryNotice: (entryId) =>
      update((s) =>
        updateEntry(s, entryId, (e) => (e._tag === "notice" ? { ...e, retryable: false } : e)),
      ),
    retryMessage: (entryId) =>
      inFlight(entryId, (e) =>
        e._tag === "message" ? { ...e, delivery: { _tag: "pending" } } : e,
      ),
    react: (entryId, emoji) =>
      update((s) =>
        updateEntry(s, entryId, (e) =>
          e._tag === "message" && e.reactions !== undefined
            ? { ...e, reactions: withOwnReaction(e.reactions, emoji) }
            : e,
        ),
      ),
    stopBot: (botId) => update((s) => updateBot(s, botId, setState({ _tag: "idle" }))),
    forceStopBot: (botId) =>
      update((s) =>
        updateBot(s, botId, (bot) => ({ ...bot, state: { _tag: "idle" }, forceStop: false })),
      ),
    setBrowser: (bot, enabled) =>
      update((s) => updateBot(s, bot.id, (current) => ({ ...current, browser: enabled }))),
    stopRoom: (roomId) => stopSampleRoom(roomId),
    forceStopRoom: (roomId) => stopSampleRoom(roomId),
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
    createBot: ({ name, title, primary, hidden, avatar }) => {
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
            title,
            avatar: avatar ?? freeAvatar(taken),
            job: "",
          },
          model: {
            providerId: ProviderId.make("claude-code"),
            modelId: ModelId.make("claude-sonnet-5-5"),
          },
          effort: null,
          permissionMode: "supervised",
          primary,
          browser: true,
          pinned: false,
          hidden: hidden ?? false,
          sectionId: null,
          state: canSpeak
            ? {
                _tag: "thinking",
                since: now(),
                stalled: false,
                typing: false,
                retrying: false,
              }
            : { _tag: "idle" },
          settingsHeld: false,
          forceStop: false,
          opening: true,
          suggestedReply: null,
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
        // A first contact, as a server paces it: each message a moment after
        // the one before, the bot shown typing between them.
        const hello = [
          `Hi! I’m ${name}, and I’m here to take things off your plate.`,
          "I can sort out your files and folders, look things up and sum them up for you, or remind you of what’s coming.",
          "What should I call you?",
        ];
        const typing = setState({
          _tag: "thinking",
          since: now(),
          stalled: false,
          typing: true,
          retrying: false,
        });
        hello.forEach((text, index) => {
          const last = index === hello.length - 1;
          window.setTimeout(
            () => {
              update((s) => {
                const spoken = updateBot(
                  withEntries(s, key, (es) => appended(es, message({ _tag: "bot", botId }, text))),
                  botId,
                  last ? setState({ _tag: "idle" }) : typing,
                );
                return last
                  ? {
                      ...spoken,
                      roster: spoken.roster.map((item) =>
                        item._tag === "bot" && item.bot.id === botId
                          ? { ...item, bot: { ...item.bot, opening: false } }
                          : item,
                      ),
                    }
                  : spoken;
              });
            },
            OPENING_DELAY + index * HELLO_PAUSE,
          );
        });
      }
      return Promise.resolve({ _tag: "done", value: botId });
    },
    deleteBot: (botId) =>
      update((s) => ({
        ...s,
        roster: s.roster.filter((item) => !(item._tag === "bot" && item.bot.id === botId)),
      })),
    updateSettings: (change) =>
      update((s): State => {
        switch (change.section) {
          case "profile":
            return {
              ...s,
              settings: { ...s.settings, ...change.changes },
              settingsSaves: {
                ...s.settingsSaves,
                profile: { _tag: "saved", changes: change.changes },
              },
            };
          case "notifications":
            return {
              ...s,
              settings: {
                ...s.settings,
                notifications: { ...s.settings.notifications, ...change.changes },
              },
              settingsSaves: {
                ...s.settingsSaves,
                notifications: { _tag: "saved", changes: change.changes },
              },
            };
          case "harnesses":
            return {
              ...s,
              settings: { ...s.settings, ...change.changes },
              settingsSaves: {
                ...s.settingsSaves,
                harnesses: { _tag: "saved", changes: change.changes },
              },
            };
          case "voice":
            return {
              ...s,
              settings: {
                ...s.settings,
                voice:
                  s.settings.voice === null ? null : { ...s.settings.voice, ...change.changes },
              },
              settingsSaves: {
                ...s.settingsSaves,
                voice: { _tag: "saved", changes: change.changes },
              },
            };
          case "usage-data":
            return {
              ...s,
              settings: {
                ...s.settings,
                telemetry: {
                  enabled: change.changes.enabled,
                  heldOff: s.settings.telemetry?.heldOff ?? false,
                },
              },
              settingsSaves: {
                ...s.settingsSaves,
                "usage-data": { _tag: "saved", changes: change.changes },
              },
            };
        }
      }),
    setSettingsOpen: (open) => update((s) => ({ ...s, settingsOpen: open })),
    showSettingsPage: (page) => update((s) => ({ ...s, settingsPage: page })),
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
    openWorkImage: nothing,
    openRoutine: nothing,
    openConversation: nothing,
    openMemoryFile: nothing,
    loadOlder: nothing,
    // Every sample entry is held: a quoted one shows at once, or was deleted.
    revealEntry: (target, entryId) =>
      Promise.resolve(
        (get().entries[keyOf(target)] ?? []).some((entry) => entry.id === entryId)
          ? "shown"
          : "missing",
      ),
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
    placeRoom: (roomId, placement) =>
      update((s) => updateRoom(s, roomId, (room) => ({ ...room, ...placement }))),
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
    // As a draft is sent: the message lands in the bot's conversation, which answers it.
    sendQuickMessage: ({ target, text }) => {
      const sent = message({ _tag: "operator" }, text);
      const key = keyOf(target);
      update((s) => withEntries(s, key, (es) => appended(es, sent)));
      if (target._tag === "conversation") {
        replyLater(
          target.botId,
          key,
          "Noted. This is the sample team, so nothing really runs, but the message is here.",
        );
      }
      return Promise.resolve({ _tag: "done", value: sent.id });
    },
    setCardBot: nothing,
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
          room.status === "active" || room.members.length < ROOM_MEMBERS.min
            ? room
            : {
                id: room.id,
                name: room.name,
                pinned: room.pinned,
                hidden: room.hidden,
                createdAt: room.createdAt,
                status: "active",
                members: room.members,
                work: "none",
                forceStop: false,
                answering: [],
                memberWork: [],
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
    usageData: { sent: () => Promise.resolve(sampleSentEvents), record: () => {} },
    providerActions: sampleProviderActions,
    whatsNew: { view: whatsNewViews.opened, open: () => {} },
    secrets: { ...secrets, copy: copySample },
    voice: sampleVoice,
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

function toData(state: State, secrets: SecretsView): ShellData {
  return {
    engine: state.engine,
    engineStale: false,
    signIns: new Map(),
    roster: state.roster,
    sections: state.sections,
    conversationMentions: true,
    quotes: true,
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
    settingsPage: state.settingsPage,
    devices: state.devices,
    recentTurns: {
      read: { _tag: "ready", value: state.recentTurns, stale: false },
      loadingMore: false,
      failed: false,
    },
    connected: true,
    signInUnencrypted: false,
    secrets,
  };
}

/** A bot's card over the sample team, outside the shell: it sends, and opens nothing. */
export const sampleCardIntents = (source: ShellSource): BotCardIntents => ({
  talk: () => {},
  startRoom: () => {},
  openRoutines: () => {},
  openDetails: () => {},
  send: source.intents.sendQuickMessage,
  routines: source.data.routines,
  showing: () => {},
});

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
      settingsSaves: {
        profile: { _tag: "idle" },
        notifications: { _tag: "idle" },
        harnesses: { _tag: "idle" },
        voice: { _tag: "idle" },
        "usage-data": { _tag: "idle" },
      },
      settingsOpen: false,
      settingsPage: null,
      connectors: sampleConnectors,
      skills: sampleSkills,
      connectorsOpening: null,
    };
    const started = firstRun ? withoutBots(team) : team;
    return createStore(engine === undefined ? started : { ...started, engine });
  });
  // A secret saved from a bot's ask closes its card as the server would.
  const [secrets] = useState(() =>
    sampleSecrets({
      state: "ready",
      secrets: firstRun ? [] : galleryVariants(SAMPLE_NOW).savedSecrets,
      now,
      onSaved: (request) =>
        store.update((s) =>
          updateEntry(s, request, (e) =>
            e._tag === "secret-ask" ? { ...e, status: { _tag: "saved" } } : e,
          ),
        ),
    }),
  );
  const state = useSyncExternalStore(store.subscribe, store.get);
  const secretsView = useSyncExternalStore(secrets.view.subscribe, secrets.view.get);
  const intents = useMemo(() => sampleIntents(store, secrets), [store, secrets]);
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
      openSecrets: () =>
        store.update((s) => ({ ...s, settingsOpen: true, settingsPage: "secrets" })),
    }),
    [store],
  );
  const skillsIntents = useMemo(
    () =>
      sampleSkillsIntents({
        get: () => store.get().skills,
        set: (skills) => store.update((s) => ({ ...s, skills })),
      }),
    [store],
  );
  // Scout shops in its browser.
  const [browser] = useState(() => sampleBrowser([ids.scout]));
  return {
    data: toData(state, secretsView),
    intents,
    browser,
    overlays: (
      <ConnectorsDialog
        opening={state.connectorsOpening}
        aside={state.settingsOpen}
        connectors={state.connectors}
        bots={botsOf(state)}
        skills={state.skills}
        connected
        intents={connectorsIntents}
        skillsIntents={skillsIntents}
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
  const { locale } = useI18n();
  // An image or a document the operator attached here shows as it would from a server.
  const [viewing, setViewing] = useState<ImageSource | null>(null);
  const [reading, setReading] = useState<Attachment | null>(null);
  const intents: ShellIntents = {
    ...source.intents,
    openAttachment: (attachment) => {
      if (showsImage(attachment) && attached.has(attachment.id)) {
        setViewing({ _tag: "file", attachment });
      } else if (documentKind(attachment) !== null) {
        setReading(attachment);
      }
    },
    openWorkImage: (id) => setViewing({ _tag: "work", id }),
  };
  // A file the operator attached here, else one of the sample's own.
  const documentBytes = (attachment: Attachment) => {
    const blob = attached.get(attachment.id);
    return blob === undefined
      ? sampleDocumentBytes(attachment)
      : blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  };
  return (
    <ClockProvider now={SAMPLE_NOW}>
      <ShellSourceProvider source={{ ...source, intents }}>
        <AttachmentImagesProvider
          fetch={(image) =>
            image._tag === "file"
              ? Promise.resolve(attached.get(image.attachment.id) ?? null)
              : galleryImage(image)
          }
        >
          <DocumentsProvider key={locale} fetch={documentBytes} locale={locale}>
            {children}
            {overlays}
            <ImageViewer image={viewing} onClose={() => setViewing(null)} onSave={() => {}} />
            <DocumentViewer
              attachment={reading}
              onClose={() => setReading(null)}
              onSave={() => {}}
            />
          </DocumentsProvider>
        </AttachmentImagesProvider>
      </ShellSourceProvider>
    </ClockProvider>
  );
}
