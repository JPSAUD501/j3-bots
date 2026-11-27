// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ThemeChoice, themePalettes } from "@j3-bots/client-runtime/presentation";
import type { ThemeDefinition } from "@j3-bots/contracts";
import { nativeThemeVariables } from "@j3-bots/design-tokens";
import { useMemo } from "react";
import { View } from "react-native";
import { ScopedVariables } from "uniwind";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { ThemeBackdrop } from "./ThemeBackdrop.tsx";

const BUBBLE = { maxWidth: "85%" } as const;

/**
 * A theme drawn small, in `appearance`: a list beside a short exchange and
 * the box to write in, in the theme's own colors whatever the app shows, so
 * themes are told apart by how they look. With `choice`, its picture sits
 * behind the exchange under the same veil as behind a conversation. Screen
 * readers pass over it: what names the theme is beside it.
 */
export function ThemePreview({
  definition,
  appearance,
  choice = null,
  outlined = false,
}: {
  readonly definition: ThemeDefinition;
  readonly appearance: "light" | "dark";
  /** The theme the picture is of, when it is a saved one. */
  readonly choice?: ThemeChoice | null;
  /** Ringed in the accent, as the theme in use is. */
  readonly outlined?: boolean;
}) {
  const { t } = useI18n();
  const variables = useMemo(
    () => nativeThemeVariables(themePalettes(definition)[appearance], appearance),
    [definition, appearance],
  );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={`rounded-lg p-0.5 ${outlined ? "bg-accent" : ""}`}
    >
      <ScopedVariables variables={variables}>
        <View className="h-24 flex-row overflow-hidden rounded-md border border-border bg-background">
          <View className="w-1/4 gap-1 border-e border-border bg-sidebar p-1.5">
            <View className="h-2 rounded-sm bg-row-hover" />
            <View className="h-2 w-3/4 rounded-sm bg-muted" />
            <View className="h-2 w-2/3 rounded-sm bg-muted" />
          </View>
          <View className="min-w-0 flex-1 justify-end gap-1 p-1.5">
            <ThemeBackdrop choice={choice} />
            <View style={BUBBLE} className="self-start rounded-md bg-bubble-bot px-1.5 py-0.5">
              <Text numberOfLines={1} className="text-2xs text-bubble-bot-foreground">
                {t("settings.themes.preview.bot")}
              </Text>
            </View>
            <View style={BUBBLE} className="self-end rounded-md bg-bubble-operator px-1.5 py-0.5">
              <Text numberOfLines={1} className="text-2xs text-bubble-operator-foreground">
                {t("settings.themes.preview.you")}
              </Text>
            </View>
            <View className="h-4 flex-row items-center rounded-md bg-muted px-1">
              <View className="ms-auto size-2 rounded-pill bg-accent" />
            </View>
          </View>
        </View>
      </ScopedVariables>
    </View>
  );
}
