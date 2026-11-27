// SPDX-License-Identifier: AGPL-3.0-or-later
import { Lock } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { Text } from "../text.tsx";

/**
 * Where the composer would be, in a conversation the operator reads and
 * writes nothing in: two bots' messages, or a room of bots only. `spoken` is
 * what a screen reader says of it.
 */
export function ReadOnlyMark({
  label,
  spoken,
}: {
  readonly label: string;
  readonly spoken: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={spoken}
      className="flex-row items-center gap-1.5 rounded-pill border border-border bg-surface px-3.5 py-2"
    >
      <Icon icon={Lock} size={14} color="accent-muted-foreground" />
      <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
    </View>
  );
}
