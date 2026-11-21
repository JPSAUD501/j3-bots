// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

// The few building blocks the first screens share. Each owns its look:
// callers pick a variant, they do not restyle.

/** A whole screen's message, centered: a title and what to do about it. */
export function Centered(props: { readonly children: ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
      {props.children}
    </View>
  );
}

export function Title(props: { readonly children: ReactNode }) {
  return (
    <Text accessibilityRole="header" className="text-center text-xl font-semibold text-foreground">
      {props.children}
    </Text>
  );
}

export function Body(props: { readonly children: ReactNode }) {
  return <Text className="text-center text-base text-muted-foreground">{props.children}</Text>;
}

/** A button at least 44 px tall, the touch target. */
export function Button(props: {
  readonly label: string;
  /** What a screen reader says, when the label alone does not name what it acts on. */
  readonly accessibilityLabel?: string;
  readonly onPress: () => void;
  readonly variant?: "primary" | "plain";
  readonly disabled?: boolean;
}) {
  const primary = props.variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={props.onPress}
      className={`min-h-11 items-center justify-center rounded-md px-4 ${primary ? "bg-accent" : ""} ${props.disabled === true ? "opacity-50" : ""}`}
    >
      <Text
        className={
          primary ? "text-base font-medium text-accent-foreground" : "text-base text-accent"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
