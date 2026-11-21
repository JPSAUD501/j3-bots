// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  insertMention,
  type Mentionable,
  mentionOptions,
  mentionQuery,
  mentionsIn,
  movedOption,
} from "./mentions";

const member = (name: string): Mentionable => ({ id: BotId.make(name.toLowerCase()), name });
const ana = member("Ana");
const anaLima = member("Ana Lima");
const scout = member("Scout");
const members = [scout, ana, anaLima];

describe("mentionsIn", () => {
  it("names each member mentioned, once, in the order first mentioned", () => {
    expect(mentionsIn("@ana check this, then @Scout and @ANA again", members)).toEqual({
      _tag: "bots",
      ids: [ana.id, scout.id],
    });
  });

  it("matches the longest name, so a name with a space is not cut short", () => {
    expect(mentionsIn("@Ana Lima, the draft", members)).toEqual({
      _tag: "bots",
      ids: [anaLima.id],
    });
  });

  it("asks everyone when @everyone appears anywhere", () => {
    expect(mentionsIn("@Scout first, then @everyone.", members)).toEqual({ _tag: "everyone" });
  });

  it("is nobody for text that only looks like a mention", () => {
    expect(mentionsIn("mail ana@example.com about @Scouting", members)).toBeUndefined();
    expect(mentionsIn("@Carla is not in this room", members)).toBeUndefined();
  });
});

describe("mentionQuery", () => {
  it("is the word after an @ that opens a mention, up to the caret", () => {
    expect(mentionQuery("ask @sc", 7)).toEqual({ start: 4, query: "sc" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("is none once a space follows, or inside an address", () => {
    expect(mentionQuery("ask @Scout now", 14)).toBeNull();
    expect(mentionQuery("ana@ex", 6)).toBeNull();
  });
});

describe("mentionOptions", () => {
  it("offers members a word of whose name starts with the query, then everyone", () => {
    expect(mentionOptions("li", members)).toEqual([
      { _tag: "bot", id: anaLima.id, name: "Ana Lima" },
    ]);
    expect(mentionOptions("", members).map((o) => (o._tag === "bot" ? o.name : o._tag))).toEqual([
      "Scout",
      "Ana",
      "Ana Lima",
      "everyone",
    ]);
    expect(mentionOptions("EV", members)).toEqual([{ _tag: "everyone" }]);
  });
});

describe("insertMention", () => {
  it("replaces what was typed with the name and a space, and puts the caret after it", () => {
    const text = "ask @an to look";
    const picked = insertMention(text, 7, { start: 4, query: "an" }, { _tag: "bot", ...anaLima });
    expect(picked).toEqual({ text: "ask @Ana Lima to look", caret: 14 });
    expect(mentionsIn(picked.text, members)).toEqual({ _tag: "bots", ids: [anaLima.id] });
  });

  it("adds a space at the end of the text", () => {
    expect(insertMention("@e", 2, { start: 0, query: "e" }, { _tag: "everyone" })).toEqual({
      text: "@everyone ",
      caret: 10,
    });
  });
});

describe("movedOption", () => {
  it("wraps at both ends", () => {
    expect(movedOption(0, -1, 4)).toBe(3);
    expect(movedOption(3, 1, 4)).toBe(0);
  });
});
