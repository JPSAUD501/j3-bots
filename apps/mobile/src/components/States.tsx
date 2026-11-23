// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LucideIcon } from "lucide-react-native";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { appear, useReducedMotion } from "../motion.ts";
import { Icon } from "./Icon.tsx";

/** The quiet mark over an empty or stopped state: an icon on a `muted` disc that arrives in place. */
export function StateMark(props: { readonly icon: LucideIcon }) {
  return (
    <Animated.View
      entering={appear}
      className="size-14 items-center justify-center rounded-pill bg-muted"
    >
      <Icon icon={props.icon} size={24} color="accent-muted-foreground" />
    </Animated.View>
  );
}

/** Three dots that pulse in turn, as on the web: something is under way and will take a moment. */
export function Working() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-center gap-1.5"
    >
      {[0, 1, 2].map((dot) => (
        <Dot key={dot} delay={dot * 160} />
      ))}
    </View>
  );
}

/** One of the dots: up to full in 480 ms, back down in 480, still for 240. Reduced motion keeps it full. */
function Dot(props: { readonly delay: number }) {
  const reduced = useReducedMotion();
  const lit = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      lit.set(1);
      return;
    }
    lit.set(0);
    lit.set(
      withDelay(
        props.delay,
        withRepeat(
          withSequence(
            withTiming(1, { duration: 480 }),
            withTiming(0, { duration: 480 }),
            withTiming(0, { duration: 240 }),
          ),
          -1,
        ),
      ),
    );
    return () => cancelAnimation(lit);
  }, [reduced, lit, props.delay]);
  const pulse = useAnimatedStyle(() => ({
    opacity: 0.3 + 0.7 * lit.get(),
    transform: [{ scale: 0.8 + 0.2 * lit.get() }],
  }));
  return <Animated.View className="size-1.5 rounded-pill bg-muted-foreground" style={pulse} />;
}
