// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createI18n } from "../i18n/i18n";
import { clockTime } from "../lib/time";
import { at } from "../test/fixtures";
import { ClockProvider, OperatorTimeZone, useClock } from "./clock";

const NOON_UTC = at("2026-11-20T12:00:00Z");
const en = createI18n("en");

function Noon() {
  return clockTime(NOON_UTC, { i18n: en, ...useClock() });
}

const noonUnder = (saved: string | null) =>
  renderToStaticMarkup(
    <ClockProvider now={NOON_UTC}>
      <OperatorTimeZone timeZone={saved}>
        <Noon />
      </OperatorTimeZone>
    </ClockProvider>,
  );

describe("the time zone times are shown in", () => {
  // The device's zone, other than the one the operator saved.
  beforeEach(() => {
    vi.stubEnv("TZ", "Asia/Tokyo");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the operator's saved zone, whatever the device's, and the device's until it is read", () => {
    expect(noonUnder("America/New_York")).toBe("7:00\u00A0AM");
    expect(noonUnder(null)).toBe("9:00\u00A0PM");
  });
});
