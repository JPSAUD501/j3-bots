// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import type { UpdateStatus } from "@j3-bots/desktop-bridge";
import { useEffect, useSyncExternalStore } from "react";
import type { DesktopUpdate } from "../shell/data";
import { desktop } from "./desktop";

// In the desktop app: where updating it stands, read once and then followed
// as the app reports each change, and the saves a restart into an update
// waits for.

let latest: UpdateStatus | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

if (desktop !== null) {
  // A change the app reports is newer than the first read, whichever arrives first.
  let reported = false;
  desktop.onUpdate((status) => {
    reported = true;
    latest = status;
    notify();
  });
  void desktop.updateStatus().then((status) => {
    if (reported || status === null) return;
    latest = status;
    notify();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const current = () => latest;

/** Asks the app to follow `channel`, and takes the status it answers. */
const setChannel = (channel: UpdateChannel) => {
  void desktop?.setUpdateChannel(channel).then((status) => {
    if (status === null) return;
    latest = status;
    notify();
  });
};

/** Updating the desktop app, with its status as it changes; absent in a browser. */
export function useDesktopUpdate(): DesktopUpdate | undefined {
  const status = useSyncExternalStore(subscribe, current, current);
  if (desktop === null || status === null) return undefined;
  return {
    status,
    check: desktop.checkForUpdates,
    restart: desktop.restartToUpdate,
    setChannel,
  };
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
