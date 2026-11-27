// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot } from "@j3-bots/contracts";
import type { BuiltInThemeId } from "@j3-bots/design-tokens";
import type { I18n } from "@j3-bots/i18n";
import type { ThemeChoice } from "../presentation/themes.ts";

const BUILT_IN_WORDS = {
  palco: { name: "theme.palco.name", description: "theme.palco.description" },
  grafite: { name: "theme.grafite.name", description: "theme.grafite.description" },
  oceano: { name: "theme.oceano.name", description: "theme.oceano.description" },
  floresta: { name: "theme.floresta.name", description: "theme.floresta.description" },
  brasa: { name: "theme.brasa.name", description: "theme.brasa.description" },
  lavanda: { name: "theme.lavanda.name", description: "theme.lavanda.description" },
  papel: { name: "theme.papel.name", description: "theme.papel.description" },
} as const satisfies Record<BuiltInThemeId, unknown>;

/** A theme's name, a built-in's in the interface's language. */
export function themeName(choice: ThemeChoice, { t }: I18n): string {
  return choice.origin._tag === "built-in"
    ? t(BUILT_IN_WORDS[choice.origin.id].name)
    : choice.definition.name;
}

/** What a theme looks like, in a sentence, when it says. */
export function themeDescription(choice: ThemeChoice, { t }: I18n): string | null {
  return choice.origin._tag === "built-in"
    ? t(BUILT_IN_WORDS[choice.origin.id].description)
    : (choice.definition.description ?? null);
}

/** Who made a saved theme: "Made by you", "Made by Scout"; null for a built-in. */
export function themeMakerText(
  choice: ThemeChoice,
  bots: ReadonlyArray<Bot>,
  { t }: I18n,
): string | null {
  const { origin } = choice;
  if (origin._tag === "built-in") return null;
  if (origin._tag === "operator") return t("settings.themes.byYou");
  const bot = bots.find((b) => b.id === origin.botId);
  return bot === undefined
    ? t("settings.themes.byRemovedBot")
    : t("settings.themes.byBot", { name: bot.profile.name });
}
