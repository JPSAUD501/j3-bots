// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { MAX_BROWSER_TEXT_LENGTH } from "@j3-bots/contracts";
import { fieldChange, relayed } from "./typing.ts";

describe("the keyboard relay", () => {
  it("passes on what was typed, one change at a time", () => {
    expect(fieldChange("", "a")).toEqual({ erased: 0, added: "a" });
    expect(fieldChange("op", "ope")).toEqual({ erased: 0, added: "e" });
    expect(fieldChange("oper", "ope")).toEqual({ erased: 1, added: "" });
  });

  it("rewrites a word a keyboard corrected or composed", () => {
    expect(fieldChange("voce", "você")).toEqual({ erased: 1, added: "ê" });
    expect(fieldChange("teh ", "the ")).toEqual({ erased: 3, added: "he " });
  });

  it("erases a character of two code units with one Backspace", () => {
    expect(fieldChange("ok 👍", "ok ")).toEqual({ erased: 1, added: "" });
    expect(fieldChange("👍", "👎")).toEqual({ erased: 1, added: "👎" });
  });

  it("types the erasures before the text, in the page's own keys", () => {
    expect(relayed({ erased: 1, added: "ê" })).toEqual([
      {
        type: "key",
        action: "down",
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        modifiers: 0,
      },
      { type: "key", action: "up", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 },
      { type: "text", text: "ê" },
    ]);
  });

  it("sends a paste longer than one frame in frames the page takes, splitting no character", () => {
    const paste = `${"a".repeat(MAX_BROWSER_TEXT_LENGTH - 1)}👍b`;
    const texts = relayed({ erased: 0, added: paste }).flatMap((input) =>
      input.type === "text" ? [input.text] : [],
    );
    expect(texts).toEqual(["a".repeat(MAX_BROWSER_TEXT_LENGTH - 1), "👍b"]);
  });
});
