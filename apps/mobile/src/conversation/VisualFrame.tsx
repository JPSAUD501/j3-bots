// SPDX-License-Identifier: AGPL-3.0-or-later
import { readVisualHeight, visualDocument } from "@j3-bots/client-runtime/presentation";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import { useMemo } from "react";
import {
  type NativeSyntheticEvent,
  type StyleProp,
  useColorScheme,
  type ViewProps,
  type ViewStyle,
} from "react-native";

type NativeVisualProps = ViewProps & {
  readonly document: string;
  readonly interactive: boolean;
  readonly onPageMessage: (event: NativeSyntheticEvent<{ readonly data: string }>) => void;
  readonly onPageLoaded: () => void;
  readonly onPageFailed: () => void;
};

/**
 * The app's own view for a visual (`modules/visual-view`), on Android only.
 * Missing, as on a platform the app does not ship for, a visual says it
 * could not be shown.
 */
const NativeVisualView =
  requireOptionalNativeModule("VisualView") === null
    ? null
    : requireNativeView<NativeVisualProps>("VisualView");

/** Whether this build can draw visuals at all. */
export const canShowVisuals = NativeVisualView !== null;

/**
 * A bot's page, wrapped by `visualDocument` in the app's current theme and
 * drawn in the isolated view: rebuilt when the theme changes. Of what the
 * page sends, only its height comes out (`readVisualHeight`), clamped.
 */
export function VisualFrame({
  html,
  interactive,
  onHeight,
  onLoaded,
  onFailed,
  style,
}: {
  readonly html: string;
  readonly interactive: boolean;
  readonly onHeight?: (height: number) => void;
  readonly onLoaded?: () => void;
  readonly onFailed: () => void;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const appearance = useColorScheme() === "dark" ? "dark" : "light";
  const document = useMemo(() => visualDocument(html, appearance), [html, appearance]);
  if (NativeVisualView === null) return null;
  return (
    <NativeVisualView
      document={document}
      interactive={interactive}
      onPageMessage={({ nativeEvent }) => {
        const height = readVisualHeight(nativeEvent.data);
        if (height !== null) onHeight?.(height);
      }}
      onPageLoaded={() => onLoaded?.()}
      onPageFailed={onFailed}
      style={style}
    />
  );
}
