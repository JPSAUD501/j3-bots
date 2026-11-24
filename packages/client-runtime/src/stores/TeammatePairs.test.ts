// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, PairSeq, type TeammateMessage } from "@j3-bots/contracts";
import { it as effect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { teammateMessage, teammatePair } from "../../test/fixtures.ts";
import { applyPairsFrame, messageWithCard, refilled } from "./TeammatePairs.ts";

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

describe("refilled", () => {
  // Ten messages, the last one now not delivered.
  const sent = Array.from({ length: 10 }, (_, index) =>
    teammateMessage(index + 1, "2026-11-20T10:00:00Z", "scout", "wren", `message ${index + 1}`),
  );
  const now = sent.map((message): TeammateMessage =>
    message.seq === 10 ? { ...message, state: "not-delivered" } : message,
  );
  const latest = { messages: now.slice(7), hasOlder: true };
  /** A server that answers two messages at a time, and none before `failingBelow`: what each read asked for. */
  const server = (failingBelow = 0) => {
    const reads: Array<number> = [];
    const read = (before: PairSeq, limit: number) =>
      Effect.sync(() => {
        reads.push(before);
        if (before <= failingBelow) return null;
        const older = now.filter((message) => message.seq < before);
        return { messages: older.slice(-Math.min(limit, 2)), hasOlder: older.length > 2 };
      });
    return { reads, read };
  };
  const seqs = (messages: ReadonlyMap<PairSeq, TeammateMessage>) =>
    [...messages.keys()].toSorted((a, b) => a - b);

  effect.effect("reads back down to the oldest message held before, each as it stands now", () =>
    Effect.gen(function* () {
      const { reads, read } = server();
      const held = yield* refilled(latest, () => PairSeq.make(4), read);
      expect(seqs(held.messages)).toEqual([4, 5, 6, 7, 8, 9, 10]);
      expect(held.hasOlder).toBe(true);
      expect(reads).toEqual([8, 6]);
      expect(held.messages.get(PairSeq.make(10))?.state).toBe("not-delivered");
    }),
  );

  effect.effect("stops at a page it cannot read, leaving the rest to scroll back to", () =>
    Effect.gen(function* () {
      const held = yield* refilled(latest, () => PairSeq.make(1), server(6).read);
      expect(seqs(held.messages)).toEqual([6, 7, 8, 9, 10]);
      expect(held.hasOlder).toBe(true);
    }),
  );

  effect.effect("reads as far as a scroll back reached while it read", () =>
    Effect.gen(function* () {
      const { reads, read } = server();
      // The operator's scroll back took the conversation from 6 to 2 during the first read.
      const held = yield* refilled(latest, () => PairSeq.make(reads.length === 0 ? 6 : 2), read);
      expect(seqs(held.messages)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(reads).toEqual([8, 6, 4]);
    }),
  );
});
