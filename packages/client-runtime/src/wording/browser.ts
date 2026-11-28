// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { type IntentFailure, refusedWith } from "../intents/Actions.ts";
import type { TabLine } from "../presentation/browserTabs.ts";

/**
 * Why a new tab did not open: no browser can open one now, when no J3 Bots
 * app is open on a computer and the server's own cannot run, or any other
 * failure.
 */
export const tabOpenFailed = (failure: IntentFailure, { t }: I18n): string =>
  refusedWith({ _tag: "failed", failure }, "browser-unavailable")
    ? t("browser.grid.openUnavailable")
    : t("browser.grid.openFailed");

/** The words of a tab's line, and the one thing it offers, if any. */
export interface TabLineWords {
  /** Empty while no bot is on the tab: the line's place stays, and nothing else moves. */
  readonly text: string;
  /** Now skips the countdown; Continue ends "Wait for me". */
  readonly action: "now" | "continue" | null;
}

/** The bots' names, as a list in the interface's language: "Ana and Lia". */
export const botNames = (
  bots: ReadonlyArray<BotId>,
  nameOf: (botId: BotId) => string,
  { locale }: I18n,
): string => new Intl.ListFormat(locale, { type: "conjunction" }).format(bots.map(nameOf));

/** What a tab's line says. `nameOf` names a bot by its name, never its title. */
export const tabLineWords = (
  line: TabLine,
  nameOf: (botId: BotId) => string,
  i18n: I18n,
): TabLineWords => {
  const { t, plural } = i18n;
  switch (line._tag) {
    case "empty":
      return { text: "", action: null };
    case "on-it":
      return { text: botNames(line.bots, nameOf, i18n), action: null };
    case "acting":
      return { text: t("browser.line.acting", { name: nameOf(line.acting) }), action: null };
    case "waits-for-you":
      return {
        text: plural("browser.line.waitsForYou", line.bots.length, {
          names: botNames(line.bots, nameOf, i18n),
        }),
        action: null,
      };
    case "back-in":
      return { text: t("browser.line.backIn", { seconds: String(line.seconds) }), action: "now" };
    case "waits-until-continue":
      return {
        text: plural("browser.line.waitsUntilContinue", line.bots.length, {
          names: botNames(line.bots, nameOf, i18n),
        }),
        action: "continue",
      };
    case "elsewhere":
      return { text: t("browser.line.elsewhere"), action: null };
    case "signing-in":
      return { text: t("browser.line.signingIn"), action: null };
  }
};
