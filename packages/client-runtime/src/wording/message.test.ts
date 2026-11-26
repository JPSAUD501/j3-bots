// SPDX-License-Identifier: AGPL-3.0-or-later
import { Invalid } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../../test/fixtures.ts";
import { deliveryLine, fileSize } from "./message.ts";

describe("delivery line", () => {
  const en = context("2026-11-20T15:00:00Z", "en", {});
  const settled = { submitting: false, leftRoom: [], openingHold: null };

  it("says a message the engine found too long apart from any other refusal", () => {
    const refused = (reason: "message-length" | "mentions") =>
      deliveryLine(
        { _tag: "not-sent", failure: { _tag: "refused", error: new Invalid({ reason }) } },
        settled,
        en,
      );
    expect(refused("message-length")).toBe(
      "Not sent: too long for this bot to take in one message",
    );
    expect(refused("mentions")).toBe("Not sent: the server refused it");
  });

  it("names the members who left in place of the refusal", () => {
    const status = {
      _tag: "not-sent",
      failure: { _tag: "refused", error: new Invalid({ reason: "mentions" }) },
    } as const;
    expect(deliveryLine(status, { ...settled, leftRoom: ["Ana", "Scout"] }, en)).toBe(
      "Not sent: Ana and Scout are no longer in this room",
    );
  });

  it("reads a failed message as queued again while its retry is on its way", () => {
    const failed = { _tag: "failed", reason: "stopped" } as const;
    expect(deliveryLine(failed, settled, en)).toBe("Not delivered: the work was stopped");
    expect(deliveryLine(failed, { ...settled, submitting: true }, en)).toBe("Queued");
  });

  it("says when a message the server holds behind the bot's hello goes, as what holds the hello says", () => {
    const behind = { _tag: "queued", behindOpening: true } as const;
    const connect = { ...settled, openingHold: { _tag: "connect", command: "connect" } } as const;
    expect(deliveryLine(behind, connect, en)).toBe("Sent once the AI is connected");
    const limit = (resetsAt: string | null) =>
      ({
        ...settled,
        openingHold: { _tag: "limit", resetsAt: resetsAt === null ? null : at(resetsAt) },
      }) as const;
    expect(plain(deliveryLine(behind, limit("2026-11-20T16:30:00Z"), en) ?? "")).toBe(
      "Sent when the usage limit resets at 1:30 PM",
    );
    expect(deliveryLine(behind, limit(null), en)).toBe("Sent when the usage limit resets");
    // Queued behind a hello already on its way, or behind nothing, it waits like any message.
    expect(deliveryLine({ _tag: "queued" }, connect, en)).toBe("Queued");
    expect(deliveryLine(behind, settled, en)).toBe("Queued");
  });

  it("says nothing once every recipient has the message", () => {
    expect(deliveryLine({ _tag: "delivered" }, settled, en)).toBeNull();
  });
});

describe("file size", () => {
  it("spells bytes out, so their count agrees with them, and abbreviates larger units", () => {
    expect(fileSize(1, "en")).toBe("1 byte");
    expect(fileSize(178, "en")).toBe("178 bytes");
    expect(fileSize(178, "pt-BR")).toBe("178 bytes");
    expect(fileSize(1_200_000, "en")).toBe("1.2 MB");
  });
});
