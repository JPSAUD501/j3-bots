// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { tabLineWords } from "./browser.ts";

const ana = BotId.make("ana");
const lia = BotId.make("lia");
const nameOf = (botId: BotId) => (botId === ana ? "Ana" : "Lia");

describe("tabLineWords", () => {
  const en = createI18n("en");
  const pt = createI18n("pt-BR");

  it("names the bots that wait, in the interface's language and number", () => {
    expect(tabLineWords({ _tag: "waits-for-you", bots: [ana] }, nameOf, pt).text).toBe(
      "Ana espera você",
    );
    expect(tabLineWords({ _tag: "waits-for-you", bots: [ana, lia] }, nameOf, pt).text).toBe(
      "Ana e Lia esperam você",
    );
    expect(tabLineWords({ _tag: "on-it", bots: [ana, lia] }, nameOf, en).text).toBe("Ana and Lia");
  });

  it("offers Now during the countdown and Continue after Wait for me, and nothing else", () => {
    expect(tabLineWords({ _tag: "back-in", bots: [ana], seconds: 2 }, nameOf, en)).toEqual({
      text: "Back in 2",
      action: "now",
    });
    expect(tabLineWords({ _tag: "waits-until-continue", bots: [ana] }, nameOf, en).action).toBe(
      "continue",
    );
    expect(
      tabLineWords({ _tag: "acting", bots: [ana], acting: ana }, nameOf, en).action,
    ).toBeNull();
  });
});
