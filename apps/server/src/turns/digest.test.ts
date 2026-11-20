// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  AttachmentId,
  BotId,
  EntryId,
  EntryOrder,
  type MessageDelivery,
  type MessageEntry,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { conversationDigest } from "./digest.ts";

let order = 0;

const message = (
  author: MessageEntry["author"],
  text: string,
  options: {
    readonly delivery?: MessageDelivery;
    readonly files?: ReadonlyArray<string>;
  } = {},
): MessageEntry => ({
  _tag: "message",
  id: EntryId.make(`entry-${++order}`),
  order: EntryOrder.make(order),
  author,
  createdAt: DateTime.makeUnsafe("2026-11-20T12:00:00Z"),
  text,
  attachments: (options.files ?? []).map((name, index) => ({
    id: AttachmentId.make(`file-${order}-${index}`),
    name,
    mediaType: "text/plain",
    size: 1,
  })),
  mentions: { _tag: "bots", ids: [] },
  delivery: options.delivery ?? { _tag: "delivered" },
  commandId: null,
});

const operator = { _tag: "operator" } as const;
const bot = { _tag: "bot", botId: BotId.make("ana") } as const;

describe("conversationDigest", () => {
  it("tells what the bot saw and said, oldest first, with the files each carried", () => {
    assert.strictEqual(
      conversationDigest(
        [
          message(operator, "Summarize the report.", { files: ["q3.pdf"] }),
          message(bot, "Done: files/q3.md."),
          message({ _tag: "system" }, "Ana was moved to another model."),
        ],
        "Sam",
      ).text,
      "Sam: Summarize the report. [files: q3.pdf]\nYou: Done: files/q3.md.",
    );
  });

  it("leaves out what never reached the bot, or is still on its way", () => {
    assert.strictEqual(
      conversationDigest(
        [
          message(operator, "Delivered."),
          message(operator, "Refused.", { delivery: { _tag: "failed", reason: "rejected" } }),
          message(operator, "Stopped first.", { delivery: { _tag: "cancelled" } }),
          message(operator, "Waiting.", { delivery: { _tag: "pending" } }),
        ],
        "Sam",
      ).text,
      "Sam: Delivered.",
    );
  });

  it("keeps the newest messages that fit, each one cut short", () => {
    const long = "x".repeat(5_000);
    const { text: digest, full } = conversationDigest(
      Array.from({ length: 10 }, (_, n) => message(operator, `${n} ${long}`)),
      "Sam",
    );
    assert.isTrue(full);
    const lines = digest.split("\n");
    assert.isBelow(digest.length, 6_100);
    assert.isTrue(lines.every((line) => line.length <= "Sam: ".length + 1_000));
    assert.isTrue(lines.at(-1)?.startsWith("Sam: 9 "));
    assert.isFalse(digest.includes("Sam: 0 "));
  });

  it("counts its limit in messages, not in the entries between them", () => {
    const entries = Array.from({ length: 70 }, (_, n) => [
      message(operator, `Message ${n}.`),
      message({ _tag: "system" }, "Ana was moved to another model."),
      message(operator, "Refused.", { delivery: { _tag: "failed", reason: "rejected" } }),
    ]).flat();
    const { text, full } = conversationDigest(entries, "Sam");
    const lines = text.split("\n");
    assert.strictEqual(lines.length, 60);
    assert.strictEqual(lines[0], "Sam: Message 10.");
    assert.strictEqual(lines.at(-1), "Sam: Message 69.");
    assert.isTrue(full);
    assert.isFalse(conversationDigest(entries.slice(-30), "Sam").full);
  });

  it("says so when nothing was said yet", () => {
    assert.deepStrictEqual(conversationDigest([], "Sam"), {
      text: "Nothing has been said in the conversation yet.",
      full: false,
    });
  });
});
