// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../test/fixtures";
import { scheduleInWords } from "./schedule";

const en = context("2026-11-20T17:40:00Z");
const words = (cron: string, ctx = en) => {
  const text = scheduleInWords({ _tag: "schedule", cron, timeZone: "America/Sao_Paulo" }, ctx);
  return text === null ? null : plain(text);
};

describe("scheduleInWords", () => {
  it("says common schedules as a person would", () => {
    expect(words("47 8 * * 1-5")).toBe("Weekdays at 8:47 AM");
    expect(words("*/30 * * * *")).toBe("Every 30 minutes");
    expect(words("5 * * * *")).toBe("Every hour at minute 05");
    expect(words("0 9 * * *")).toBe("Every day at 9:00 AM");
    expect(words("0 10 * * 0,6")).toBe("Weekends at 10:00 AM");
    expect(words("0 7 1 * *")).toBe("Monthly on day 1 at 7:00 AM");
    expect(scheduleInWords({ _tag: "webhook" }, en)).toBe("When its webhook is called");
    const once = scheduleInWords({ _tag: "once", at: at("2026-11-23T11:47:00Z") }, en);
    expect(once === null ? null : plain(once)).toBe("Once, on Nov 23, 2026, 8:47 AM");
  });

  it("names a list of days, reading cron's 7 as Sunday", () => {
    expect(words("0 17 * * 1,4")).toBe("Every Monday and Thursday at 5:00 PM");
    expect(words("0 10 * * 6,7")).toBe("Weekends at 10:00 AM");
    expect(words("30 16 * * 1,3,5")).toBe("Every Monday, Wednesday, and Friday at 4:30 PM");
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
