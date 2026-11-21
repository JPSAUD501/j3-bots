// SPDX-License-Identifier: AGPL-3.0-or-later
import { Invalid } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { deliveryLine } from "./message.ts";

describe("delivery line", () => {
  const en = createI18n("en");
  const settled = { submitting: false, leftRoom: [] };

  it("says a message the engine found too long apart from any other refusal", () => {
    const refused = (reason: "message-length" | "mentions") =>
      deliveryLine(
        { _tag: "not-sent", failure: { _tag: "refused", error: new Invalid({ reason }) } },
        settled,
        en,
      );
    expect(refused("message-length")).toBe(
      "Not sent: too long for this bot’s engine to take in one message",
    );
    expect(refused("mentions")).toBe("Not sent: the server refused it");
  });

  it("names the members who left in place of the refusal", () => {
    const status = {
      _tag: "not-sent",
      failure: { _tag: "refused", error: new Invalid({ reason: "mentions" }) },
    } as const;
    expect(deliveryLine(status, { submitting: false, leftRoom: ["Ana", "Scout"] }, en)).toBe(
      "Not sent: Ana and Scout are no longer in this room",
    );
  });

  it("reads a failed message as queued again while its retry is on its way", () => {
    const failed = { _tag: "failed", reason: "stopped" } as const;
    expect(deliveryLine(failed, settled, en)).toBe("Not delivered: the work was stopped");
    expect(deliveryLine(failed, { submitting: true, leftRoom: [] }, en)).toBe("Queued");
  });

  it("says nothing once every recipient has the message", () => {
    expect(deliveryLine({ _tag: "delivered" }, settled, en)).toBeNull();
  });
});
