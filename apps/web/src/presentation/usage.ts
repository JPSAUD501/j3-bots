// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UsageWindow } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import type { I18n, KeyWith } from "../i18n/i18n";
import { timeInSentence, type TimeContext } from "../lib/time";

/** A limit window in words, as of `ctx.now`. */
export interface WindowText {
  readonly name: string;
  /** How much is used, or that the limit is reached. */
  readonly used: string;
  /** Percent used, rounded down, so a window short of its limit never reads as full. */
  readonly percent: number;
  /**
   * `open`: under its limit. `full`: at it, until it resets. `reset`: its
   * reset passed, so `used` is the last figure the engine reported before it.
   */
  readonly tone: "open" | "full" | "reset";
  /** When it resets or reset, when the engine says. */
  readonly reset: string | null;
}

/**
 * The labels the engine gives its windows, as the usage view words them. The
 * engine calls its five-hour window "Session", which is not a J3 Bots
 * session, so that one reads as the five-hour window.
 */
const WINDOW_NAMES: ReadonlyMap<string, KeyWith> = new Map([
  ["Session", "usage.window.session"],
  ["Weekly", "usage.window.weekly"],
  ["Monthly", "usage.window.monthly"],
  ["Monthly spend", "usage.window.monthlySpend"],
  ["Monthly credit limit", "usage.window.monthlyCreditLimit"],
]);

/**
 * A window's label in the interface's language: a known one translated, also
 * before a model's name, as in "Weekly · Claude Opus 5.5"; any other as the
 * engine sends it.
 */
function windowName(label: string, { t }: I18n): string {
  const [kind = label, ...model] = label.split(" · ");
  const key = WINDOW_NAMES.get(kind);
  return key === undefined ? label : [t(key), ...model].join(" · ");
}

/**
 * One window as the usage view words it. A window at its limit says only that
 * the window is: a model's window blocks that model, not the provider. A
 * window keeps its last figures until the engine checks again, also past its
 * reset, so then it says when it reset and that new figures come with the
 * next check.
 */
export function windowText(usageWindow: UsageWindow, ctx: TimeContext): WindowText {
  const { t } = ctx.i18n;
  const percent = Math.floor(usageWindow.usedPercent);
  const resetsAt = usageWindow.resetsAt;
  const reset =
    resetsAt !== null && DateTime.toEpochMillis(resetsAt) <= DateTime.toEpochMillis(ctx.now);
  const tone = reset ? "reset" : usageWindow.usedPercent >= 100 ? "full" : "open";
  const formatted = new Intl.NumberFormat(ctx.i18n.locale, { style: "percent" }).format(
    percent / 100,
  );
  return {
    name: windowName(usageWindow.label, ctx.i18n),
    used: tone === "full" ? t("usage.full") : t("usage.used", { percent: formatted }),
    percent,
    tone,
    reset:
      resetsAt === null
        ? null
        : t(reset ? "usage.reset" : "usage.resets", { when: timeInSentence(resetsAt, ctx) }),
  };
}
