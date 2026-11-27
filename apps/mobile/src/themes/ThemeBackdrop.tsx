// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ThemeChoice, themePalettes } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { ThemeBackground, ThemeDefinition, ThemeId } from "@j3-bots/contracts";
import { pictureVeil } from "@j3-bots/design-tokens";
import { useMemo } from "react";
import { Image, StyleSheet, useColorScheme, View } from "react-native";
import { useImage } from "../platform/images.ts";

/**
 * A theme's picture, filling what it sits in, under a veil of the canvas, as
 * behind a conversation; nothing for a theme without one, or until it has
 * arrived. It is drawn once, never repainted while it shows.
 */
export function ThemeBackdrop({ choice }: { readonly choice: ThemeChoice | null }) {
  if (choice === null || choice.background === null) return null;
  // A new picture is another image: its own fetch, never the last one's.
  return (
    <Picture
      key={`${choice.id}@${choice.background.revision}`}
      id={choice.id}
      definition={choice.definition}
      background={choice.background}
    />
  );
}

function Picture({
  id,
  definition,
  background,
}: {
  readonly id: ThemeId;
  readonly definition: ThemeDefinition;
  readonly background: ThemeBackground;
}) {
  const image = useImage(useJ3Client(), { _tag: "theme", id, background });
  const appearance = useColorScheme() === "dark" ? "dark" : "light";
  // As much of the theme's canvas over the picture as keeps every word on it readable.
  const veil = useMemo(
    () => pictureVeil(themePalettes(definition)[appearance], appearance),
    [definition, appearance],
  );
  if (image._tag !== "shown") return null;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <Image
        source={{ uri: image.uri }}
        resizeMode="cover"
        fadeDuration={0}
        style={StyleSheet.absoluteFill}
      />
      <View className="bg-background" style={[StyleSheet.absoluteFill, { opacity: veil }]} />
    </View>
  );
}
