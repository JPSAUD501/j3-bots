// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ThemeChoice } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { ThemeBackground, ThemeId } from "@j3-bots/contracts";
import { Image, StyleSheet, View } from "react-native";
import { useImage } from "../platform/images.ts";

/** How much of the canvas lies over a theme's picture, so what sits on it stays readable. */
const VEIL = 0.84;

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
      background={choice.background}
    />
  );
}

function Picture({
  id,
  background,
}: {
  readonly id: ThemeId;
  readonly background: ThemeBackground;
}) {
  const image = useImage(useJ3Client(), { _tag: "theme", id, background });
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
      <View className="bg-background" style={[StyleSheet.absoluteFill, { opacity: VEIL }]} />
    </View>
  );
}
