// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The sample team as a shell source that responds: messages are added, cards
 * are decided, bots answer after a moment. A stand-in for the client runtime
 * in development only; nothing here reaches a server.
 */
import type { Draft, DraftFile, SettingsSave } from "@j3-bots/client-runtime";
import {
  AttachmentId,
  BotId,
  EntryId,
  ModelId,
  PairingCode,
  ProviderId,
  type Bot,
  type BotState,
  type Entry,
  type EntryTarget,
  type RosterItem,
} from "@j3-bots/contracts";
import { avatarShapeNames, botColors } from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ClockProvider } from "../app/context";
import type { ShellData, ShellIntents } from "../shell/data";
import { ShellSourceContext, type ShellSource } from "../shell/source";
import { ordered, previewOf, type DraftEntry } from "./entries";
import { SAMPLE_NOW, sampleTeam, type SampleTeam } from "./sample";

interface State extends Omit<SampleTeam, "bots" | "room" | "attachments"> {
  /** Cards whose answer is on its way, as it would be to a server. */
  readonly inFlight: ReadonlySet<EntryId>;
  /** Each conversation's unsent text and files, by `keyOf`. */
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly settingsSave: SettingsSave;
}

const blankDraft: Draft = { text: "", files: [], sending: false };

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

function updateEntry(state: State, entryId: EntryId, update: (entry: Entry) => Entry): State {
  const key = Object.keys(state.entries).find((k) =>
    state.entries[k]?.some((e) => e.id === entryId),
  );
  return key === undefined
    ? state
    : withEntries(state, key, (es) => es.map((e) => (e.id === entryId ? update(e) : e)));
}

