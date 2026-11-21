// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { at, context } from "@j3-bots/client-runtime/testing";
import { windowText } from "./usage";

describe("windowText", () => {
  // 11:00 in São Paulo, the fixtures' zone.
  const ctx = context("2026-11-20T14:00:00Z");

  it("reads a window at its limit as reached until it resets", () => {
    expect(
      windowText({ label: "Weekly", usedPercent: 100, resetsAt: at("2026-11-20T18:00:00Z") }, ctx),
    ).toMatchObject({ used: "Limit reached", tone: "full", reset: "Resets at 3:00\u00A0PM" });
    // Short of it, never full.
    expect(windowText({ label: "Weekly", usedPercent: 99.6, resetsAt: null }, ctx)).toMatchObject({
      used: "99% used",
      tone: "open",
      reset: null,
    });
  });

  it("past its reset, keeps the last figure and says when it reset", () => {
    expect(
      windowText({ label: "Weekly", usedPercent: 100, resetsAt: at("2026-11-20T13:00:00Z") }, ctx),
    ).toMatchObject({
      used: "100% used",
      tone: "reset",
      reset: "Reset at 10:00\u00A0AM; new figures at the next check",
    });
  });

  it("names the engine's Session the five-hour window, translates its other known labels, and keeps the rest", () => {
    const named = (label: string, locale: "en" | "pt-BR" = "en") =>
      windowText({ label, usedPercent: 0, resetsAt: null }, context("2026-11-20T14:00:00Z", locale))
        .name;
    expect(named("Session")).toBe("5-hour window");
    expect(named("Weekly · Claude Opus 5.5")).toBe("Weekly · Claude Opus 5.5");
    expect(named("Monthly credit limit")).toBe("Monthly credit limit");
    expect(named("Session", "pt-BR")).toBe("Janela de 5 horas");
    expect(named("Weekly", "pt-BR")).toBe("Semanal");
    expect(named("Weekly · Claude Opus 5.5", "pt-BR")).toBe("Semanal · Claude Opus 5.5");
    expect(named("Monthly spend", "pt-BR")).toBe("Gasto mensal");
    expect(named("Daily", "pt-BR")).toBe("Daily");
  });
});
