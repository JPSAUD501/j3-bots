// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../../test/fixtures.ts";
import { scheduleInWords, timeZoneHint } from "./schedule.ts";

const en = context("2026-11-20T17:40:00Z");
const words = (cron: string, ctx = en, timeZone = "America/Sao_Paulo") => {
  const text = scheduleInWords({ _tag: "schedule", cron, timeZone }, ctx);
  return text === null ? null : plain(text);
};

describe("scheduleInWords", () => {
  it("says common schedules as a person would", () => {
    expect(words("47 8 * * 1-5")).toBe("Weekdays at 8:47 AM");
    // The time stays whole: a full no-break space, as in every time the interface shows.
    expect(
      scheduleInWords(
        { _tag: "schedule", cron: "47 8 * * 1-5", timeZone: "America/Sao_Paulo" },
        en,
      ),
    ).toMatch(/8:47\u00A0AM$/);
    expect(words("*/30 * * * *")).toBe("Every 30 minutes");
    expect(words("5 * * * *")).toBe("Every hour at minute 05");
    expect(words("0 9 * * *")).toBe("Every day at 9:00 AM");
    expect(words("0 10 * * 0,6")).toBe("Weekends at 10:00 AM");
    expect(words("0 7 1 * *")).toBe("Monthly on day 1 at 7:00 AM");
    expect(scheduleInWords({ _tag: "webhook" }, en)).toBe("When its webhook is called");
    const once = scheduleInWords({ _tag: "once", at: at("2026-11-23T11:47:00Z") }, en);
    expect(once === null ? null : plain(once)).toBe("Once, on Nov 23, 2026, 8:47 AM");
  });

  it("says an interval only when it divides the hour or the day evenly", () => {
    expect(words("*/15 * * * *")).toBe("Every 15 minutes");
    expect(words("*/1 * * * *")).toBe("Every minute");
    expect(words("0 */6 * * *")).toBe("Every 6 hours at minute 00");
    expect(words("30 */2 * * *", context("2026-11-20T17:40:00Z", "pt-BR"))).toBe(
      "A cada 2 horas, no minuto 30",
    );
    expect(words("0 */6 * * *", en, "Asia/Kolkata")).toBe(
      "Every 6 hours at minute 00 (India Standard Time)",
    );
    // These run at uneven spacing (:56, then :00) or never, so they keep their expression.
    for (const cron of ["*/7 * * * *", "*/0 * * * *", "0 */5 * * *", "0 */0 * * *"]) {
      expect(words(cron), cron).toBeNull();
    }
  });

  it("names a list of days, reading cron's 7 as Sunday", () => {
    expect(words("0 17 * * 1,4")).toBe("Every Monday and Thursday at 5:00 PM");
    expect(words("0 10 * * 6,7")).toBe("Weekends at 10:00 AM");
    expect(words("30 16 * * 1,3,5")).toBe("Every Monday, Wednesday, and Friday at 4:30 PM");
  });

  it("names the schedule's own time zone when it is not the operator's", () => {
    expect(words("0 9 * * 1,4", en, "Europe/Lisbon")).toBe(
      "Every Monday and Thursday at 9:00 AM (Western European Time)",
    );
    expect(words("47 8 * * 1-5", en, "America/New_York")).toBe(
      "Weekdays at 8:47 AM (Eastern Time)",
    );
    expect(words("0 7 1 * *", context("2026-11-20T17:40:00Z", "pt-BR"), "Asia/Tokyo")).toBe(
      "Todo mês no dia 1, às 07:00 (Horário Padrão do Japão)",
    );
    expect(words("15 * * * *", en, "Asia/Kolkata")).toBe(
      "Every hour at minute 15 (India Standard Time)",
    );
    expect(words("15 * * * *", context("2026-11-20T17:40:00Z", "pt-BR"), "Asia/Kolkata")).toBe(
      "Toda hora, no minuto 15 (Horário Padrão da Índia)",
    );
    // An interval is the same everywhere.
    expect(words("*/30 * * * *", en, "Europe/Lisbon")).toBe("Every 30 minutes");
  });

  it("writes the sentence in the reader's language", () => {
    expect(words("47 8 * * 1-5", context("2026-11-20T17:40:00Z", "pt-BR"))).toBe(
      "Dias úteis às 08:47",
    );
  });

  it("gives up on schedules without a plain sentence", () => {
    for (const cron of [
      "0 9 * 1 *",
      "0 9 1 * 1",
      "0 25 * * *",
      "0 9 * * 5-1",
      "0 9 * * L",
      "every day",
      "0 9 0 * *",
    ]) {
      expect(words(cron), cron).toBeNull();
    }
  });
});

describe("timeZoneHint", () => {
  it("names the zone in plain words, and only says what it sets for one it cannot name", () => {
    expect(timeZoneHint("America/Sao_Paulo", context("2026-11-20T17:40:00Z", "pt-BR"))).toMatch(
      /^Horário .*Brasília\. As rotinas seguem este relógio/,
    );
    expect(timeZoneHint("Mars/Olympus_Mons", en)).toBe(
      "Routines run on this clock, and bots tell time by it.",
    );
  });
});
