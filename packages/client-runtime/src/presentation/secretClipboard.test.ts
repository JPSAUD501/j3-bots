// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type DeviceClipboard,
  type Foreground,
  SECRET_COPIED_FOR,
  secretClipboard,
} from "./secretClipboard.ts";

/**
 * A device whose clipboard holds one text, which another app can replace
 * (`copyElsewhere`), and which reads it only while the app is in the
 * foreground, as Android does; `withForeground` false, the app is not told
 * so, as on a computer, where it always is.
 */
const device = (withForeground = true) => {
  let held = "";
  let active = true;
  const listeners = new Set<() => void>();
  const clipboard: DeviceClipboard = {
    write: (text) => {
      held = text;
      return Promise.resolve(true);
    },
    read: () =>
      active ? Promise.resolve(held) : Promise.reject(new Error("not in the foreground")),
    clear: () => {
      held = "";
      return Promise.resolve();
    },
  };
  const foreground: Foreground = {
    active: () => active,
    onActive: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    secrets: secretClipboard(clipboard, withForeground ? foreground : undefined),
    held: () => held,
    copyElsewhere: (text: string) => {
      held = text;
    },
    background: () => {
      active = false;
    },
    foreground: () => {
      active = true;
      for (const listener of listeners) listener();
    },
  };
};

describe("a secret's value copied", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the clipboard as a value shown leaves the screen, and not before", async () => {
    const phone = device();
    await phone.secrets.copy("hunter2");
    await vi.advanceTimersByTimeAsync(SECRET_COPIED_FOR - 1);
    expect(phone.held()).toBe("hunter2");
    await vi.advanceTimersByTimeAsync(1);
    expect(phone.held()).toBe("");
  });

  it("leaves as its time is up where the clipboard can always be read", async () => {
    const computer = device(false);
    await computer.secrets.copy("hunter2");
    await vi.advanceTimersByTimeAsync(SECRET_COPIED_FOR);
    expect(computer.held()).toBe("");
  });

  it("keeps what the operator copied since", async () => {
    const phone = device();
    await phone.secrets.copy("hunter2");
    phone.copyElsewhere("a note");
    await vi.advanceTimersByTimeAsync(SECRET_COPIED_FOR);
    expect(phone.held()).toBe("a note");
  });

  it("waits for a phone's app to come back when its time is up in the background", async () => {
    const phone = device();
    await phone.secrets.copy("hunter2");
    phone.background();
    await vi.advanceTimersByTimeAsync(SECRET_COPIED_FOR);
    expect(phone.held()).toBe("hunter2");
    phone.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.held()).toBe("");
  });

  it("leaves what was pasted over it in the background", async () => {
    const phone = device();
    await phone.secrets.copy("hunter2");
    phone.background();
    phone.copyElsewhere("a note");
    await vi.advanceTimersByTimeAsync(SECRET_COPIED_FOR);
    phone.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.held()).toBe("a note");
  });

  it("gives a value copied again its whole time", async () => {
    const phone = device();
    await phone.secrets.copy("hunter2");
    await vi.advanceTimersByTimeAsync(SECRET_COPIED_FOR - 1);
    await phone.secrets.copy("hunter2");
    await vi.advanceTimersByTimeAsync(SECRET_COPIED_FOR - 1);
    expect(phone.held()).toBe("hunter2");
    await vi.advanceTimersByTimeAsync(1);
    expect(phone.held()).toBe("");
  });
});
