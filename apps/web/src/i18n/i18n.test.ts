// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { createI18n, resolveLocale } from "./i18n";

describe("createI18n", () => {
  it("fills placeholders, formatting numbers for the language", () => {
    expect(createI18n("en").t("roster.noMatch", { query: "Scout" })).toBe(
      "Nothing matches “Scout”.",
    );
    expect(createI18n("en").plural("routine.runs", 1234)).toBe("1,234 runs");
    expect(createI18n("pt-BR").plural("routine.runs", 1234)).toBe("1.234 execuções");
  });

  it("chooses the plural sentence by the language's rules", () => {
    const en = createI18n("en");
    expect(en.plural("work.steps", 1)).toBe("1 step");
    expect(en.plural("work.steps", 0)).toBe("0 steps");
    const pt = createI18n("pt-BR");
    expect(pt.plural("work.steps", 1)).toBe("1 passo");
    expect(pt.plural("work.steps", 3)).toBe("3 passos");
  });

  it("fills the other placeholders of a plural sentence", () => {
    expect(createI18n("en").plural("schedule.everyMinutes", 15)).toBe("Every 15 minutes");
    expect(createI18n("en").plural("schedule.everyMinutes", 1)).toBe("Every minute");
  });
});

describe("resolveLocale", () => {
  it("takes the first preferred language J3 Bots has", () => {
    expect(resolveLocale(["fr-FR", "pt-br", "en"])).toBe("pt-BR");
    expect(resolveLocale(["en-GB", "pt-BR"])).toBe("en");
  });

  it("falls back from a region it lacks to the same language", () => {
    expect(resolveLocale(["pt-PT"])).toBe("pt-BR");
  });

  it("uses English when nothing matches", () => {
    expect(resolveLocale(["de", "ja"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });
});
