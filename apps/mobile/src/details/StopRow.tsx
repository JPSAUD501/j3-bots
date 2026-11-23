// SPDX-License-Identifier: AGPL-3.0-or-later
import { Square } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";

/**
 * The row that stops the work under way, just under the details' profile and
 * before anything they list. `onPress` null keeps the row in place while the
 * work stops, taking no press.
 */
export function StopRow(props: { readonly label: string; readonly onPress: (() => void) | null }) {
  const held = props.onPress === null;
  return (
    <View className="px-3 pt-2">
      <PressScale
        depth="row"
        accessibilityRole="button"
        accessibilityState={{ disabled: held }}
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
