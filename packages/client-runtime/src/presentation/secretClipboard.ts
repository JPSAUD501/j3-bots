// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- the apps' clipboards, driven from their platforms' callbacks, outside any Effect program.

/** How long a secret's value copied stays on the clipboard, in ms: as long as one shown stays on screen. */
export const SECRET_COPIED_FOR = 30_000;

/** A device's clipboard. */
export interface DeviceClipboard {
  /** Whether `text` got there. */
  readonly write: (text: string) => Promise<boolean>;
  readonly read: () => Promise<string>;
  readonly clear: () => Promise<void>;
}

/**
 * Whether the app is in the foreground, where a system that lets only that
 * app read the clipboard, as Android does, lets it.
 */
export interface Foreground {
  readonly active: () => boolean;
  /** Calls `listener` each time the app comes to the foreground; answers what stops it. */
  readonly onActive: (listener: () => void) => () => void;
}

interface Copied {
  readonly text: string;
  readonly timer: ReturnType<typeof setTimeout>;
  stopWaiting: (() => void) | null;
}

/**
 * Copies a secret's values. Each leaves the clipboard `SECRET_COPIED_FOR`
 * after it was copied, as a value shown leaves the screen, only if the
 * clipboard still holds it: whatever the operator copied since, here or in
 * another app, stays. Only the last value copied is watched: the one before
 * it is the clipboard's no longer. With `foreground`, the clipboard is read
 * only while the app is in it: a value whose time is up in the background
 * leaves as the app comes back.
 */
export const secretClipboard = (clipboard: DeviceClipboard, foreground?: Foreground) => {
  let copied: Copied | null = null;

  const forget = () => {
    if (copied === null) return;
    clearTimeout(copied.timer);
    copied.stopWaiting?.();
    copied = null;
  };

  const takeOff = async (entry: Copied) => {
    entry.stopWaiting?.();
    entry.stopWaiting = null;
    try {
      const held = await clipboard.read();
      // A value copied while the clipboard was read is not this one's to take off.
      if (copied === entry && held === entry.text) await clipboard.clear();
    } catch {
      // The clipboard could not be read or cleared: the value stays.
    } finally {
      if (copied === entry) copied = null;
    }
  };

  const due = (entry: Copied) => {
    if (foreground === undefined || foreground.active()) {
      void takeOff(entry);
      return;
    }
    entry.stopWaiting = foreground.onActive(() => void takeOff(entry));
  };

  return {
    /** Puts `text` on the clipboard, to leave it later: whether it got there. */
    copy: async (text: string): Promise<boolean> => {
      forget();
      const entry: Copied = {
        text,
        timer: setTimeout(() => due(entry), SECRET_COPIED_FOR),
        stopWaiting: null,
      };
      copied = entry;
      const written = await clipboard.write(text).catch(() => false);
      if (!written && copied === entry) forget();
      return written;
    },
  };
};
