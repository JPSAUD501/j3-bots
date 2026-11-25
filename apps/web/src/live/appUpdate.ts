// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import type { UpdateStatus } from "@j3-bots/desktop-bridge";
import { useEffect, useSyncExternalStore } from "react";
import type { DesktopUpdate } from "../shell/data";
import { desktop } from "./desktop";

// In the desktop app: where updating it stands, read once and then followed
// as the app reports each change, and the saves a restart into an update
// waits for.

/** The status the app last gave; `undefined` until it first answered, `null` when it gave none. */
let latest: UpdateStatus | null | undefined = desktop === null ? null : undefined;
const listeners = new Set<() => void>();
const take = (status: UpdateStatus | null) => {
  latest = status;
  for (const listener of listeners) listener();
};

if (desktop !== null) {
  // A change the app reports is newer than the first read, whichever arrives first.
  let reported = false;
  desktop.onUpdate((status) => {
    reported = true;
    take(status);
  });
  void desktop.updateStatus().then((status) => {
    if (!reported) take(status);
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const current = () => latest;

/** Takes the status the app answers a choice with. */
const answered = (answer: Promise<UpdateStatus | null>) => {
  void answer.then((status) => {
    if (status !== null) take(status);
  });
};
const setChannel = (channel: UpdateChannel) => {
  answered(desktop?.setUpdateChannel(channel) ?? Promise.resolve(null));
};
const setAutomatic = (on: boolean) => {
  answered(desktop?.setAutomaticUpdates(on) ?? Promise.resolve(null));
};

const updateOf = (status: UpdateStatus | null | undefined): DesktopUpdate | undefined =>
  desktop === null || status === null || status === undefined
    ? undefined
    : {
        status,
        check: desktop.checkForUpdates,
        restart: desktop.restartToUpdate,
        setChannel,
        setAutomatic,
      };

/** Updating the desktop app, with its status as it changes; absent in a browser. */
export function useDesktopUpdate(): DesktopUpdate | undefined {
  return updateOf(useSyncExternalStore(subscribe, current, current));
}

/**
 * The update the desktop app makes as it starts, while it does: `unread`
 * until the app first says where updating stands, which it answers at once;
 * then the update while its launch checks or installs one; `null` once the
 * page may open as usual, and always in a browser.
 */
export function useLaunchUpdate(): DesktopUpdate | "unread" | null {
  const status = useSyncExternalStore(subscribe, current, current);
  if (status === undefined) return "unread";
  const update = updateOf(status);
  return update === undefined || update.status.launch === "over" ? null : update;
}

/** `update` when the app can update itself, or nothing. */
export const updatable = (update: DesktopUpdate | undefined): DesktopUpdate | undefined =>
  update?.status.phase._tag === "unavailable" ? undefined : update;

/** Tells the desktop app whether a save is under way, and that none is once the page stops tracking. */
export function useReportSaving(saving: boolean): void {
  useEffect(() => {
    desktop?.reportSaving(saving);
  }, [saving]);
  useEffect(() => () => desktop?.reportSaving(false), []);
}
