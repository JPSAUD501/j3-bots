// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { phoneBehindLine } from "./phoneWording.ts";

const i18n = createI18n("en");

describe("the app's line on the screen that says it is behind its server", () => {
  it("never says the app is up to date, and points a stable app to nightly", () => {
    const current = { _tag: "current", waitingForStable: false } as const;
    expect(phoneBehindLine(current, "stable", i18n)).toMatchObject({
      text: i18n.t("phoneUpdate.behind.noRelease"),
      hint: i18n.t("phoneUpdate.behind.nightlyHint"),
    });
    expect(phoneBehindLine(current, "nightly", i18n)).toMatchObject({
      text: i18n.t("phoneUpdate.behind.noRelease"),
      hint: null,
    });
  });

  it("says a nightly app on stable waits for a newer stable release", () => {
    expect(
      phoneBehindLine({ _tag: "current", waitingForStable: true }, "stable", i18n),
    ).toMatchObject({ hint: i18n.t("phoneUpdate.waitingForStable") });
  });
});
