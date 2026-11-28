// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { browserShortcutOf, type PressedKey } from "./browser.ts";

const press = (key: string, held: Partial<Omit<PressedKey, "key">> = {}): PressedKey => ({
  key,
  ctrl: false,
  meta: false,
  shift: false,
  alt: false,
  ...held,
});
const pc = { mac: false, loading: false };
const mac = { mac: true, loading: false };

describe("the browser's shortcuts", () => {
  it("reads Ctrl on Windows and Linux, and ⌘ on a Mac", () => {
    assert.strictEqual(browserShortcutOf(press("t", { ctrl: true }), pc), "newTab");
    assert.strictEqual(browserShortcutOf(press("t", { meta: true }), mac), "newTab");
    assert.isNull(browserShortcutOf(press("t", { ctrl: true }), mac));
    assert.isNull(browserShortcutOf(press("t", { meta: true }), pc));
    assert.strictEqual(
      browserShortcutOf(press("N", { ctrl: true, shift: true }), pc),
      "newPrivateTab",
    );
    assert.strictEqual(browserShortcutOf(press("T", { ctrl: true, shift: true }), pc), "reopenTab");
  });

  it("goes to a tab by its number, and to the last with 9", () => {
    assert.strictEqual(browserShortcutOf(press("3", { ctrl: true }), pc), "tab3");
    assert.strictEqual(browserShortcutOf(press("9", { ctrl: true }), pc), "lastTab");
    assert.strictEqual(browserShortcutOf(press("Tab", { ctrl: true }), mac), "nextTab");
    assert.strictEqual(
      browserShortcutOf(press("Tab", { ctrl: true, shift: true }), pc),
      "previousTab",
    );
  });

  it("bookmarks with Ctrl+D, and moves the tab to the other place with Ctrl+Shift+D", () => {
    assert.strictEqual(browserShortcutOf(press("d", { ctrl: true }), pc), "bookmark");
    assert.strictEqual(
      browserShortcutOf(press("D", { ctrl: true, shift: true }), pc),
      "togglePlace",
    );
    assert.strictEqual(
      browserShortcutOf(press("B", { meta: true, shift: true }), mac),
      "bookmarksBar",
    );
  });

  it("leaves Escape to the page unless the page is loading", () => {
    assert.isNull(browserShortcutOf(press("Escape"), pc));
    assert.strictEqual(browserShortcutOf(press("Escape"), { mac: false, loading: true }), "stop");
  });

  it("keeps the system's own keys: ⌘H hides the app on a Mac", () => {
    assert.isNull(browserShortcutOf(press("h", { meta: true }), mac));
    assert.strictEqual(browserShortcutOf(press("y", { meta: true }), mac), "history");
    assert.strictEqual(browserShortcutOf(press("ArrowLeft", { alt: true }), pc), "back");
    assert.isNull(browserShortcutOf(press("ArrowLeft", { alt: true }), mac));
    assert.isNull(browserShortcutOf(press("a"), pc));
  });
});
