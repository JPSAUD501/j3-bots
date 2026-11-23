// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { View } from "react-native";
import { displaySpacing, Text } from "../text.tsx";

/**
 * Who the details are about, centered as on a profile: the picture, the name
 * in the display face with its badge, quiet lines under it, and the actions
 * on it. Empty lines are left out.
 */
export function Profile(props: {
  readonly picture: ReactNode;
  readonly name: string;
  readonly badge: string | null;
  readonly lines: ReadonlyArray<string>;
  readonly children?: ReactNode;
}) {
  return (
    <View className="items-center px-6 pt-6 pb-2">
      {props.picture}
      <View className="mt-3 max-w-full flex-row items-center gap-2">
        <Text
          accessibilityRole="header"
          face="display"
          numberOfLines={1}
          className="shrink text-2xl text-foreground"
          style={{ letterSpacing: displaySpacing(24) }}
        >
          {props.name}
        </Text>
        {props.badge !== null && (
          <Text className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {props.badge}
          </Text>
        )}
      </View>
      {props.lines
        .filter((line) => line !== "")
        .map((line) => (
          <Text key={line} className="mt-1 text-center text-sm text-muted-foreground">
            {line}
          </Text>
        ))}
      {props.children !== undefined && (
        <View className="mt-4 flex-row flex-wrap justify-center gap-2">{props.children}</View>
      )}
    </View>
  );
}

/** What cannot be undone: last and on its own, below a hairline. */
export function Apart(props: { readonly children: ReactNode }) {
  return (
    <View className="mx-5 mt-8 items-start border-t border-border pt-5">{props.children}</View>
  );
}
