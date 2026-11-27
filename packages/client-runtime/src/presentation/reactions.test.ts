// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type Reaction, ReactionEmoji } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { QUICK_REACTIONS, REACTION_GROUPS, reactionAfterPick, reactionPills } from "./reactions.ts";

const emoji = Schema.decodeSync(ReactionEmoji);
const operator: Reaction["by"] = { _tag: "operator" };
const ana: Reaction["by"] = { _tag: "bot", botId: BotId.make("ana") };
const leo: Reaction["by"] = { _tag: "bot", botId: BotId.make("leo") };

describe("reactions", () => {
  it("groups reactions by emoji, in the order each first appeared, with whose they are", () => {
    const pills = reactionPills([
      { emoji: emoji("👍"), by: ana },
      { emoji: emoji("❤️"), by: operator },
      { emoji: emoji("👍"), by: leo },
    ]);
    expect(pills).toEqual([
      { emoji: "👍", count: 2, mine: false, by: [ana, leo] },
      { emoji: "❤️", count: 1, mine: true, by: [operator] },
    ]);
  });

  it("replaces the operator's reaction with another emoji, and takes it off when picked again", () => {
    const reactions: ReadonlyArray<Reaction> = [{ emoji: emoji("👍"), by: operator }];
    expect(reactionAfterPick(reactions, emoji("🎉"))).toBe("🎉");
    expect(reactionAfterPick(reactions, emoji("👍"))).toBeNull();
    expect(reactionAfterPick([{ emoji: emoji("👍"), by: ana }], emoji("👍"))).toBe("👍");
  });

  it("offers only emoji the server takes, each once", () => {
    // The server takes exactly one emoji as Unicode defines one (`Reactions`).
    const all = [...QUICK_REACTIONS, ...REACTION_GROUPS.flatMap((group) => group.emoji)];
    for (const one of all) expect(one).toMatch(/^\p{RGI_Emoji}$/v);
    const picker = REACTION_GROUPS.flatMap((group) => group.emoji);
    expect(new Set(picker).size).toBe(picker.length);
  });
});
