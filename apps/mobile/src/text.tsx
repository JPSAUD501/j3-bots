// SPDX-License-Identifier: AGPL-3.0-or-later
import { displayTracking, fontFamilies } from "@j3-bots/design-tokens";
import type { ComponentPropsWithRef } from "react";
import { StyleSheet, Text as NativeText, TextInput as NativeTextInput } from "react-native";

/**
 * Text and fields in J3 Bots' faces. React Native has no inherited font, so
 * every `Text` and `TextInput` in the app comes from here rather than from
 * `react-native`. The face is a prop, not a class: a `style` the caller gives
 * still wins, as for a size or a color, and the weight follows the class
 * (`font-medium`), since each family is embedded with its weights
 * (app.config.ts).
 */
export type Face = keyof typeof fontFamilies;

const faces = StyleSheet.create({
  text: { fontFamily: fontFamilies.text },
  // The display face is embedded in bold only.
  display: { fontFamily: fontFamilies.display, fontWeight: "700" },
  mono: { fontFamily: fontFamilies.mono },
});

export function Text({
  face = "text",
  style,
  ...props
}: ComponentPropsWithRef<typeof NativeText> & { readonly face?: Face }) {
  return <NativeText {...props} style={[faces[face], style]} />;
}

export function TextInput({
  face = "text",
  style,
  ...props
}: ComponentPropsWithRef<typeof NativeTextInput> & { readonly face?: Face }) {
  return <NativeTextInput {...props} style={[faces[face], style]} />;
}

/** The display face's tight letter spacing at a size, in px, as React Native takes it. */
export const displaySpacing = (size: number): number => size * displayTracking;
