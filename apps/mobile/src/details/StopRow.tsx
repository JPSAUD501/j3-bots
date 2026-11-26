// SPDX-License-Identifier: AGPL-3.0-or-later
import { Square } from "lucide-react-native";
import { type ComponentRef, useEffect, useRef } from "react";
import { AccessibilityInfo, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";

/**
 * The row that stops the work under way, just under the details' profile and
 * before anything they list. `onPress` null keeps the row in place while the
 * work stops, disabled, taking no press and showing none.
 */
export function StopRow(props: { readonly label: string; readonly onPress: (() => void) | null }) {
  const held = props.onPress === null;
  return (
    <View className="px-3 pt-2">
      <PressScale
        depth="row"
        accessibilityRole="button"
        accessibilityState={{ disabled: held }}
        disabled={held}
        onPress={props.onPress ?? undefined}
        className="min-h-12 flex-row items-center gap-3 rounded-md px-2 active:bg-muted"
      >
        <Icon icon={Square} size={14} color="accent-muted-foreground" filled />
        <Text
          numberOfLines={1}
          className={`min-w-0 flex-1 text-base font-medium ${held ? "text-muted-foreground" : "text-foreground"}`}
        >
          {props.label}
        </Text>
      </PressScale>
    </View>
  );
}

/**
 * Moves a screen reader to the details' heading once the work a Stop pressed
 * here ends and the row goes (`shown` turns false), as the web moves focus:
 * the row it was on is gone. A Stop pressed elsewhere, one the server
 * refused, or work that ends on its own, moves nothing. Give `heading` to the
 * heading, and hand `stopped` the answer to each Stop pressed here: whether
 * the server took it.
 */
export function useFocusAfterStop(shown: boolean) {
  const heading = useRef<ComponentRef<typeof Text>>(null);
  const pressedHere = useRef(false);
  const wasShown = useRef(shown);
  useEffect(() => {
    const gone = wasShown.current && !shown;
    wasShown.current = shown;
    if (!gone) return;
    if (pressedHere.current && heading.current !== null) {
      AccessibilityInfo.sendAccessibilityEvent(heading.current, "focus");
    }
    pressedHere.current = false;
  }, [shown]);
  return {
    heading,
    stopped: (taken: Promise<boolean>) => {
      pressedHere.current = true;
      void taken.then((took) => {
        if (!took) pressedHere.current = false;
      });
    },
  };
}
