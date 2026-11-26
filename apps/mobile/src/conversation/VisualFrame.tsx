// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readVisualReport,
  visualDocument,
  visualShell,
} from "@j3-bots/client-runtime/presentation";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import { useEffect, useEffectEvent, useMemo } from "react";
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
  readonly onPageFailed: (event: NativeSyntheticEvent<{ readonly cause: string }>) => void;
};

/**
 * Why a visual could not be drawn: its page did it (a load it cannot make, a
 * renderer it took down), and would again; or the system did (no WebView,
 * the renderer reclaimed while out of sight), and a later try may work.
 */
export type VisualFailure = "page" | "system";

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
 * drawn in the isolated view, inside `visualShell`'s sandboxed frame: rebuilt
 * when the theme changes. Of what the page sends, only its height comes out
 * (`readVisualReport`), clamped, and the shell's word that the frame shows
 * something else, which the visual navigated it to: it fails then, as its
 * page's doing. So does a page the document's guard could not watch, which
 * is never drawn.
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
  readonly onFailed: (failure: VisualFailure) => void;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const appearance = useColorScheme() === "dark" ? "dark" : "light";
  const page = useMemo(() => {
    const document = visualDocument(html, appearance);
    return document === null ? null : visualShell(document);
  }, [html, appearance]);
  const refused = page === null;
  const refuse = useEffectEvent(() => onFailed("page"));
  useEffect(() => {
    if (refused) refuse();
  }, [refused]);
  if (NativeVisualView === null || page === null) return null;
  return (
    <NativeVisualView
      document={page}
      interactive={interactive}
      onPageMessage={({ nativeEvent }) => {
        const report = readVisualReport(nativeEvent.data);
        if (report?._tag === "height") onHeight?.(report.height);
        else if (report?._tag === "gone") onFailed("page");
      }}
      onPageLoaded={() => onLoaded?.()}
      onPageFailed={({ nativeEvent }) => onFailed(nativeEvent.cause === "page" ? "page" : "system")}
      style={style}
    />
  );
}
