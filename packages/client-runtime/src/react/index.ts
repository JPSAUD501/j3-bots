// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId, EntryTarget, RosterItem } from "@j3-bots/contracts";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationHandle, J3Client, WorkStepsHandle } from "../client.ts";
import { type ActionState, cardAction } from "../intents/Actions.ts";
import type { Readable } from "../Store.ts";
import { type ConversationState, targetKey } from "../stores/Conversations.ts";
import { rosterRows } from "../stores/Roster.ts";
import type { WorkStepsState } from "../stores/WorkSteps.ts";

// Thin bindings: every decision lives in the runtime. A hook reads a
// `Readable` and returns what it holds; intents are called on the client.

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

/** The roster in display order, or `null` until it first loads. */
export const useRoster = (): {
  readonly rows: ReadonlyArray<RosterItem>;
  readonly stale: boolean;
} | null => {
  const roster = useReadable(useJ3Client().roster);
  return useMemo(
    () =>
      roster._tag === "ready" ? { rows: rosterRows(roster.value), stale: roster.stale } : null,
    [roster],
  );
};

/** Where an action on a card stands, to disable its buttons while it runs. */
export const useCardAction = (entryId: EntryId): ActionState | undefined =>
  useSelected(useJ3Client().actions, (actions) => actions.get(cardAction(entryId)));

const nothing = () => () => {};
const none = () => null;

/** Holds `open(client)` while the component is mounted and `key` stays the same. */
const useHeld = <H extends { readonly release: () => void }>(
  key: string,
  open: (client: J3Client) => H,
): H | null => {
  const client = useJ3Client();
  const [held, setHeld] = useState<{ readonly key: string; readonly handle: H } | null>(null);
  useEffect(() => {
    const handle = open(client);
    setHeld({ key, handle });
    return handle.release;
    // `open` is a new function every render; `key` says when it opens something else.
  }, [client, key]);
  // For one render after `key` changes, the previous handle is still held.
  return held?.key === key ? held.handle : null;
};

/**
 * The conversation or room while the component is mounted: its state, or
 * `null` for the first render, and what to call on it.
 */
export const useConversation = (
  target: EntryTarget,
): {
  readonly state: ConversationState | null;
  readonly loadOlder: () => void;
  readonly markRead: () => void;
} => {
  const handle: ConversationHandle | null = useHeld(targetKey(target), (client) =>
    client.openConversation(target),
  );
  const state = useSyncExternalStore(
    handle?.state.subscribe ?? nothing,
    handle?.state.get ?? none,
    handle?.state.get ?? none,
  );
  return {
    state,
    loadOlder: handle?.loadOlder ?? (() => {}),
    markRead: handle?.markRead ?? (() => {}),
  };
};

/** The steps of a work fold while the component is mounted, or `null` for the first render. */
export const useWorkSteps = (foldId: EntryId): WorkStepsState | null => {
  const handle: WorkStepsHandle | null = useHeld(foldId, (client) => client.openWorkSteps(foldId));
  return useSyncExternalStore(
    handle?.state.subscribe ?? nothing,
    handle?.state.get ?? none,
    handle?.state.get ?? none,
  );
};
