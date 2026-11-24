// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { addresseeOf, type Mentionable } from "../presentation/mentions.ts";
import { createI18n } from "@j3-bots/i18n";
import { addresseeLine, resendLabel } from "./addressee.ts";

const member = (id: string, name: string): Mentionable => ({ id: BotId.make(id), name });
const ana = member("ana", "Ana");
const scout = member("scout", "Scout");
const members = [scout, ana];

describe("addressee", () => {
  const en = createI18n("en");
  const nameOf = (botId: BotId) => members.find((one) => one.id === botId)?.name;

  it("says a message for nobody goes to every member", () => {
    expect(addresseeLine(addresseeOf(null, nameOf, en), en)).toBe("To everyone");
  });

  it("says Send again goes to every member once every member mentioned has left", () => {
    const without = { _tag: "bots", ids: [] } as const;
    expect(resendLabel(addresseeOf(without, nameOf, en), en)).toBe("Send again");
    const someStay = { _tag: "bots", ids: [ana.id] } as const;
    expect(resendLabel(addresseeOf(someStay, nameOf, en), en)).toBe("Send to Ana");
  });
});
