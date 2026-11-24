// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { BotId } from "./base.ts";
import { PairBotIds, pairBotIds } from "./pair.ts";

describe("a teammate conversation's address", () => {
  const scout = BotId.make("bot_scout");
  const wren = BotId.make("bot_wren");
  const decode = Schema.decodeUnknownOption(PairBotIds);

  it("is the same pair whichever bot is named first", () => {
    assert.deepStrictEqual(pairBotIds(wren, scout), pairBotIds(scout, wren));
  });

  it("refuses two bots out of order, or one bot twice", () => {
    assert.isTrue(decode([scout, wren])._tag === "Some");
    assert.isTrue(decode([wren, scout])._tag === "None");
    assert.isTrue(decode([scout, scout])._tag === "None");
  });
});
