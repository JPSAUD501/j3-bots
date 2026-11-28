// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, Conflict, NotFound } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { liveLine, tabLineWords, tabOpenFailed } from "./browser.ts";

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

describe("tabOpenFailed", () => {
  const en = createI18n("en");
  const refused = (reason: Conflict["reason"]) =>
    tabOpenFailed({ _tag: "refused", error: new Conflict({ reason }) }, en);

  it("says why no tab opened, and what to do where there is something", () => {
    expect(refused("browser-app-only")).toBe(
      "No browser can open a tab now. Open J3 Bots on a computer.",
    );
    expect(refused("browser-full")).toBe(
      "The server’s browser has no free tab: each one is in use. Close one, or try again in a moment.",
    );
    expect(refused("browser-page-timeout")).toBe("The page didn’t load in time. Try again.");
    expect(refused("browser-address-refused")).toBe("The browser won’t open that address.");
  });

  it("says only that it failed for anything else", () => {
    expect(refused("engine-unavailable")).toBe("Couldn’t open a tab.");
    expect(
      tabOpenFailed({ _tag: "refused", error: new NotFound({ resource: "browser-tab" }) }, en),
    ).toBe("Couldn’t open a tab.");
    expect(tabOpenFailed({ _tag: "unexpected" }, en)).toBe("Couldn’t open a tab.");
  });
});

describe("liveLine", () => {
  const en = createI18n("en");
  const pt = createI18n("pt-BR");
  const live = { _tag: "live" } as const;
  const away = { _tag: "away" } as const;

  it("names the computer that disconnected, or says which it was without its name", () => {
    expect(liveLine({ frozen: away, line: "Ana", refused: null, computer: "Laptop" }, en)).toBe(
      "Laptop disconnected",
    );
    expect(liveLine({ frozen: away, line: "Ana", refused: null, computer: null }, pt)).toBe(
      "O computador com esta aba se desconectou",
    );
  });

  it("says input was not sent while the refusal is fresh, then the line again", () => {
    expect(liveLine({ frozen: live, line: "Ana", refused: "away", computer: "Laptop" }, en)).toBe(
      "Not sent: Laptop disconnected",
    );
    expect(
      liveLine({ frozen: { _tag: "parked" }, line: "Ana", refused: "parked", computer: null }, en),
    ).toBe("Not sent: this page is paused");
    expect(liveLine({ frozen: live, line: "Ana", refused: null, computer: "Laptop" }, en)).toBe(
      "Ana",
    );
  });

  it("says there is no connection over any refusal heard before", () => {
    expect(
      liveLine(
        { frozen: { _tag: "you-offline" }, line: "Ana", refused: "away", computer: "Laptop" },
        en,
      ),
    ).toBe("No connection");
  });
});
