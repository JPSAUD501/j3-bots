// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { lookingAtOf, oneLine } from "./text.ts";

describe("what a chip shows of a window", () => {
  it("keeps a title on one line, without the marks that would turn its words around", () => {
    assert.strictEqual(oneLine("  Inbox\n\t(3)‮  ", 50), "Inbox (3)");
    assert.isNull(oneLine(" \n⁦ ", 50));
  });

  it("cuts a long title with an ellipsis, never between the halves of a character", () => {
    assert.strictEqual(oneLine("abcdef", 4), "abc…");
    // "😀" is two UTF-16 units: the cut falls before it, not through it.
    assert.strictEqual(oneLine("ab😀cd", 4), "ab…");
  });

  it("shows the app alone when its title is off, missing or only its name", () => {
    assert.deepStrictEqual(lookingAtOf("Mail", "Inbox", true), { app: "Mail", title: "Inbox" });
    assert.deepStrictEqual(lookingAtOf("Mail", "Inbox", false), { app: "Mail" });
    assert.deepStrictEqual(lookingAtOf("Mail", "Mail", true), { app: "Mail" });
    assert.deepStrictEqual(lookingAtOf("Mail", null, true), { app: "Mail" });
    assert.isNull(lookingAtOf(null, "Inbox", true));
  });
});
