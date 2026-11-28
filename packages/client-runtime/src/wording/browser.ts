// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import type { IntentFailure } from "../intents/Actions.ts";
import type { Frozen, TabLine } from "../presentation/browserTabs.ts";
import type { BrowserRefusal } from "../stores/Browser.ts";

/**
 * Why a new tab did not open, and what the person can do about it, where
 * there is something: no browser can open one now, the server's is full,
 * the page did not load or was refused, or any other failure.
 */
export const tabOpenFailed = (failure: IntentFailure, { t }: I18n): string => {
  if (failure._tag !== "refused" || failure.error._tag !== "Conflict") {
    return t("browser.grid.openFailed");
  }
  switch (failure.error.reason) {
    case "browser-unavailable":
      return t("browser.grid.openUnavailable");
    case "browser-app-only":
      return t("browser.grid.openAppOnly");
    case "browser-full":
      return t("browser.grid.openFull");
    case "browser-page-timeout":
      return t("browser.grid.openTimeout");
    case "browser-page-failed":
      return t("browser.grid.openPageFailed");
    case "browser-address-refused":
      return t("browser.grid.openRefused");
    default:
      return t("browser.grid.openFailed");
  }
};

/**
 * The live view's one quiet line: the tab's own line while the page is
 * live, else why it is frozen. Input the server just refused says it was not
 * sent, and why, in the same line. `computer` names the computer the tab runs
 * on, null when this device does not know its name.
 */
export const liveLine = (
  input: {
    readonly frozen: Frozen;
    readonly line: string;
    readonly refused: BrowserRefusal["reason"] | null;
    readonly computer: string | null;
  },
  { t }: I18n,
): string => {
  const { frozen, line, refused, computer } = input;
  // No connection says it all: a refusal heard before it is stale.
  if (frozen._tag === "you-offline") return t("browser.line.noConnection");
  switch (refused) {
    case "away":
      return computer === null
        ? t("browser.line.notSent.awayUnnamed")
        : t("browser.line.notSent.away", { computer });
    case "parked":
      return t("browser.line.notSent.parked");
    case null:
      break;
  }
  switch (frozen._tag) {
    case "live":
      return line;
    case "reconnecting":
      return t("browser.reconnecting");
    case "parked":
      return t("browser.line.parked");
    case "away":
      return computer === null
        ? t("browser.line.awayUnnamed")
        : t("browser.line.away", { computer });
  }
};

/** The words of a tab's line, and the one thing it offers, if any. */
export interface TabLineWords {
  /** Empty while no bot is on the tab and nothing holds it: there is nothing to say. */
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
