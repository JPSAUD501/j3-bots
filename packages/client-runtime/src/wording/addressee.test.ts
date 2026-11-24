// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { resendLabel } from "./addressee.ts";

const ana = BotId.make("ana");
const scout = BotId.make("scout");
const names = new Map([
  [ana, "Ana"],
  [scout, "Scout"],
]);

describe("resendLabel", () => {
  const en = createI18n("en");
  const nameOf = (botId: BotId) => names.get(botId);

  it("sends to the room once every member mentioned has left", () => {
    expect(resendLabel({ _tag: "bots", ids: [] }, nameOf, en)).toBe("Send to the room");
  });

  it("sends to the members mentioned who stay, by their names now", () => {
    expect(resendLabel({ _tag: "bots", ids: [ana, scout] }, nameOf, en)).toBe(
      "Send to Ana and Scout",
    );
  });
});
