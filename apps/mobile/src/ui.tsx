// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { type ReactNode, useEffect } from "react";
import { I18nManager, Pressable, View } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotion } from "./motion.ts";
import { PressScale } from "./press.tsx";
import { Text, displaySpacing } from "./text.tsx";
import { useColor } from "./theme.ts";

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
    <Text
      accessibilityRole="header"
      face="display"
      className="text-center text-2xl text-foreground"
      style={{ letterSpacing: displaySpacing(24) }}
    >
      {props.children}
    </Text>
  );
}

export function Body(props: { readonly children: ReactNode }) {
  return <Text className="text-center text-base text-muted-foreground">{props.children}</Text>;
}

const buttonLook = {
  /** The one action a screen or card exists for. */
  primary: { box: "bg-accent", text: "text-accent-foreground" },
  /** An action beside the content it acts on, such as Try now. */
  plain: { box: "", text: "text-foreground" },
  /** One of a screen's actions that is not the one it exists for: quiet and filled, as on the web. */
  secondary: { box: "bg-muted", text: "text-foreground" },
  /** One of several actions of the same weight, such as Deny beside Don’t ask again. */
  outline: { box: "border border-input bg-surface", text: "text-foreground" },
  /** An action that says no, such as Dismiss, quieter than the rest. */
  quiet: { box: "", text: "text-muted-foreground" },
  /** An action that cannot be undone, such as Delete. Its callers ask before they act. */
  destructive: { box: "border border-input bg-surface", text: "text-blocked" },
} as const;

/**
 * A pill at least 44 px tall, the touch target, that springs back when let
 * go. A `held` button keeps its place and its focus but takes no press, as
 * while an answer it sent is on its way.
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
  /** Whether what it shows and hides is shown, for a button that does that. */
  readonly expanded?: boolean;
}) {
  const look = buttonLook[props.variant ?? "plain"];
  const disabled = props.disabled === true;
  const held = props.held === true;
  return (
    <PressScale
      frame={props.grow === true ? { flexGrow: 1 } : undefined}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: disabled || held, expanded: props.expanded }}
      disabled={disabled}
      onPress={held ? undefined : props.onPress}
      className={`min-h-11 items-center justify-center rounded-pill px-5 ${look.box} ${disabled || held ? "opacity-50" : ""}`}
    >
      <Text className={`text-base font-semibold ${look.text}`}>{props.label}</Text>
    </PressScale>
  );
}

/** How far the thumb travels: the track's 40 px, less the thumb's 20 and 2 px each side. */
const THUMB_TRAVEL = 16;
/** Lifts the thumb off its track: the `thumb` shadow, which Android's `boxShadow` cannot draw. */
const THUMB_ELEVATION = 2;

const thumbSpring = reanimatedSpring(springs.pop);

/**
 * A setting that is on or off, drawn as the web draws it rather than as the
 * system does: a pill track, `control-on` or `control-off`, with the light
 * thumb inside it, which springs across on `pop` while the track's color
 * changes. Its touch target is 44 px, wider than the track.
 */
export function Switch(props: {
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string | undefined;
  /** Shows the value it holds and takes no change. */
  readonly disabled?: boolean;
}) {
  const reduced = useReducedMotion();
  const on = useColor("accent-control-on");
  const off = useColor("accent-control-off");
  const position = useSharedValue(props.value ? 1 : 0);
  const shade = useSharedValue(props.value ? 1 : 0);
  useEffect(() => {
    const to = props.value ? 1 : 0;
    position.set(reduced ? to : withSpring(to, thumbSpring));
    shade.set(withTiming(to, { duration: motion.state }));
  }, [props.value, reduced, position, shade]);
  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(shade.get(), [0, 1], [off, on]),
  }));
  // A transform is not mirrored with the layout: in a right-to-left language the thumb's end is left.
  const travel = I18nManager.isRTL ? -THUMB_TRAVEL : THUMB_TRAVEL;
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: position.get() * travel }],
  }));
  const disabled = props.disabled === true;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ checked: props.value, disabled }}
      disabled={disabled}
      onPress={() => props.onChange(!props.value)}
      className={`size-11 items-center justify-center ${disabled ? "opacity-50" : ""}`}
    >
      <Animated.View style={track} className="h-6 w-10 justify-center rounded-pill px-0.5">
        <Animated.View
          style={[thumb, { elevation: THUMB_ELEVATION }]}
          className="size-5 rounded-pill bg-control-thumb"
        />
      </Animated.View>
    </Pressable>
  );
}
