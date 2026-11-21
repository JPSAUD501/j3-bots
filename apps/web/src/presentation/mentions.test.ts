// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { addresseeOf, type Mentionable } from "@j3-bots/client-runtime/presentation";
import { createI18n } from "../i18n/i18n";
import { addresseeLine, resendLabel } from "./mentions";

const member = (id: string, name: string): Mentionable => ({ id: BotId.make(id), name });
const ana = member("ana", "Ana");
const scout = member("scout", "Scout");
const members = [scout, ana];

describe("addressee", () => {
  const en = createI18n("en");
  const nameOf = (botId: BotId) => members.find((one) => one.id === botId)?.name;

  it("says a message for nobody goes to the host, named as it is now", () => {
    expect(addresseeLine(addresseeOf(null, scout.id, nameOf, en), en)).toBe(
      "To the host (now Scout)",
    );
  });

  it("says Send again goes to the host once every member mentioned has left", () => {
    const without = { _tag: "bots", ids: [] } as const;
    expect(resendLabel(addresseeOf(without, scout.id, nameOf, en), en)).toBe(
      "Send to the host (Scout)",
    );
    const someStay = { _tag: "bots", ids: [ana.id] } as const;
    expect(resendLabel(addresseeOf(someStay, scout.id, nameOf, en), en)).toBe("Send to Ana");
  });
});
