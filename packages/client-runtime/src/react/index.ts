// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotFile,
  BotId,
  EntryId,
  EntryOrder,
  EntryTarget,
  MemoryFile,
  MemoryScope,
  Routine,
  RoutineId,
} from "@j3-bots/contracts";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationHandle, J3Client, UsageHandle, WorkStepsHandle } from "../client.ts";
import { type ActionState, cardAction } from "../intents/Actions.ts";
import type { Readable } from "../Store.ts";
import { type ConversationState, targetKey } from "../stores/Conversations.ts";
import type { Draft } from "../stores/Drafts.ts";
import type { RoutineRuns } from "../stores/Details.ts";
import type { Loaded } from "../stores/reads.ts";
import { type RecentTurnsState, turnsNotRead } from "../stores/Usage.ts";
import type { WorkStepsState } from "../stores/WorkSteps.ts";

// Thin bindings: every decision lives in the runtime. A hook reads a
// `Readable` and returns what it holds; intents are called on the client.
// The form hooks hold one form's edit, deciding with the presentation's
// helpers, so every client's form behaves the same.

const ClientContext = createContext<J3Client | null>(null);

export const J3ClientProvider = (props: {
  readonly client: J3Client;
  readonly children?: ReactNode;
}) => createElement(ClientContext.Provider, { value: props.client }, props.children);

export const useJ3Client = (): J3Client => {
  const client = useContext(ClientContext);
  if (client === null) throw new Error("useJ3Client needs a J3ClientProvider above it.");
  return client;
};

export const useReadable = <A>(readable: Readable<A>): A =>
  useSyncExternalStore(readable.subscribe, readable.get, readable.get);

/** Part of a `Readable`. `select` must return a value already held, never a new object. */
export const useSelected = <A, B>(readable: Readable<A>, select: (value: A) => B): B => {
  const get = () => select(readable.get());
  return useSyncExternalStore(readable.subscribe, get, get);
};

export const useConnection = () => useReadable(useJ3Client().connection);
export const useEngineStatus = () => useReadable(useJ3Client().engine);
export const useSettings = () => useReadable(useJ3Client().settings);
export const useDevices = () => useReadable(useJ3Client().devices);
export const useServerUpdate = () => useReadable(useJ3Client().serverUpdate.view);
export const useServerUpdateEnded = () => useReadable(useJ3Client().serverUpdate.ended);

/** Where an action on a card stands, to disable its buttons while it runs. */
export const useCardAction = (entryId: EntryId): ActionState | undefined =>
  useSelected(useJ3Client().actions, (actions) => actions.get(cardAction(entryId)));

/** Every action in flight or just accepted, by key. */
export const useActions = () => useReadable(useJ3Client().actions);

const emptyDraft: Draft = { text: "", mentions: [], files: [], sending: false };

/** What the operator has written to `target` and not sent, kept on the device. */
export const useDraft = (target: EntryTarget): Draft => {
  const key = targetKey(target);
  return useSelected(useJ3Client().drafts, (drafts) => drafts.get(key) ?? emptyDraft);
};

const nothing = () => () => {};
const none = () => null;

/**
 * Holds `open(client, input)` while the component is mounted and the key of
 * `input` stays the same. A null `input` holds nothing.
 */
const useHeld = <I, H extends { readonly release: () => void }>(
  input: I | null,
  keyOf: (input: I) => string,
  open: (client: J3Client, input: I) => H,
): H | null => {
  const client = useJ3Client();
  const key = input === null ? null : keyOf(input);
  const [held, setHeld] = useState<{ readonly key: string; readonly handle: H } | null>(null);
  useEffect(() => {
    if (input === null || key === null) return;
    const handle = open(client, input);
    setHeld({ key, handle });
    return handle.release;
    // `input` and `open` are new every render; `key` says when they mean something else.
  }, [client, key]);
  // For one render after `key` changes, the previous handle is still held.
  return held !== null && held.key === key ? held.handle : null;
};

