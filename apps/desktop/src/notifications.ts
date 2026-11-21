// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceId, EntryId } from "@j3-bots/contracts";
import type { NotificationClick, NotificationRequest } from "@j3-bots/desktop-bridge";

// The notifications the app shows on the system's screen, kept by the entry
// they are about and the pairing that received them, so a click opens what
// one was about and a pairing that ends takes its own off the screen.

/** A notification on the system's screen. */
interface Displayed {
  readonly close: () => void;
}

/**
 * Puts `request` on the system's screen, calling `clicked` when the operator
 * clicks it and `gone` once it leaves the screen, however it goes. `null`
 * when the system shows none.
 */
export type Display = (
  request: NotificationRequest,
  on: { readonly clicked: () => void; readonly gone: () => void },
) => Displayed | null;

export interface Notifications {
  /** Shows `request`, in place of what was shown for its entry; nothing for a pairing that ended. */
  readonly show: (request: NotificationRequest) => void;
  /** Closes what `pairing`, which ended, received, and shows nothing of it again. */
  readonly closeOf: (pairing: DeviceId) => void;
  /** Closes every notification, as the page that showed them goes. */
  readonly closeAll: () => void;
}

/**
 * The app's notifications, shown with `display`. A click closes the one
 * clicked and hands `open` what it was about and the pairing that received
 * it; the page decides whether to open it, as a browser's click does.
 */
export const makeNotifications = (
  display: Display,
  open: (click: NotificationClick) => void,
): Notifications => {
  interface Shown {
    readonly displayed: Displayed;
    readonly pairing: DeviceId;
  }
  const shown = new Map<EntryId, Shown>();
  /** Pairings that ended: a pairing never comes back, so nothing of theirs shows again. */
  const ended = new Set<DeviceId>();

  /** Takes the entry's notification off the screen, if it is still `which`. */
  const remove = (entryId: EntryId, which?: Shown) => {
    const current = shown.get(entryId);
    if (current === undefined || (which !== undefined && current !== which)) return false;
    shown.delete(entryId);
    current.displayed.close();
    return true;
  };
  const closeWhere = (closes: (pairing: DeviceId) => boolean) => {
    for (const [entryId, entry] of shown) if (closes(entry.pairing)) remove(entryId);
  };

  return {
    show: (request) => {
      if (ended.has(request.pairing)) return;
      remove(request.entryId);
      let entry: Shown | undefined;
      const displayed = display(request, {
        clicked: () => {
          if (entry === undefined || !remove(request.entryId, entry)) return;
          open({ target: request.target, pairing: request.pairing });
        },
        gone: () => {
          if (entry !== undefined && shown.get(request.entryId) === entry) {
            shown.delete(request.entryId);
          }
        },
      });
      if (displayed === null) return;
      entry = { displayed, pairing: request.pairing };
      shown.set(request.entryId, entry);
    },
    closeOf: (pairing) => {
      ended.add(pairing);
      closeWhere((received) => received === pairing);
    },
    closeAll: () => closeWhere(() => true),
  };
};
