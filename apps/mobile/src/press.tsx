// SPDX-License-Identifier: AGPL-3.0-or-later
import { press, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { ComponentProps, ComponentPropsWithRef } from "react";
import { Pressable } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotion } from "./motion.ts";

/** How deep a press goes: a control, a round icon button, or a row as wide as a list. */
export type PressDepth = "control" | "round" | "row";

const depths: Record<PressDepth, number> = {
  control: press.scale,
  round: press.roundScale,
  row: press.rowScale,
};

const popBack = reanimatedSpring(springs.pop);

/**
 * A `Pressable` that goes down quickly while pressed and springs back with
 * `pop`, as every pressable control does on the web. Reduced motion keeps it
 * still, and so does a control that is disabled or only marked disabled, as a
 * held one is. `frame` styles the box that scales, which is the one that takes part
 * in the layout (`flexGrow`, a width), and may be driven on the UI thread;
 * `className` styles the pressable inside.
 */
export function PressScale({
  depth = "control",
  frame,
  disabled,
  accessibilityState,
  onPressIn,
  onPressOut,
  ...props
}: ComponentPropsWithRef<typeof Pressable> & {
  readonly depth?: PressDepth;
  readonly frame?: ComponentProps<typeof Animated.View>["style"];
}) {
  const reduced = useReducedMotion();
  const still = reduced || disabled === true || accessibilityState?.disabled === true;
  const scale = useSharedValue(1);
  const scaled = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <Animated.View style={[frame, scaled]}>
      <Pressable
        {...props}
        disabled={disabled}
        accessibilityState={accessibilityState}
        onPressIn={(event) => {
          if (!still) {
            scale.set(withTiming(depths[depth], { duration: press.duration }));
          }
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          scale.set(reduced ? 1 : withSpring(1, popBack));
          onPressOut?.(event);
        }}
      />
    </Animated.View>
  );
}
