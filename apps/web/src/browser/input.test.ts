// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_BROWSER_TEXT_LENGTH } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  CELLULAR_QUALITY,
  GOOD_QUALITY,
  type KeyLike,
  keyFrame,
  modifiersOf,
  pagePoint,
  SLOW_QUALITY,
  textFrames,
  typesText,
  viewQuality,
  viewSize,
  wheelDelta,
} from "./input";

const key = (pressed: string, held: Partial<KeyLike> = {}): KeyLike => ({
  key: pressed,
  code: pressed.length === 1 ? `Key${pressed.toUpperCase()}` : pressed,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 0,
  altGraph: false,
  ...held,
});

describe("pagePoint", () => {
  const rect = { left: 100, top: 50, width: 640, height: 400 };
  const viewport = { width: 1280, height: 800 };

  it("scales a point on the drawn picture to the page's CSS pixels", () => {
    expect(pagePoint(rect, viewport, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
    expect(pagePoint(rect, viewport, { x: 420, y: 250 })).toEqual({ x: 640, y: 400 });
    expect(pagePoint(rect, viewport, { x: 740, y: 450 })).toEqual({ x: 1280, y: 800 });
  });

  it("holds a point past the picture to its edge", () => {
    expect(pagePoint(rect, viewport, { x: 20, y: 900 })).toEqual({ x: 0, y: 800 });
  });
});

describe("modifiersOf", () => {
  it("is the contract's bit set", () => {
    const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(modifiersOf(none)).toBe(0);
    expect(modifiersOf({ ...none, altKey: true })).toBe(1);
    expect(modifiersOf({ ...none, ctrlKey: true, shiftKey: true })).toBe(10);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});

describe("wheelDelta", () => {
  it("scrolls the page as far as the picture appears to move", () => {
    const delta = wheelDelta(
      { deltaX: 0, deltaY: 100, deltaMode: 0 },
      { width: 640, height: 400 },
      { width: 1280, height: 800 },
    );
    expect(delta).toEqual({ deltaX: 0, deltaY: 200 });
  });

  it("turns lines into pixels", () => {
    const delta = wheelDelta(
      { deltaX: 0, deltaY: 3, deltaMode: 1 },
      { width: 1280, height: 800 },
      { width: 1280, height: 800 },
    );
    expect(delta.deltaY).toBe(48);
  });
});

describe("keys", () => {
  it("leaves a printable key to the text field, which types it", () => {
    expect(typesText(key("a"))).toBe(true);
    expect(typesText(key("A", { shiftKey: true }))).toBe(true);
    expect(keyFrame(key("a"), "down")).toBeNull();
  });

  it("leaves what an input method composes, and dead keys, to the text field", () => {
    expect(typesText(key("Process", { keyCode: 229 }))).toBe(true);
    expect(typesText(key("e", { isComposing: true }))).toBe(true);
    expect(typesText(key("Dead"))).toBe(true);
  });

  it("types what AltGr makes, though it reads as Control and Alt", () => {
    expect(typesText(key("@", { ctrlKey: true, altKey: true, altGraph: true }))).toBe(true);
  });

  it("sends a shortcut as a key, with its code and modifiers", () => {
    expect(keyFrame(key("a", { ctrlKey: true }), "down")).toEqual({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      modifiers: 2,
    });
  });

  it("sends Enter with the carriage return that submits a form, on the way down only", () => {
    expect(keyFrame(key("Enter"), "down")).toMatchObject({ text: "\r", keyCode: 13 });
    expect(keyFrame(key("Enter"), "up")).not.toHaveProperty("text");
  });

  it("gives punctuation its own key code, not the one its character shares with another key", () => {
    // "." is U+002E, Delete's key code; Control with "." must not delete.
    expect(keyFrame(key(".", { code: "Period", ctrlKey: true }), "down")).toMatchObject({
      keyCode: 190,
    });
    expect(keyFrame(key("'", { code: "Quote", ctrlKey: true }), "down")).toMatchObject({
      keyCode: 222,
    });
    // A letter keeps its own, wherever the layout puts it.
    expect(keyFrame(key("z", { code: "KeyY", ctrlKey: true }), "down")).toMatchObject({
      keyCode: 89,
    });
  });

  it("sends editing and moving keys with the code Chromium runs them by", () => {
    expect(keyFrame(key("Backspace"), "down")).toMatchObject({ keyCode: 8 });
    expect(keyFrame(key("ArrowLeft", { shiftKey: true }), "down")).toMatchObject({
      keyCode: 37,
      modifiers: 8,
    });
  });
});

describe("textFrames", () => {
  it("splits long text into frames the server takes, never inside a character", () => {
    const text = `${"a".repeat(MAX_BROWSER_TEXT_LENGTH - 1)}😀b`;
    const frames = textFrames(text);
    expect(frames.map((frame) => frame.text).join("")).toBe(text);
    expect(frames[0]?.text).toBe("a".repeat(MAX_BROWSER_TEXT_LENGTH - 1));
    expect(frames.every((frame) => frame.text.length <= MAX_BROWSER_TEXT_LENGTH)).toBe(true);
  });
});

describe("viewSize", () => {
  it("asks for the drawn box in device pixels, within the server's bounds", () => {
    expect(viewSize({ width: 600, height: 375 }, 2)).toEqual({ maxWidth: 1200, maxHeight: 750 });
    expect(viewSize({ width: 3000, height: 2000 }, 2)).toEqual({
      maxWidth: 3840,
      maxHeight: 2160,
    });
    expect(viewSize({ width: 10, height: 10 }, 1)).toEqual({ maxWidth: 64, maxHeight: 64 });
  });
});

describe("viewQuality", () => {
  it("lowers the quality on mobile data, and more on a link the browser calls slow or saving", () => {
    expect(viewQuality(null)).toBe(GOOD_QUALITY);
    expect(viewQuality({ type: "wifi", effectiveType: "4g" })).toBe(GOOD_QUALITY);
    expect(viewQuality({ type: "cellular", effectiveType: "4g" })).toBe(CELLULAR_QUALITY);
    expect(viewQuality({ type: "cellular", effectiveType: "3g" })).toBe(SLOW_QUALITY);
    expect(viewQuality({ effectiveType: "3g" })).toBe(SLOW_QUALITY);
    expect(viewQuality({ saveData: true })).toBe(SLOW_QUALITY);
  });
});
