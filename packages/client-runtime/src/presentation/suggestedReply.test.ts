// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  CommandId,
  EntryId,
  EntryOrder,
  type SuggestedReply,
  type WorkFoldEntry,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, message } from "../../test/fixtures.ts";
import { FILE_MARK } from "../files/placed.ts";
import type { OutgoingMessage } from "../stores/Conversations.ts";
import { offeredReply } from "./suggestedReply.ts";

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;
const question = message("2026-11-20T10:00:00Z", { _tag: "operator" }, "What's on today?");
const answer = message("2026-11-20T10:00:10Z", scout, "Two meetings.");
const fold: WorkFoldEntry = {
  _tag: "work-fold",
  id: EntryId.make("fold"),
  order: EntryOrder.make(1000),
  author: scout,
  createdAt: at("2026-11-20T10:00:12Z"),
  turnStartedAt: at("2026-11-20T10:00:01Z"),
  stepCount: 2,
  apps: [],
  status: {
    _tag: "finished",
    finishedAt: at("2026-11-20T10:00:12Z"),
    ending: "completed",
    waitedMs: 0,
    waitedBeforeMs: 0,
    background: false,
  },
};
const sending: OutgoingMessage = {
  _tag: "outgoing",
  commandId: CommandId.make("cmd_thanks"),
  target: { _tag: "conversation", botId: scout.botId },
  text: "Thanks!",
  attachments: [],
  mentions: null,
  labels: [],
  createdAt: at("2026-11-20T10:01:00Z"),
  status: { _tag: "sending" },
};
const suggestion: SuggestedReply = { text: "Move the second one", after: answer.id };

describe("the reply the composer offers", () => {
  it("follows the answer it was guessed after, past the answer's work fold", () => {
    expect(offeredReply(suggestion, [question, answer])).toBe(suggestion);
    expect(offeredReply(suggestion, [question, answer, fold])).toBe(suggestion);
  });

  it("is gone once anything newer shows, even before the server says so", () => {
    expect(offeredReply(suggestion, [question, answer, sending])).toBeNull();
    const later = message("2026-11-20T10:02:00Z", scout, "Also, lunch moved.");
    expect(offeredReply(suggestion, [question, answer, later])).toBeNull();
    const working: WorkFoldEntry = {
      ...fold,
      id: EntryId.make("next"),
      status: { _tag: "running" },
    };
    expect(offeredReply(suggestion, [question, answer, working])).toBeNull();
    expect(offeredReply(null, [question, answer])).toBeNull();
  });

  it("never stands for a file in the draft", () => {
    const marked = { ...suggestion, text: `See ${FILE_MARK}` };
    expect(offeredReply(marked, [question, answer])).toBeNull();
  });
});
