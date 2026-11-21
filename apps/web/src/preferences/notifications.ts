// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";

/**
 * Whether this browser may show J3 Bots' notifications: the browser's own
 * permission, or why there is none to ask for. Browsers offer notifications
 * only in a secure context (HTTPS, or localhost), so a page served over plain
 * HTTP on the local network gets none, and some hide the API there. Safari on
 * iPhone and iPad offers them only to an app added to the Home Screen.
 */
export type NotificationAccess =
  | "insecure"
  | "home-screen"
  | "unsupported"
  | NotificationPermission;

const read = (): NotificationAccess => {
  if (!window.isSecureContext) return "insecure";
  if (!("Notification" in window)) {
    // Only Safari on iPhone and iPad has `navigator.standalone`: false in a tab.
    return "standalone" in navigator && navigator.standalone === false
      ? "home-screen"
      : "unsupported";
  }
  return Notification.permission;
};

const listeners = new Set<() => void>();
let snapshot = read();

function refresh() {
  const next = read();
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

// The operator can change the permission in the browser's site settings at any time.
if ("permissions" in navigator) {
  navigator.permissions.query({ name: "notifications" }).then(
    (status) => status.addEventListener("change", refresh),
    // A browser that cannot tell: the permission is read again after each request.
    () => undefined,
  );
}

/** This browser's notification access now. */
export const notificationAccess = (): NotificationAccess => snapshot;

export function useNotificationAccess(): NotificationAccess {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notificationAccess,
    notificationAccess,
  );
}

/**
 * Asks the browser's permission, which shows its prompt. Only the operator's
 * own action may call this: browsers ignore or penalize a prompt that comes
 * unasked, and the app never asks on load.
 */
export async function requestNotificationAccess(): Promise<void> {
  if (read() !== "default") return;
  await Notification.requestPermission();
  refresh();
}
