// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_SHORTCUT } from "@j3-bots/desktop-bridge";
import { describe, expect, it } from "vite-plus/test";
import { type KeyPress, pressedShortcut, shortcutLabel } from "./accelerator";

const press = (code: string, held: Partial<Omit<KeyPress, "code">> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...held,
});

describe("a shortcut the operator presses", () => {
  it("is named by the key's place and the modifiers held, as the platform calls them", () => {
    expect(pressedShortcut(press("KeyJ", { ctrlKey: true, shiftKey: true }), false)).toEqual({
      _tag: "shortcut",
      accelerator: DEFAULT_SHORTCUT,
    });
    expect(pressedShortcut(press("KeyJ", { metaKey: true, shiftKey: true }), true)).toEqual({
      _tag: "shortcut",
      accelerator: DEFAULT_SHORTCUT,
    });
    expect(pressedShortcut(press("Digit1", { metaKey: true, altKey: true }), false)).toEqual({
      _tag: "shortcut",
      accelerator: "Alt+Super+1",
    });
    expect(pressedShortcut(press("F5", { ctrlKey: true }), true)).toEqual({
      _tag: "shortcut",
      accelerator: "Control+F5",
    });
  });

  it("waits while only modifiers are down, and refuses a key alone, with Shift, or one it cannot name", () => {
    expect(pressedShortcut(press("ShiftLeft", { shiftKey: true }), false)).toEqual({
      _tag: "incomplete",
    });
    expect(pressedShortcut(press("ControlRight", { ctrlKey: true }), false)).toEqual({
      _tag: "incomplete",
    });
    expect(pressedShortcut(press("KeyJ"), false)).toEqual({ _tag: "refused" });
    expect(pressedShortcut(press("KeyJ", { shiftKey: true }), false)).toEqual({ _tag: "refused" });
    expect(pressedShortcut(press("Slash", { ctrlKey: true }), false)).toEqual({ _tag: "refused" });
  });

  it("reads as the platform writes shortcuts", () => {
    expect(shortcutLabel(DEFAULT_SHORTCUT, false)).toBe("Ctrl+Shift+J");
    expect(shortcutLabel(DEFAULT_SHORTCUT, true)).toBe("⇧⌘J");
    expect(shortcutLabel("CommandOrControl+Control+Alt+Shift+Space", true)).toBe("⌃⌥⇧⌘Space");
    expect(shortcutLabel("Alt+Super+1", false)).toBe("Alt+Super+1");
  });
});
