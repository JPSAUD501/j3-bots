// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client, LoadedHandle, Readable } from "@j3-bots/client-runtime";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { useState, useSyncExternalStore } from "react";

const nothing = () => () => {};
const none = () => null;

/** What one render asks to hold: `open`'s handle for this client, while `enabled`. */
interface Hold<A> {
  readonly client: J3Client;
  readonly enabled: boolean;
  /** The handle while watched; watching opens it and stopping releases it. */
  readonly handle: Readable<LoadedHandle<A> | null>;
}

const holdFor = <A>(
  client: J3Client,
  enabled: boolean,
  open: (client: J3Client) => LoadedHandle<A>,
): Hold<A> => {
  if (!enabled) return { client, enabled, handle: { get: none, subscribe: nothing } };
  let handle: LoadedHandle<A> | null = null;
  return {
    client,
    enabled,
    handle: {
      get: () => handle,
      subscribe: (listener) => {
        const opened = open(client);
        handle = opened;
        listener();
        return () => {
          if (handle === opened) handle = null;
          opened.release();
        };
      },
    },
  };
};

/**
 * What `open` holds for the renders React commits while `enabled`, once it
 * has loaded; null before, and while it is not held.
 */
function useHeldValue<A>(enabled: boolean, open: (client: J3Client) => LoadedHandle<A>): A | null {
  const client = useJ3Client();
  // One hold for each client and `enabled`, stored during render as React allows for state that follows a prop.
  const [hold, setHold] = useState(() => holdFor(client, enabled, open));
  if (hold.client !== client || hold.enabled !== enabled) setHold(holdFor(client, enabled, open));
  const handle = useSyncExternalStore(hold.handle.subscribe, hold.handle.get, hold.handle.get);
  const loaded = useSyncExternalStore(
    handle?.state.subscribe ?? nothing,
    handle?.state.get ?? none,
    handle?.state.get ?? none,
  );
  return loaded?._tag === "ready" ? loaded.value : null;
}

/**
 * Whether the server can recognize speech now, and with which model, while
 * mounted. Hold it only from a server whose settings carry `voice`
 * (`enabled`): an older one has no such subscription.
 */
export const useVoiceStatus = (enabled: boolean) =>
  useHeldValue(enabled, (client) => client.voice.openStatus());

/** Whether a key is saved for each cloud provider, while mounted; as `useVoiceStatus`. */
export const useCloudKeys = (enabled: boolean) =>
  useHeldValue(enabled, (client) => client.voice.openCloudKeys());
