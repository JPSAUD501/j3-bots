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

const buttonLook = {
  /** The one action a screen or card exists for. */
  primary: { box: "bg-accent", text: "font-medium text-accent-foreground" },
  plain: { box: "", text: "text-accent" },
  /** One of several actions of the same weight, such as Deny beside Allow for session. */
  outline: { box: "border border-input bg-surface", text: "text-foreground" },
  /** An action that says no, such as Dismiss, quieter than the rest. */
  quiet: { box: "", text: "text-muted-foreground" },
} as const;

/**
 * A button at least 44 px tall, the touch target. A `held` button keeps its
 * place and its focus but takes no press, as while an answer it sent is on
 * its way.
 */
export function Button(props: {
  readonly label: string;
  /** What a screen reader says, when the label alone does not name what it acts on. */
  readonly accessibilityLabel?: string;
  /** What a screen reader says after the name: what pressing it does from then on. */
  readonly accessibilityHint?: string;
  readonly onPress: () => void;
  readonly variant?: keyof typeof buttonLook;
  readonly disabled?: boolean;
  readonly held?: boolean;
  /** Takes its share of a row it shares with other buttons. */
  readonly grow?: boolean;
}) {
  const look = buttonLook[props.variant ?? "plain"];
  const disabled = props.disabled === true;
  const held = props.held === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: disabled || held }}
      disabled={disabled}
      onPress={held ? undefined : props.onPress}
      className={`min-h-11 items-center justify-center rounded-md px-4 ${look.box} ${props.grow === true ? "grow" : ""} ${disabled || held ? "opacity-50" : ""}`}
    >
      <Text className={`text-base ${look.text}`}>{props.label}</Text>
    </Pressable>
  );
}
