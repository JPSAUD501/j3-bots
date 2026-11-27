// SPDX-License-Identifier: AGPL-3.0-or-later
import { themeChoices, themePalettes } from "@j3-bots/client-runtime/presentation";
import { hexColor } from "@j3-bots/design-tokens";
import type { ThemeId } from "@j3-bots/contracts";
import { Check, Palette } from "lucide-react-native";
import { useColorScheme, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { setThemeId } from "../preferences.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { useShownThemes } from "./ThemeRuntime.tsx";

/**
 * A bot's offer of a theme, under its message (decision 0104): saving a theme
 * never shows it, so the operator applies it here, to this phone. Once it
 * shows, a quiet line says so; a theme deleted since says that instead. Before
 * a saved one's library arrives, it shows nothing.
 */
export function ApplyThemeOffer({
  themeId,
  maxWidth,
}: {
  readonly themeId: ThemeId;
  readonly maxWidth: number;
}) {
  const { t } = useI18n();
  const appearance = useColorScheme() === "dark" ? "dark" : "light";
  const themes = useShownThemes();
  if (themes === null) return null;
  const choice = themeChoices(themes.library).find(({ id }) => id === themeId);
  if (choice === undefined) {
    return themes.known ? (
      <Text style={{ maxWidth }} className="ps-1 text-xs text-muted-foreground">
        {t("message.offer.applyTheme.gone")}
      </Text>
    ) : null;
  }
  if (themes.shown?.id === themeId) {
    return (
      <View style={{ maxWidth }} className="flex-row items-center gap-1.5 ps-1">
        <Icon icon={Check} size={14} color="accent-muted-foreground" />
        <Text className="shrink text-xs text-muted-foreground">
          {t("message.offer.applyTheme.inUse")}
        </Text>
      </View>
    );
  }
  const palette = themePalettes(choice.definition)[appearance];
  return (
    <View className="flex-row">
      <PressScale
        accessibilityRole="button"
        accessibilityLabel={t("message.offer.applyTheme")}
        onPress={() => setThemeId(choice.id)}
        className="min-h-11 flex-row items-center gap-2 rounded-pill border border-input bg-surface px-4"
      >
        <Icon icon={Palette} size={16} color="accent-foreground" />
        <Text className="text-sm font-semibold text-foreground">
          {t("message.offer.applyTheme")}
        </Text>
        {/* The theme's own canvas and accent, so it is seen before it is applied. */}
        <View className="size-4 flex-row overflow-hidden rounded-pill border border-border">
          <View className="flex-1" style={{ backgroundColor: hexColor(palette.background) }} />
          <View className="flex-1" style={{ backgroundColor: hexColor(palette.accent) }} />
        </View>
      </PressScale>
    </View>
  );
}