/** What a held handle's state holds, or `null` when nothing is held yet. */
const useHeldState = <A>(handle: { readonly state: Readable<A> } | null): A | null =>
  useSyncExternalStore(
    handle?.state.subscribe ?? nothing,
    handle?.state.get ?? none,
    handle?.state.get ?? none,
  );

const same = (key: string) => key;
const scopeKey = (scope: MemoryScope) => (scope._tag === "bot" ? `bot:${scope.botId}` : "shared");

/** The files a bot delivered, newest first, while mounted. A null `botId` reads nothing. */
export const useBotFiles = (botId: BotId | null): Loaded<ReadonlyArray<BotFile>> | null =>
  useHeldState<Loaded<ReadonlyArray<BotFile>>>(
    useHeld(botId, same, (client, id) => client.openBotFiles(id)),
  );

/** The files of a memory scope, while mounted. A null `scope` reads nothing. */
export const useMemory = (scope: MemoryScope | null): Loaded<ReadonlyArray<MemoryFile>> | null =>
  useHeldState<Loaded<ReadonlyArray<MemoryFile>>>(
    useHeld(scope, scopeKey, (client, value) => client.openMemory(value)),
  );

/** A bot's routines, live, while mounted. A null `botId` reads nothing. */
export const useRoutines = (botId: BotId | null): Loaded<ReadonlyArray<Routine>> | null =>
  useHeldState<Loaded<ReadonlyArray<Routine>>>(
    useHeld(botId, same, (client, id) => client.openRoutines(id)),
  );

/** A routine's newest runs, while mounted. A null `routineId` reads nothing. */
export const useRoutineRuns = (routineId: RoutineId | null): Loaded<RoutineRuns> | null =>
  useHeldState<Loaded<RoutineRuns>>(
    useHeld(routineId, same, (client, id) => client.openRoutineRuns(id)),
  );

/**
 * The conversation or room while the component is mounted: its state, or
 * `null` for the first render or when `target` is null, and what to call on it.
 */
export const useConversation = (
  target: EntryTarget | null,
): {
  readonly state: ConversationState | null;
  readonly loadOlder: () => void;
  readonly markRead: (through: EntryOrder) => void;
} => {
  const handle: ConversationHandle | null = useHeld(target, targetKey, (client, value) =>
    client.openConversation(value),
  );
  const state = useHeldState(handle);
  return {
    state,
    loadOlder: handle?.loadOlder ?? (() => {}),
    markRead: handle?.markRead ?? (() => {}),
  };
};

/** The steps of a work fold while the component is mounted, or `null` for the first render. */
export const useWorkSteps = (foldId: EntryId): WorkStepsState | null => {
  const handle: WorkStepsHandle | null = useHeld(foldId, same, (client, id) =>
    client.openWorkSteps(id),
  );
  return useHeldState(handle);
};

const doNothing = () => {};

/**
 * The turns bots spent recently while `held`, read again each time it
 * becomes true; not read yet for the first render or while not held.
 */
export const useRecentTurns = (
  held: boolean,
): {
  readonly state: RecentTurnsState;
  readonly loadMore: () => void;
  readonly retry: () => void;
} => {
  const handle: UsageHandle | null = useHeld(held ? "usage" : null, same, (client) =>
    client.openUsage(),
  );
  return {
    state: useHeldState(handle) ?? turnsNotRead,
    loadMore: handle?.loadMore ?? doNothing,
    retry: handle?.retry ?? doNothing,
  };
};

export { type ConversationEnd, useArrivals, useConversationEnd, useRestored } from "./arrivals.ts";
export { type BotEdit, type ProfileFieldProblem, useBotEdit } from "./botEdit.ts";
export { type MemoryEdit, type MemoryReading, useMemoryEdit } from "./memoryEdit.ts";
export { type ProfileEdits, type ProfileForm, useProfileEdits, useProfileForm } from "./profile.ts";
export {
  type RoomForm,
  type RoomFormFailure,
  type RoomFormSubmitted,
  type RoomSubmission,
  useRoomForm,
} from "./roomForm.ts";
export { useAsleep, useAvatarMood } from "./avatar.ts";
export { useTurnAnnouncement } from "./turn.ts";
