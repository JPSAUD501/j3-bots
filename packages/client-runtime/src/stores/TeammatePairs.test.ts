// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { teammateMessage, teammatePair } from "../../test/fixtures.ts";
import { applyPairsFrame, messageWithCard } from "./TeammatePairs.ts";

describe("applyPairsFrame", () => {
  const older = teammatePair(teammateMessage(1, "2026-11-20T10:00:00Z", "scout", "wren"));
  const newer = teammatePair(teammateMessage(2, "2026-11-20T10:01:00Z", "pip", "wren"));

  it("holds a snapshot latest first", () => {
    expect(applyPairsFrame(null, { _tag: "snapshot", pairs: [older, newer] })).toEqual([
      newer,
      older,
    ]);
  });

  it("moves a pair with a new message to the top, and drops one that has none left", () => {
    const answered = teammatePair(teammateMessage(3, "2026-11-20T10:02:00Z", "wren", "scout"), 2);
    expect(
      applyPairsFrame([newer, older], {
        _tag: "changed",
        upsert: [answered],
        remove: [[BotId.make("pip"), BotId.make("wren")]],
      }),
    ).toEqual([answered]);
  });
});

it("finds a message by its card in either bot's conversation", () => {
  const messages = [
    teammateMessage(1, "2026-11-20T10:00:00Z", "scout", "wren"),
    teammateMessage(2, "2026-11-20T10:01:00Z", "wren", "scout"),
  ];
  expect(messageWithCard(messages, EntryId.make("sent-2"))?.seq).toBe(2);
  expect(messageWithCard(messages, EntryId.make("received-1"))?.seq).toBe(1);
  expect(messageWithCard(messages, EntryId.make("elsewhere"))).toBeUndefined();
});