function updateBot(state: State, botId: BotId, update: (bot: Bot) => Bot): State {
  return {
    ...state,
    roster: state.roster.map((item) =>
      item._tag === "bot" && item.bot.id === botId ? { ...item, bot: update(item.bot) } : item,
    ),
  };
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

function message(
  author: Entry["author"],
  text: string,
  attachments: Extract<Entry, { _tag: "message" }>["attachments"] = [],
): DraftEntry {
  return {
    _tag: "message",
    id: newId(),
    author,
    createdAt: now(),
    text,
    attachments,
    mentions: { _tag: "bots", ids: [] },
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

function sampleIntents({ get, update }: Store): ShellIntents {
  /** The bot thinks for a moment, then says `text` in `key`. */
  const replyLater = (botId: BotId, key: string, text: string) => {
    update((s) =>
      updateBot(s, botId, setState({ _tag: "thinking", since: now(), stalled: false })),
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

  return {
    setDraftText: (target, text) => changeDraft(target, (draft) => ({ ...draft, text })),
    // Files are "uploaded" at once: the sample has no server to send them to.
    attachFiles: (target, picked) =>
      changeDraft(target, (draft) => ({
        ...draft,
        files: [
          ...draft.files,
          ...picked.map((file): DraftFile => {
            const id = AttachmentId.make(`local-file-${++created}`);
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
        ],
      })),
    detachFile: (target, key) =>
      changeDraft(target, (draft) => ({
        ...draft,
        files: draft.files.filter((file) => file.key !== key),
      })),
    restoreDraft: nothing,
    dismissDraftOffer: nothing,
    sendDraft: (target) => {
      const key = keyOf(target);
      const draft = get().drafts[key] ?? blankDraft;
      const text = draft.text.trim();
      const attachments = draft.files.flatMap((file) =>
        file._tag === "ready" ? [file.attachment] : [],
      );
      if (text === "" && attachments.length === 0) return;
      update((s) => ({
        ...withEntries(s, key, (es) =>
          appended(es, message({ _tag: "operator" }, text, attachments)),
        ),
        drafts: { ...s.drafts, [key]: blankDraft },
      }));
      // In a room, the host answers what is addressed to nobody.
      const room = get().roster.find(
        (i) => i._tag === "room" && target._tag === "room" && i.room.id === target.roomId,
      );
      const host =
        target._tag === "conversation"
          ? target.botId
          : room?._tag === "room"
            ? room.room.hostId
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
    retryNotice: (entryId) =>
      update((s) =>
        updateEntry(s, entryId, (e) => (e._tag === "notice" ? { ...e, retryable: false } : e)),
      ),
    retryMessage: (entryId) =>
      inFlight(entryId, (e) =>
        e._tag === "message" ? { ...e, delivery: { _tag: "pending" } } : e,
      ),
    stopBot: (botId) => update((s) => updateBot(s, botId, setState({ _tag: "idle" }))),
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
    createBot: (name, primary) => {
      const botId = BotId.make(`local-bot-${++created}`);
      update((s) => {
        const count = s.roster.length;
        const bot: Bot = {
          id: botId,
          profile: {
            name,
            title: "",
            avatar: {
              shape: avatarShapeNames[count % avatarShapeNames.length] ?? "circle",
              color: botColors[count % botColors.length] ?? "gray",
            },
            job: "",
          },
          model: {
            providerId: ProviderId.make("claude-code"),
            modelId: ModelId.make("claude-sonnet-5-5"),
          },
          permissionMode: "supervised",
          primary,
          pinned: false,
          hidden: false,
          state: { _tag: "idle" },
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
      replyLater(botId, `bot:${botId}`, `Hi, I’m ${name}. What would you like me to take care of?`);
      return Promise.resolve(botId);
    },
    deleteBot: (botId) =>
      update((s) => ({
        ...s,
        roster: s.roster.filter((item) => !(item._tag === "bot" && item.bot.id === botId)),
      })),
    updateSettings: (changes) =>
      update((s) => ({
        ...s,
        settings: { ...s.settings, ...changes },
        settingsSave: { _tag: "saved" },
      })),
    startPairing: () =>
      Promise.resolve({
        _tag: "started",
        code: PairingCode.make("7KQ2M9XH4D"),
        expiresAt: DateTime.makeUnsafe(Date.now() + 5 * 60_000),
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
    openHandoff: nothing,
    openRoutine: nothing,
    openConversation: nothing,
    openMemoryFile: nothing,
    loadOlder: nothing,
    markRead: nothing,
    newBot: nothing,
    newRoom: nothing,
    editProfile: nothing,
    freshStart: nothing,
    refreshDevices: nothing,
    signOut: () => Promise.resolve(true),
  };
}

function toData(state: State): ShellData {
  return {
    engine: state.engine,
    engineStale: false,
    roster: state.roster,
    conversation: (target) => ({
      phase: "ready",
      items: state.entries[keyOf(target)] ?? [],
      hasOlder: false,
      loadingOlder: false,
    }),
    draft: (target) => state.drafts[keyOf(target)] ?? blankDraft,
    // The sample is one tab: nothing else replaces its drafts.
    restorable: () => false,
    submitting: (entryId) => state.inFlight.has(entryId),
    workSteps: (entryId) => state.workSteps[entryId] ?? null,
    routines: (botId) => state.routines[botId] ?? [],
    files: (botId) => state.files[botId] ?? [],
    memory: (botId) => state.memory[botId] ?? [],
    settings: state.settings,
    settingsSave: state.settingsSave,
    devices: state.devices,
    connected: true,
  };
}

/**
 * The sample team, with intents that change it. Each call keeps its own copy.
 * `firstRun` starts it with no bots, at the first-run screen.
 */
export function useSampleSource({ firstRun = false }: { firstRun?: boolean } = {}): ShellSource {
  const [store] = useState(() => {
    const team: State = {
      ...sampleTeam(SAMPLE_NOW),
      inFlight: new Set(),
      drafts: {},
      settingsSave: { _tag: "idle" },
    };
    return createStore(firstRun ? withoutBots(team) : team);
  });
  const state = useSyncExternalStore(store.subscribe, store.get);
  const intents = useMemo(() => sampleIntents(store), [store]);
  return { data: toData(state), intents };
}

/**
 * Development's stand-in for the server: the sample team, and a clock held at
 * the sample's moment so its times read as they were written.
 */
export function SampleSourceProvider({ children }: { children: ReactNode }) {
  const source = useSampleSource();
  return (
    <ClockProvider now={SAMPLE_NOW}>
      <ShellSourceContext value={source}>{children}</ShellSourceContext>
    </ClockProvider>
  );
}
