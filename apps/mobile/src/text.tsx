// SPDX-License-Identifier: AGPL-3.0-or-later
import { displayTracking, fontFamilies } from "@j3-bots/design-tokens";
import { type ComponentPropsWithRef, createContext, use } from "react";
import { StyleSheet, Text as NativeText, TextInput as NativeTextInput } from "react-native";
import { type Face, faceOf } from "./face.ts";

/**
 * Text and fields in J3 Bots' faces. React Native has no inherited font for a
 * `Text` on its own, so every `Text` and `TextInput` in the app comes from
 * here rather than from `react-native` (a lint rule holds this). The face is a
 * prop, not a class: a `style` the caller gives still wins, as for a size or a
 * color, and the weight follows the class (`font-medium`), since each family
 * is embedded with its weights (app.config.ts). A `Text` nested in another
 * sets no face unless it names one, so it inherits its parent's.
 */
const faces = StyleSheet.create({
  text: { fontFamily: fontFamilies.text },
  // The display face is embedded in bold only.
  display: { fontFamily: fontFamilies.display, fontWeight: "700" },
  mono: { fontFamily: fontFamilies.mono },
});

/** Whether a `Text` lies inside another, whose face it then inherits. */
const InsideText = createContext(false);

export function Text({
  face,
  style,
  ...props
}: ComponentPropsWithRef<typeof NativeText> & { readonly face?: Face }) {
  const own = faceOf(face, use(InsideText));
  return (
    <InsideText value>
      <NativeText {...props} style={own === undefined ? style : [faces[own], style]} />
    </InsideText>
  );
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
